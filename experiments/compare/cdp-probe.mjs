#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { articleFragment, buildCorpus, httpbinBase64Url } from './corpus.mjs';

const appPackageJson = process.env.OBSCURA_APP_PACKAGE_JSON ?? '/app/package.json';
const require = createRequire(appPackageJson);
const { chromium } = require('playwright-core');

const DEFAULT_WORKER_BASE = 'http://obscura:9222';
const DEFAULT_CANARY_BASE = 'http://egress-canary:18080';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PAIRS = 10;

function argValue(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function buildHtml({ title, marker, body, script = '' }) {
  const fragment = articleFragment({ title, marker, body });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main id="probe-root">${fragment}</main>${script}</body></html>`;
}

function makeFixture({ name, title, marker, body, script = '', expectedUrl = undefined }) {
  const html = buildHtml({ title, marker, body, script });
  const url = expectedUrl ?? httpbinBase64Url(html);
  return {
    name,
    title,
    marker,
    html,
    htmlSha256: sha256(html),
    url,
  };
}

function buildFixtures(corpus = buildCorpus()) {
  const sharedAlpha = corpus.diagnosticCases[0] ?? { title: 'Compare diagnostic A1', requiredMarkers: ['COMPARE_DIAG_A1'] };
  const sharedBeta = corpus.diagnosticCases[1] ?? { title: 'Compare diagnostic B1', requiredMarkers: ['COMPARE_DIAG_B1'] };
  const delayedAlpha = corpus.diagnosticCases[2] ?? { title: 'Compare diagnostic A2', requiredMarkers: ['COMPARE_DIAG_A2'] };
  const delayedBeta = corpus.diagnosticCases[3] ?? { title: 'Compare diagnostic B2', requiredMarkers: ['COMPARE_DIAG_B2'] };
  const sharedAlphaMarker = sharedAlpha.requiredMarkers?.[0] ?? sharedAlpha.marker;
  const sharedBetaMarker = sharedBeta.requiredMarkers?.[0] ?? sharedBeta.marker;
  const delayedAlphaMarker = delayedAlpha.requiredMarkers?.[0] ?? delayedAlpha.marker;
  const delayedBetaMarker = delayedBeta.requiredMarkers?.[0] ?? delayedBeta.marker;
  return {
    sharedAlpha: makeFixture({
      name: 'shared-alpha',
      title: sharedAlpha.title,
      marker: sharedAlphaMarker,
      body: 'Shared alpha marker for the comparison CDP probe.',
    }),
    sharedBeta: makeFixture({
      name: 'shared-beta',
      title: sharedBeta.title,
      marker: sharedBetaMarker,
      body: 'Shared beta marker for the comparison CDP probe.',
    }),
    delayedAlpha: makeFixture({
      name: 'delayed-alpha',
      title: delayedAlpha.title,
      marker: delayedAlphaMarker,
      body: 'Delayed alpha marker for the comparison CDP probe.',
      script: `<script>setTimeout(()=>{document.getElementById('probe-root').innerHTML=${JSON.stringify(articleFragment({ title: delayedAlpha.title, marker: delayedAlphaMarker, body: 'Delayed alpha marker for the comparison CDP probe.' }))};},150);</script>`,
    }),
    delayedBeta: makeFixture({
      name: 'delayed-beta',
      title: delayedBeta.title,
      marker: delayedBetaMarker,
      body: 'Delayed beta marker for the comparison CDP probe.',
      script: `<script>setTimeout(()=>{document.getElementById('probe-root').innerHTML=${JSON.stringify(articleFragment({ title: delayedBeta.title, marker: delayedBetaMarker, body: 'Delayed beta marker for the comparison CDP probe.' }))};},150);</script>`,
    }),
    security: makeFixture({
      name: 'security',
      title: 'Compare security probe',
      marker: 'COMPARE_SECURITY_MARKER',
      body: 'Security probe marker COMPARE_SECURITY_MARKER.',
    }),
  };
}

let fixtures = buildFixtures();

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function preflightFixture(fixture, timeoutMs) {
  const result = await fetchText(fixture.url, timeoutMs);
  if (!result.ok) throw new Error(`fixture ${fixture.name} returned HTTP ${result.status}`);
  if (!/text\/html/i.test(result.contentType)) throw new Error(`fixture ${fixture.name} content-type was ${result.contentType || '(missing)'}`);
  const actualHash = sha256(result.text);
  if (actualHash !== fixture.htmlSha256) throw new Error(`fixture ${fixture.name} hash mismatch: expected ${fixture.htmlSha256} got ${actualHash}`);
  return { url: fixture.url, htmlSha256: fixture.htmlSha256, contentType: result.contentType };
}

async function connectWorker(workerBase, timeoutMs) {
  const baseUrl = new URL(workerBase);
  const version = await fetchJson(`${baseUrl.origin.replace(/\/$/, '')}/json/version`, timeoutMs);
  const wsUrl = new URL(version.webSocketDebuggerUrl);
  if (wsUrl.hostname === '127.0.0.1' || wsUrl.hostname === 'localhost') {
    wsUrl.hostname = baseUrl.hostname;
    if (baseUrl.port) wsUrl.port = baseUrl.port;
  }
  const browser = await chromium.connectOverCDP(wsUrl.toString(), { timeout: timeoutMs });
  return { browser, version, wsUrl: wsUrl.toString() };
}

async function openBrowser(workerBase, timeoutMs) {
  const { browser, version } = await connectWorker(workerBase, timeoutMs);
  return { browser, version };
}

async function collectPage(page, fixture, timeoutMs) {
  const response = await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await delay(Math.min(250, timeoutMs));
  const title = await page.title();
  const actualUrl = page.url();
  const responseUrl = response?.url?.() ?? actualUrl;
  const headers = response?.headers?.() ?? {};
  const responseBody = response ? await response.text().catch(() => null) : null;
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'), (anchor) => ({ text: (anchor.textContent ?? '').trim(), url: anchor.href })).slice(0, 200));
  return {
    requestedUrl: fixture.url,
    responseUrl,
    actualUrl,
    title,
    status: response?.status?.() ?? null,
    contentType: headers['content-type'] ?? null,
    bodyText,
    bodyTextHash: sha256(bodyText),
    responseTextHash: responseBody === null ? null : sha256(responseBody),
    content: bodyText,
    rawBodyHash: sha256(bodyText),
    links,
    markerSeen: bodyText.includes(fixture.marker),
    partnerSeen: false,
  };
}

function annotateSentinel(sample, ownFixture, partnerFixture, connectionModel) {
  const title = String(sample.title ?? '');
  const actualUrl = String(sample.actualUrl ?? sample.responseUrl ?? sample.requestedUrl ?? '');
  const content = String(sample.bodyText ?? sample.content ?? '');
  const ownSeen = content.includes(ownFixture.marker) && actualUrl === ownFixture.url;
  const partnerSeen = content.includes(partnerFixture.marker) || title === partnerFixture.title || actualUrl === partnerFixture.url;
  return {
    ...sample,
    markerSeen: ownSeen,
    partnerSeen,
    sentinelOracle: {
      kind: connectionModel,
      expectedTitle: ownFixture.title,
      expectedUrl: ownFixture.url,
      forbiddenTitle: partnerFixture.title,
      forbiddenUrl: partnerFixture.url,
      passed: ownSeen && !partnerSeen,
    },
  };
}

async function runShared(workerBase, timeoutMs, pairs = DEFAULT_PAIRS) {
  const { browser, version } = await openBrowser(workerBase, timeoutMs);
  try {
    const results = [];
    for (let index = 0; index < pairs; index += 1) {
      const firstContext = await browser.newContext();
      const secondContext = await browser.newContext();
      try {
        const [firstPage, secondPage] = await Promise.all([firstContext.newPage(), secondContext.newPage()]);
        const [first, second] = await Promise.all([collectPage(firstPage, fixtures.sharedAlpha, timeoutMs), collectPage(secondPage, fixtures.sharedBeta, timeoutMs)]);
        results.push({ pair: index + 1, a: annotateSentinel(first, fixtures.sharedAlpha, fixtures.sharedBeta, 'shared-connection'), b: annotateSentinel(second, fixtures.sharedBeta, fixtures.sharedAlpha, 'shared-connection') });
      } finally {
        await Promise.all([firstContext.close().catch(() => {}), secondContext.close().catch(() => {})]);
      }
    }
    return { version, connectionModel: 'shared-connection', results };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runSeparate(workerBase, timeoutMs, pairs = DEFAULT_PAIRS) {
  const results = [];
  let version = null;
  for (let index = 0; index < pairs; index += 1) {
    const [left, right] = await Promise.all([openBrowser(workerBase, timeoutMs), openBrowser(workerBase, timeoutMs)]);
    version = version ?? left.version;
    try {
      const leftContext = await left.browser.newContext();
      const rightContext = await right.browser.newContext();
      try {
        const [leftPage, rightPage] = await Promise.all([leftContext.newPage(), rightContext.newPage()]);
        const [first, second] = await Promise.all([collectPage(leftPage, fixtures.sharedAlpha, timeoutMs), collectPage(rightPage, fixtures.sharedBeta, timeoutMs)]);
        results.push({ pair: index + 1, a: annotateSentinel(first, fixtures.sharedAlpha, fixtures.sharedBeta, 'separate-connection'), b: annotateSentinel(second, fixtures.sharedBeta, fixtures.sharedAlpha, 'separate-connection') });
      } finally {
        await Promise.all([leftContext.close().catch(() => {}), rightContext.close().catch(() => {})]);
      }
    } finally {
      await left.browser.close().catch(() => {});
      await right.browser.close().catch(() => {});
    }
  }
  return { version, connectionModel: 'separate-connection', results };
}

async function runDisconnect(workerBase, timeoutMs) {
  const { browser, version } = await openBrowser(workerBase, timeoutMs);
  const contextOne = await browser.newContext();
  const contextTwo = await browser.newContext();
  const pageOne = await contextOne.newPage();
  const pageTwo = await contextTwo.newPage();
  const before = await fetchJson(`${workerBase.replace(/\/$/, '')}/json/list`, timeoutMs);
  const [first, second] = await Promise.all([collectPage(pageOne, fixtures.sharedAlpha, timeoutMs), collectPage(pageTwo, fixtures.delayedAlpha, timeoutMs)]);
  if (browser._connection?.close) await browser._connection.close(); else await browser.close().catch(() => {});
  await delay(500);
  const after = await fetchJson(`${workerBase.replace(/\/$/, '')}/json/list`, timeoutMs);
  return {
    version,
    beforeTargets: Array.isArray(before) ? before.length : Array.isArray(before?.targets) ? before.targets.length : 0,
    afterTargets: Array.isArray(after) ? after.length : Array.isArray(after?.targets) ? after.targets.length : 0,
    first: annotateSentinel(first, fixtures.sharedAlpha, fixtures.delayedAlpha, 'disconnect'),
    second: annotateSentinel(second, fixtures.delayedAlpha, fixtures.sharedAlpha, 'disconnect'),
    disconnected: true,
  };
}

async function canaryCounts(canaryBase, timeoutMs) {
  return await fetchJson(`${canaryBase.replace(/\/$/, '')}/counts`, timeoutMs);
}

async function runSecurity(workerBase, canaryBase, timeoutMs) {
  const before = await canaryCounts(canaryBase, timeoutMs);
  const { browser, version } = await openBrowser(workerBase, timeoutMs);
  const context = await browser.newContext();
  const page = await context.newPage();
  const directAttempts = [];
  const canaryRoot = canaryBase.replace(/\/$/, '');
  const securityHtml = buildHtml({
    title: 'Compare security probe',
    marker: 'COMPARE_SECURITY_MARKER',
    body: 'Security probe marker COMPARE_SECURITY_MARKER.',
    script: `<script>const canary=${JSON.stringify(canaryRoot)};const image=new Image();image.src=\`${canaryRoot}/hit/image-probe\`;void fetch(\`${canaryRoot}/hit/fetch-probe\`,{mode:'no-cors',cache:'no-store'}).catch(()=>{});document.body.append(image);</script>`,
  });
  for (const url of ['http://127.0.0.1:18080/hit/loopback', 'http://10.0.0.1/hit/private', 'http://169.254.169.254/hit/metadata', 'http://egress-canary:18080/hit/blocked']) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs / 2 });
      directAttempts.push({ url, blocked: false, finalUrl: page.url() });
    } catch (error) {
      directAttempts.push({ url, blocked: true, name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 240) });
    }
  }
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(securityHtml)}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await delay(1500);
  const after = await canaryCounts(canaryBase, timeoutMs);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  const canaryHits = Math.max((after?.count ?? 0) - (before?.count ?? 0), 0);
  return { version, before, after, directAttempts, canaryHits, canaryTouched: canaryHits > 0 };
}

function summarisePairs(pairs) {
  return pairs.map((pair) => ({
    pair: pair.pair,
    connectionModel: pair.a?.sentinelOracle?.kind ?? pair.b?.sentinelOracle?.kind ?? null,
    a: {
      markerSeen: pair.a.markerSeen,
      partnerSeen: pair.a.partnerSeen,
      status: pair.a.status,
      contentType: pair.a.contentType,
      url: pair.a.requestedUrl,
      responseUrl: pair.a.responseUrl,
      actualUrl: pair.a.actualUrl,
      bodyText: pair.a.bodyText,
      bodyTextHash: pair.a.bodyTextHash,
      rawBodyHash: pair.a.rawBodyHash,
      responseTextHash: pair.a.responseTextHash,
      links: pair.a.links,
      sentinelOracle: pair.a.sentinelOracle,
    },
    b: {
      markerSeen: pair.b.markerSeen,
      partnerSeen: pair.b.partnerSeen,
      status: pair.b.status,
      contentType: pair.b.contentType,
      url: pair.b.requestedUrl,
      responseUrl: pair.b.responseUrl,
      actualUrl: pair.b.actualUrl,
      bodyText: pair.b.bodyText,
      bodyTextHash: pair.b.bodyTextHash,
      rawBodyHash: pair.b.rawBodyHash,
      responseTextHash: pair.b.responseTextHash,
      links: pair.b.links,
      sentinelOracle: pair.b.sentinelOracle,
    },
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argValue(argv, '--mode', 'all');
  const workerBase = argValue(argv, '--worker', DEFAULT_WORKER_BASE);
  const canaryBase = argValue(argv, '--canary', DEFAULT_CANARY_BASE);
  const timeoutMs = Number(argValue(argv, '--timeout-ms', String(DEFAULT_TIMEOUT_MS)));
  const pairs = Number(argValue(argv, '--pairs', String(DEFAULT_PAIRS)));
  const fixtureSource = argValue(argv, '--fixture-source', 'compare');
  const dryRun = hasFlag(argv, '--dry-run');

  fixtures = buildFixtures();

  const output = {
    workerBase,
    canaryBase,
    timeoutMs,
    pairs,
    fixtureSource,
    fixtures: Object.fromEntries(Object.entries(fixtures).map(([key, fixture]) => [key, { name: fixture.name, title: fixture.title, marker: fixture.marker, url: fixture.url, htmlSha256: fixture.htmlSha256 }])),
  };

  for (const fixture of Object.values(fixtures)) {
    output[`${fixture.name}Preflight`] = await preflightFixture(fixture, timeoutMs);
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, ...output }, null, 2));
    return;
  }

  if (mode === 'shared' || mode === 'all') output.shared = summarisePairs((await runShared(workerBase, timeoutMs, pairs)).results);
  if (mode === 'separate' || mode === 'all') output.separate = summarisePairs((await runSeparate(workerBase, timeoutMs, pairs)).results);
  if (mode === 'disconnect' || mode === 'all') output.disconnect = await runDisconnect(workerBase, timeoutMs);
  if (mode === 'security' || mode === 'all') output.security = await runSecurity(workerBase, canaryBase, timeoutMs);

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: String(error?.stack ?? '') }, null, 2));
  process.exitCode = 1;
});
