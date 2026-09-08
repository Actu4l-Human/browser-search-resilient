from __future__ import annotations

import asyncio
import hmac
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, HttpUrl
from scrapling.fetchers import AsyncStealthySession, ProxyRotator

TOKEN = os.getenv("SCRAPLING_TOKEN", "")
PROXY = os.getenv("SCRAPLING_PROXY", "")
BROWSER_TIMEOUT_MS = int(os.getenv("BROWSER_TIMEOUT_MS", "60000"))
BROWSER_SETTLE_MS = int(os.getenv("BROWSER_SETTLE_MS", "0"))
EXTRACTION_TIMEOUT_MS = BROWSER_TIMEOUT_MS + BROWSER_SETTLE_MS + 5_000
MAX_CONCURRENT = 2


class ExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: HttpUrl
    max_characters: int = Field(default=50_000, ge=1_000, le=200_000)
    include_links: bool = True


class ExtractResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success: bool
    url: str
    final_url: str
    title: str = ""
    content: str = ""
    links: list[dict[str, str]] = Field(default_factory=list)
    status_code: int | None = None
    content_type: str | None = None
    error: str | None = None
    timed_out: bool | None = None
    cleanup_unconfirmed: bool | None = None


_SESSION: AsyncStealthySession | None = None
_EXTRACT_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT)


def _require_env(name: str, value: str) -> str:
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _env_int(name: str, default: str, *, minimum: int | None = None, maximum: int | None = None) -> int:
    raw = os.getenv(name, default)
    try:
        value = int(raw)
    except ValueError as exc:  # pragma: no cover - invalid runtime env is a startup failure.
        raise RuntimeError(f"{name} must be an integer") from exc
    if minimum is not None and value < minimum:
        raise RuntimeError(f"{name} must be >= {minimum}")
    if maximum is not None and value > maximum:
        raise RuntimeError(f"{name} must be <= {maximum}")
    return value


def _auth(authorization: str | None) -> None:
    if not hmac.compare_digest(authorization or "", f"Bearer {TOKEN}"):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _error_text(exc: Exception) -> str:
    message = str(exc).strip()
    return f"{exc.__class__.__name__}: {message}" if message else exc.__class__.__name__


def _content_type(headers: Any) -> str | None:
    if not headers:
        return None
    if isinstance(headers, dict):
        value = headers.get("content-type") or headers.get("Content-Type")
        return value if isinstance(value, str) and value else None
    try:
        value = headers.get("content-type") or headers.get("Content-Type")
    except Exception:  # noqa: BLE001 - header access is best-effort metadata only.
        return None
    return value if isinstance(value, str) and value else None


def _trim_content(content: str, max_characters: int) -> str:
    if len(content) <= max_characters:
        return content
    return content[:max_characters]


def _fetch_flags(exc: Exception | None, response: Any | None) -> dict[str, bool]:
    timed_out = False
    cleanup_unconfirmed = False
    if exc is not None:
        timed_out = isinstance(exc, TimeoutError) or isinstance(exc, asyncio.TimeoutError)
        cleanup_unconfirmed = timed_out or isinstance(exc, asyncio.CancelledError)
    if response is not None:
        status = getattr(response, "status", None)
        timed_out = timed_out or status in {408, 504}
        cleanup_unconfirmed = cleanup_unconfirmed or timed_out
    flags: dict[str, bool] = {}
    if timed_out:
        flags["timed_out"] = True
    if cleanup_unconfirmed:
        flags["cleanup_unconfirmed"] = True
    return flags


def _response_payload(
    request: ExtractRequest,
    *,
    snapshot: dict[str, Any],
    response: Any | None,
    success: bool,
    error: str | None,
    exc: Exception | None = None,
    extra_flags: dict[str, bool] | None = None,
) -> ExtractResponse:
    final_url = snapshot.get("final_url") or getattr(response, "final_url", None) or getattr(response, "url", None) or str(request.url)
    title = snapshot.get("title") or ""
    content = _trim_content(snapshot.get("content") or "", request.max_characters)
    links = snapshot.get("links") if request.include_links else []
    status_code = getattr(response, "status", None) if response is not None else None
    headers = getattr(response, "headers", None) if response is not None else None
    content_type = _content_type(headers)
    flags = _fetch_flags(exc, response)
    if extra_flags:
        flags.update(extra_flags)
    return ExtractResponse(
        success=success,
        url=str(request.url),
        final_url=str(final_url),
        title=str(title),
        content=content,
        links=links if isinstance(links, list) else [],
        status_code=status_code if isinstance(status_code, int) else None,
        content_type=content_type,
        error=error,
        **flags,
    )


def _session() -> AsyncStealthySession:
    if _SESSION is None:
        raise RuntimeError("Scrapling session is not ready")
    return _SESSION


async def _capture_snapshot(page: Any, settle_ms: int) -> dict[str, Any]:
    if settle_ms:
        await page.wait_for_timeout(settle_ms)
    return await page.evaluate(
        """
        () => {
          const links = [];
          for (const anchor of Array.from(document.querySelectorAll('a[href]')).slice(0, 200)) {
            try {
              const url = new URL(anchor.href, location.href);
              if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                continue;
              }
              links.push({
                text: (anchor.innerText || anchor.textContent || '').trim(),
                url: url.href,
              });
            } catch {
              continue;
            }
          }

          return {
            final_url: location.href || '',
            title: document.title || '',
            content: document.body ? (document.body.innerText || '') : '',
            links,
          };
        }
        """
    )


async def _fetch_request(request: ExtractRequest, *, timeout_ms: int, settle_ms: int) -> ExtractResponse:
    session = _session()
    snapshot: dict[str, Any] = {
        "final_url": str(request.url),
        "title": "",
        "content": "",
        "links": [],
    }
    response: Any | None = None

    async def page_action(page: Any) -> None:
        snapshot.update(await _capture_snapshot(page, settle_ms))

    try:
        async with asyncio.timeout(timeout_ms / 1000):
            async with _EXTRACT_SEMAPHORE:
                response = await session.fetch(
                    str(request.url),
                    proxy=PROXY,
                    timeout=timeout_ms,
                    wait=0,
                    network_idle=True,
                    load_dom=True,
                    google_search=False,
                    solve_cloudflare=False,
                    page_action=page_action,
                )
    except Exception as exc:  # noqa: BLE001 - the sidecar returns structured failures.
        extra_flags: dict[str, bool] = {}
        try:
            stats = session.get_pool_stats()
        except Exception:
            extra_flags["cleanup_unconfirmed"] = True
        else:
            if int(stats.get("busy_pages", 0) or 0) > 0:
                extra_flags["cleanup_unconfirmed"] = True
        return _response_payload(
            request,
            snapshot=snapshot,
            response=response,
            success=False,
            error=_error_text(exc),
            exc=exc,
            extra_flags=extra_flags or None,
        )

    success = bool(getattr(response, "success", True))
    error = getattr(response, "error_message", None) or getattr(response, "error", None)
    return _response_payload(
        request,
        snapshot=snapshot,
        response=response,
        success=success,
        error=str(error) if error else None,
    )


async def _health_probe(session: AsyncStealthySession) -> None:
    browser = getattr(session, "browser", None)
    if browser is None:
        raise RuntimeError("Scrapling browser is not ready")
    connected = getattr(browser, "is_connected", None)
    if not callable(connected) or not bool(connected()):
        raise RuntimeError("Scrapling browser is not connected")

    context = None
    page = None
    primary_error: Exception | None = None
    try:
        context = await browser.new_context(proxy={"server": PROXY})
        page = await context.new_page()
        snapshot = await page.evaluate(
            """
            () => ({
              title: document.title || '',
              final_url: location.href || '',
              content: document.body ? (document.body.innerText || '') : '',
            })
            """
        )
        if not isinstance(snapshot, dict) or snapshot.get("final_url") != "about:blank":
            raise RuntimeError("about:blank probe failed")
    except Exception as exc:
        primary_error = exc
        raise
    finally:
        cleanup_error: Exception | None = None
        try:
            if page is not None:
                await page.close()
            if context is not None:
                await context.close()
        except Exception as exc:  # noqa: BLE001 - cleanup errors are surfaced explicitly when primary work succeeded.
            cleanup_error = exc
        if cleanup_error is not None and primary_error is None:
            raise RuntimeError(_error_text(cleanup_error)) from cleanup_error


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _SESSION

    _require_env("SCRAPLING_TOKEN", TOKEN)
    _require_env("SCRAPLING_PROXY", PROXY)
    _env_int("BROWSER_TIMEOUT_MS", str(BROWSER_TIMEOUT_MS), minimum=1)
    _env_int("BROWSER_SETTLE_MS", str(BROWSER_SETTLE_MS), minimum=0, maximum=5_000)

    _SESSION = AsyncStealthySession(
        headless=True,
        max_pages=MAX_CONCURRENT,
        proxy_rotator=ProxyRotator([PROXY]),
        solve_cloudflare=False,
        retries=1,
        google_search=False,
        dns_over_https=False,
        block_webrtc=True,
        locale="en-US",
        timezone_id="America/Los_Angeles",
        network_idle=True,
        wait=0,
        timeout=EXTRACTION_TIMEOUT_MS,
        load_dom=True,
    )
    await _SESSION.start()
    try:
        yield
    finally:
        session = _SESSION
        _SESSION = None
        if session is not None:
            await session.close()


app = FastAPI(title="resilient-browser-search Scrapling sidecar", version="0.1.0", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    session = _session()
    try:
        async with asyncio.timeout(6):
            await _health_probe(session)
    except Exception as exc:  # noqa: BLE001 - health should fail closed on any browser issue.
        raise HTTPException(status_code=503, detail=_error_text(exc)) from exc
    return {"status": "ok"}


@app.post("/extract", response_model=ExtractResponse, response_model_exclude_none=True)
async def extract(request: ExtractRequest, authorization: str | None = Header(default=None)) -> ExtractResponse:
    _auth(authorization)
    return await _fetch_request(request, timeout_ms=EXTRACTION_TIMEOUT_MS, settle_ms=BROWSER_SETTLE_MS)
