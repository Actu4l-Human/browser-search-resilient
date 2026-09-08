import { createHash } from 'node:crypto';

export const STACK_PROFILES = ['baseline', 'add-obscura', 'add-scrapling', 'replace-obscura', 'replace-scrapling'];

export const TUNING_GRID = [
  { id: 't10000-s0', browserTimeoutMs: 10_000, browserSettleMs: 0 },
  { id: 't10000-s500', browserTimeoutMs: 10_000, browserSettleMs: 500 },
  { id: 't10000-s1500', browserTimeoutMs: 10_000, browserSettleMs: 1_500 },
  { id: 't20000-s0', browserTimeoutMs: 20_000, browserSettleMs: 0 },
  { id: 't20000-s500', browserTimeoutMs: 20_000, browserSettleMs: 500 },
  { id: 't20000-s1500', browserTimeoutMs: 20_000, browserSettleMs: 1_500 },
];

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function toBase64UrlWithPadding(text) {
  return Buffer.from(String(text ?? ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function httpbinBase64Url(html) {
  return `https://httpbin.org/base64/${toBase64UrlWithPadding(html)}`;
}

export function httpbinRedirectUrl(targetUrl) {
  return `https://httpbin.org/redirect-to?url=${encodeURIComponent(targetUrl)}`;
}

export function articleFragment({ title, marker, body, linkUrl = 'https://example.com/', linkText = 'Example Domain' }) {
  return `<article><h1>${title}</h1><p>${body} The validation marker is ${marker}.</p><a href="${linkUrl}">${linkText}</a></article>`;
}

export function articleHtml({ title, marker, body, linkUrl = 'https://example.com/', linkText = 'Example Domain' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${articleFragment({ title, marker, body, linkUrl, linkText })}</main></body></html>`;
}

function shellHtml({ title, marker, body, delayMs, articleLinkUrl = 'https://example.com/', articleLinkText = 'Example Domain' }) {
  const fragment = articleFragment({ title, marker, body, linkUrl: articleLinkUrl, linkText: articleLinkText });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main id="shell"><p id="status">JavaScript is required.</p></main><script>setTimeout(()=>{document.getElementById('shell').innerHTML=${JSON.stringify(fragment)};},${delayMs});</script></body></html>`;
}

function moduleHtml({ title, marker, body }) {
  const fragment = articleFragment({ title, marker, body });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main id="module-shell"><p id="status">Loading module...</p></main><script type="module">const note=(await import('data:text/javascript,export default ${JSON.stringify(marker)};')).default;document.getElementById('module-shell').innerHTML=${JSON.stringify(fragment)};document.getElementById('module-shell').dataset.marker=note;</script></body></html>`;
}

function staticFixture({ id, title, marker, body, linkText = 'Example Domain', linkUrl = 'https://example.com/' }) {
  const html = articleHtml({ title, marker, body, linkUrl, linkText });
  const url = httpbinBase64Url(html);
  return {
    id,
    kind: 'fixture',
    suite: 'training',
    title,
    expectedTitle: title,
    expectedFinalUrl: url,
    requiredMarkers: [marker],
    forbiddenMarkers: [],
    requiredBodyPhrases: [body],
    requiredLinks: [linkUrl],
    includeLinks: true,
    maxCharacters: 20_000,
    linkUrl,
    fixtureHtml: html,
    fixtureSha256: sha256(html),
    url,
    transport: 'httpbin-base64',
    preflight: true,
  };
}

function shellFixture({ id, suite, title, marker, body, delayMs, linkText = 'Example Domain', linkUrl = 'https://example.com/' }) {
  const html = shellHtml({ title, marker, body, delayMs, articleLinkUrl: linkUrl, articleLinkText: linkText });
  const url = httpbinBase64Url(html);
  return {
    id,
    kind: 'fixture',
    suite,
    title,
    expectedTitle: title,
    expectedFinalUrl: url,
    requiredMarkers: [marker],
    forbiddenMarkers: [],
    requiredBodyPhrases: [body],
    requiredLinks: [linkUrl],
    includeLinks: true,
    maxCharacters: 20_000,
    linkUrl,
    fixtureHtml: html,
    fixtureSha256: sha256(html),
    url,
    transport: 'httpbin-base64',
    preflight: true,
    delayMs,
  };
}

function redirectFixture({ id, title, body, targetCase }) {
  if (!targetCase) throw new Error('redirectFixture requires targetCase');
  const url = httpbinRedirectUrl(targetCase.url);
  return {
    id,
    kind: 'redirect',
    suite: 'heldout',
    title,
    expectedTitle: targetCase.title,
    expectedFinalUrl: targetCase.url,
    requiredMarkers: [...(targetCase.requiredMarkers ?? [])],
    forbiddenMarkers: [...(targetCase.forbiddenMarkers ?? [])],
    requiredBodyPhrases: [...(targetCase.requiredBodyPhrases ?? [body])],
    requiredLinks: [...(targetCase.requiredLinks ?? [])],
    includeLinks: Boolean(targetCase.includeLinks ?? true),
    maxCharacters: targetCase.maxCharacters ?? 20_000,
    linkUrl: targetCase.linkUrl ?? 'https://example.com/',
    fixtureHtml: targetCase.fixtureHtml ?? null,
    fixtureSha256: targetCase.fixtureSha256 ?? null,
    url,
    redirectTarget: targetCase.url,
    transport: 'httpbin-redirect',
    preflight: true,
  };
}

function liveFixture({ id, title, url, expectedTitle, requiredBodyPhrases, requiredLinks }) {
  return {
    id,
    kind: 'live',
    suite: 'heldout',
    title,
    expectedTitle,
    requiredMarkers: [],
    forbiddenMarkers: [],
    requiredBodyPhrases,
    requiredLinks,
    includeLinks: true,
    maxCharacters: 30_000,
    url,
    expectedFinalUrl: url,
    fixtureHtml: null,
    fixtureSha256: null,
    preflight: false,
    manualReviewRequired: true,
  };
}

function diagnosticFixture({ id, title, marker, partnerMarker }) {
  const body = `Diagnostic marker ${marker}.`;
  const html = articleHtml({ title, marker, body });
  const url = httpbinBase64Url(html);
  return {
    id,
    kind: 'diagnostic',
    suite: 'diagnostic',
    title,
    expectedTitle: title,
    expectedFinalUrl: url,
    requiredMarkers: [marker],
    forbiddenMarkers: partnerMarker ? [partnerMarker] : [],
    requiredBodyPhrases: [body],
    requiredLinks: ['https://example.com/'],
    includeLinks: true,
    maxCharacters: 20_000,
    linkUrl: 'https://example.com/',
    fixtureHtml: html,
    fixtureSha256: sha256(html),
    url,
    transport: 'httpbin-base64',
    preflight: true,
    partnerMarker: partnerMarker ?? null,
  };
}

export function buildCorpus() {
  const eligibilityCases = [
    staticFixture({
      id: 'eligibility-static-a1',
      title: 'Eligibility static A1',
      marker: 'ELIGIBILITY_STATIC_A1',
      body: 'Eligibility static A1 is the first public oracle check.',
    }),
    staticFixture({
      id: 'eligibility-static-b1',
      title: 'Eligibility static B1',
      marker: 'ELIGIBILITY_STATIC_B1',
      body: 'Eligibility static B1 is the first paired companion check.',
    }),
    staticFixture({
      id: 'eligibility-static-a2',
      title: 'Eligibility static A2',
      marker: 'ELIGIBILITY_STATIC_A2',
      body: 'Eligibility static A2 is the second public oracle check.',
    }),
    staticFixture({
      id: 'eligibility-static-b2',
      title: 'Eligibility static B2',
      marker: 'ELIGIBILITY_STATIC_B2',
      body: 'Eligibility static B2 is the second paired companion check.',
    }),
  ];

  const trainingCases = [
    staticFixture({
      id: 'train-static',
      title: 'Compare training static',
      marker: 'COMPARE_TRAIN_STATIC',
      body: 'Static oracle. Example link anchors the result.',
    }),
    shellFixture({
      id: 'train-js-300',
      suite: 'training',
      title: 'Compare training js 300',
      marker: 'COMPARE_TRAIN_JS_300',
      body: 'Timer-revealed content. Example link anchors the result.',
      delayMs: 300,
    }),
    shellFixture({
      id: 'train-late-900',
      suite: 'training',
      title: 'Compare training late 900',
      marker: 'COMPARE_TRAIN_LATE_900',
      body: 'Slower timer content. Example link anchors the result.',
      delayMs: 900,
    }),
    {
      id: 'train-example',
      kind: 'live',
      suite: 'training',
      title: 'Example Domain',
      expectedTitle: 'Example Domain',
      requiredMarkers: ['Example Domain'],
      forbiddenMarkers: [],
      requiredBodyPhrases: [
        'This domain is for use in documentation examples without needing permission.',
      ],
      requiredLinks: ['https://iana.org/domains/example'],
      includeLinks: true,
      maxCharacters: 20_000,
      url: 'https://example.com/',
      expectedFinalUrl: 'https://example.com/',
      fixtureHtml: null,
      fixtureSha256: null,
      preflight: false,
      manualReviewRequired: false,
    },
  ];

  const heldoutStatic = staticFixture({
    id: 'heldout-static',
    title: 'Compare heldout static',
    marker: 'COMPARE_HELDOUT_STATIC',
    body: 'Held-out static. Example link anchors the result.',
  });

  const testCases = [
    heldoutStatic,
    shellFixture({
      id: 'heldout-js-700',
      suite: 'heldout',
      title: 'Compare heldout js 700',
      marker: 'COMPARE_HELDOUT_JS_700',
      body: 'Held-out timer content. Example link anchors the result.',
      delayMs: 700,
    }),
    shellFixture({
      id: 'heldout-late-1800',
      suite: 'heldout',
      title: 'Compare heldout late 1800',
      marker: 'COMPARE_HELDOUT_LATE_1800',
      body: 'Held-out slow content. Example link anchors the result.',
      delayMs: 1_800,
    }),
    {
      id: 'heldout-module',
      kind: 'fixture',
      suite: 'heldout',
      title: 'Compare heldout module',
      expectedTitle: 'Compare heldout module',
      requiredMarkers: ['COMPARE_HELDOUT_MODULE'],
      forbiddenMarkers: [],
      requiredBodyPhrases: ['Module-script content. Example link anchors the result.'],
      requiredLinks: ['https://example.com/'],
      includeLinks: true,
      maxCharacters: 20_000,
      linkUrl: 'https://example.com/',
      fixtureHtml: moduleHtml({
        title: 'Compare heldout module',
        marker: 'COMPARE_HELDOUT_MODULE',
        body: 'Module-script content. Example link anchors the result.',
      }),
      fixtureSha256: sha256(moduleHtml({
        title: 'Compare heldout module',
        marker: 'COMPARE_HELDOUT_MODULE',
        body: 'Module-script content. Example link anchors the result.',
      })),
      url: httpbinBase64Url(moduleHtml({
        title: 'Compare heldout module',
        marker: 'COMPARE_HELDOUT_MODULE',
        body: 'Module-script content. Example link anchors the result.',
      })),
      expectedFinalUrl: httpbinBase64Url(moduleHtml({
        title: 'Compare heldout module',
        marker: 'COMPARE_HELDOUT_MODULE',
        body: 'Module-script content. Example link anchors the result.',
      })),
      transport: 'httpbin-base64',
      preflight: true,
    },
    redirectFixture({
      id: 'heldout-redirect',
      title: 'Compare heldout redirect',
      body: 'The redirect case resolves to the held-out static payload and preserves the final URL.',
      targetCase: heldoutStatic,
    }),
    liveFixture({
      id: 'live-hn',
      title: 'Hacker News',
      url: 'https://news.ycombinator.com/',
      expectedTitle: 'Hacker News',
      requiredBodyPhrases: ['Hacker News'],
      requiredLinks: ['https://news.ycombinator.com/'],
    }),
    liveFixture({
      id: 'live-wikipedia-web-scraping',
      title: 'Web scraping',
      url: 'https://en.wikipedia.org/wiki/Web_scraping',
      expectedTitle: 'Web scraping',
      requiredBodyPhrases: ['web scraping'],
      requiredLinks: ['https://en.wikipedia.org/wiki/Web_scraping'],
    }),
    liveFixture({
      id: 'live-mdn-fetch-api',
      title: 'Fetch API',
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
      expectedTitle: 'Fetch API',
      requiredBodyPhrases: ['Fetch API'],
      requiredLinks: ['https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'],
    }),
  ];

  const diagnosticCases = [
    diagnosticFixture({
      id: 'diag-a1',
      title: 'Compare diagnostic A1',
      marker: 'COMPARE_DIAG_A1',
      partnerMarker: 'COMPARE_DIAG_B1',
    }),
    diagnosticFixture({
      id: 'diag-b1',
      title: 'Compare diagnostic B1',
      marker: 'COMPARE_DIAG_B1',
      partnerMarker: 'COMPARE_DIAG_A1',
    }),
    diagnosticFixture({
      id: 'diag-a2',
      title: 'Compare diagnostic A2',
      marker: 'COMPARE_DIAG_A2',
      partnerMarker: 'COMPARE_DIAG_B2',
    }),
    diagnosticFixture({
      id: 'diag-b2',
      title: 'Compare diagnostic B2',
      marker: 'COMPARE_DIAG_B2',
      partnerMarker: 'COMPARE_DIAG_A2',
    }),
  ];

  return {
    stackProfiles: [...STACK_PROFILES],
    tuningGrid: [...TUNING_GRID],
    eligibilityCases,
    trainingCases,
    testCases,
    diagnosticCases,
    byId: new Map([...eligibilityCases, ...trainingCases, ...testCases, ...diagnosticCases].map((entry) => [entry.id, entry])),
  };
}
