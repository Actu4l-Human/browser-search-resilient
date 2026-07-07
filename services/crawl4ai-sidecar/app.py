from __future__ import annotations

import asyncio
import hmac
import os
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, HttpUrl

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.content_filter_strategy import BM25ContentFilter, PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

TOKEN = os.getenv("CRAWL4AI_TOKEN", "")
PROXY = os.getenv("CRAWL4AI_PROXY", "")
USER_AGENT = os.getenv(
    "CRAWL4AI_USER_AGENT",
    "Mozilla/5.0 (compatible; ResilientBrowserSearch/0.2; +https://github.com/actual-human)",
)
PAGE_TIMEOUT_MS = int(os.getenv("CRAWL4AI_PAGE_TIMEOUT_MS", "45000"))
PRUNE_THRESHOLD = float(os.getenv("CRAWL4AI_PRUNE_THRESHOLD", "0.48"))
BM25_THRESHOLD = float(os.getenv("CRAWL4AI_BM25_THRESHOLD", "1.0"))
MAX_SCROLL_STEPS = int(os.getenv("CRAWL4AI_MAX_SCROLL_STEPS", "3"))
SCAN_FULL_PAGE = os.getenv("CRAWL4AI_SCAN_FULL_PAGE", "false").lower() in {"1", "true", "yes", "on"}
# Cap concurrent extractions sharing the single long-lived browser below.
MAX_CONCURRENT = max(1, int(os.getenv("CRAWL4AI_MAX_CONCURRENT", "2")))

# A single long-lived browser is far cheaper than launching Chromium per request.
# The browser is started in the lifespan handler below so that a launch failure
# fails startup (and therefore the container healthcheck) instead of every
# /extract call. Only the per-request CrawlerRunConfig is rebuilt per call.
BROWSER_CONFIG = BrowserConfig(
    browser_type="chromium",
    headless=True,
    verbose=False,
    user_agent=USER_AGENT,
    text_mode=True,
    light_mode=True,
    java_script_enabled=True,
    proxy=PROXY or None,
)
CRAWLER = AsyncWebCrawler(config=BROWSER_CONFIG)
_EXTRACT_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await CRAWLER.start()
    try:
        yield
    finally:
        await CRAWLER.close()


app = FastAPI(title="resilient-browser-search Crawl4AI sidecar", version="0.2.1", lifespan=lifespan)


class ExtractRequest(BaseModel):
    url: HttpUrl
    max_characters: int = Field(default=50_000, ge=1_000, le=200_000)
    include_links: bool = True
    query: str | None = Field(default=None, min_length=1, max_length=2_000)
    content_filter: Literal["auto", "none", "prune", "bm25"] = "auto"


class ExtractResponse(BaseModel):
    success: bool
    url: str
    final_url: str
    title: str = ""
    markdown: str = ""
    links: Any = None
    status_code: int | None = None
    content_filter: str = "none"
    error: str | None = None


def _auth(authorization: str | None) -> None:
    # Fail closed: when no token is configured, refuse every /extract request
    # rather than allowing unauthenticated access to an SSRF-capable endpoint.
    if not TOKEN:
        raise HTTPException(status_code=401, detail="CRAWL4AI_TOKEN not configured")
    if not hmac.compare_digest(authorization or "", f"Bearer {TOKEN}"):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _truncate(value: str, max_characters: int) -> str:
    if len(value) <= max_characters:
        return value
    return f"{value[:max_characters]}\n\n[truncated]"


def _selected_markdown(markdown: Any) -> str:
    # Prefer the fit/filtered markdown, then raw, then the markdown object itself.
    fit = getattr(markdown, "fit_markdown", "") or ""
    if fit:
        return str(fit)
    raw = getattr(markdown, "raw_markdown", "") or ""
    if raw:
        return str(raw)
    if isinstance(markdown, str):
        return markdown
    return str(markdown or "")


def _title(result: Any) -> str:
    metadata = getattr(result, "metadata", None)
    if isinstance(metadata, dict):
        value = metadata.get("title") or metadata.get("og:title")
        if isinstance(value, str):
            return value
    value = getattr(result, "title", "")
    return value if isinstance(value, str) else ""


def _status_code(result: Any) -> int | None:
    for name in ("status_code", "status", "response_status"):
        value = getattr(result, name, None)
        if isinstance(value, int):
            return value
    return None


def _generator(mode: str, query: str | None) -> tuple[DefaultMarkdownGenerator | None, str]:
    selected = "bm25" if mode == "auto" and query else "prune" if mode == "auto" else mode
    if selected == "bm25" and query:
        return DefaultMarkdownGenerator(content_filter=BM25ContentFilter(user_query=query, bm25_threshold=BM25_THRESHOLD)), selected
    if selected == "prune":
        return DefaultMarkdownGenerator(
            content_filter=PruningContentFilter(
                threshold=PRUNE_THRESHOLD,
                threshold_type="dynamic",
                min_word_threshold=5,
            )
        ), selected
    return None, "none"


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    # Verify the pooled browser is actually connected, not just that uvicorn is
    # up. If the browser dies after startup this returns 503 so the container
    # HEALTHCHECK can trigger a self-healing restart instead of silently routing
    # extraction traffic to a sidecar with a dead browser.
    manager = getattr(getattr(CRAWLER, "crawler_strategy", None), "browser_manager", None)
    browser = getattr(manager, "browser", None)
    connected = False
    if browser is not None:
        try:
            connected = bool(browser.is_connected())
        except Exception:  # noqa: BLE001 - any probe failure means unhealthy.
            connected = False
    if not connected:
        raise HTTPException(status_code=503, detail="browser not connected")
    return {"status": "ok"}


@app.post("/extract", response_model=ExtractResponse)
async def extract(request: ExtractRequest, authorization: str | None = Header(default=None)) -> ExtractResponse:
    _auth(authorization)
    markdown_generator, filter_name = _generator(request.content_filter, request.query)
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        page_timeout=PAGE_TIMEOUT_MS,
        markdown_generator=markdown_generator,
        flatten_shadow_dom=True,
        process_iframes=True,
        remove_overlay_elements=True,
        remove_forms=True,
        scan_full_page=SCAN_FULL_PAGE,
        max_scroll_steps=MAX_SCROLL_STEPS,
        exclude_external_images=True,
        exclude_all_images=True,
    )

    try:
        async with _EXTRACT_SEMAPHORE:
            result = await CRAWLER.arun(url=str(request.url), config=run_config)
    except Exception as exc:  # noqa: BLE001 - sidecar returns errors to trusted orchestrator only.
        return ExtractResponse(success=False, url=str(request.url), final_url=str(request.url), error=str(exc), content_filter=filter_name)

    markdown = _selected_markdown(getattr(result, "markdown", ""))
    selected = _truncate(markdown, request.max_characters)
    final_url = getattr(result, "url", None) or getattr(result, "final_url", None) or str(request.url)
    success = bool(getattr(result, "success", bool(selected)))
    error = getattr(result, "error_message", None) or getattr(result, "error", None)

    return ExtractResponse(
        success=success,
        url=str(request.url),
        final_url=str(final_url),
        title=_title(result),
        markdown=selected,
        links=getattr(result, "links", None) if request.include_links else None,
        status_code=_status_code(result),
        content_filter=filter_name,
        error=str(error) if error else None,
    )
