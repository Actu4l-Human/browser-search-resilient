import { createHash } from 'node:crypto';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function base64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function httpbinBase64Url(html) {
  return `https://httpbin.org/base64/${base64url(html)}`;
}

function encodeRedirectTarget(url) {
  return `https://httpbin.org/redirect-to?url=${encodeURIComponent(url)}`;
}

function articleHtml({ title, marker, body, footer = '' }) {
  const link = '<a href="https://example.com/">RBS link</a>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
</head>
<body>
  <main>
    <article>
      <h1>${title}</h1>
      <p>${body}</p>
      <p>${marker} ${body}</p>
      <p>${body} ${body}</p>
      <p>${link}</p>
      ${footer}
    </article>
  </main>
</body>
</html>`;
}

function longShellText(prefix) {
  return `${prefix} This shell is deliberately verbose and harmless. It exists to exercise the bounded extraction path without advertising an article marker up front. The text is stable, public, and long enough to exceed two hundred characters while remaining plain navigation copy for the delayed render cases. The collector should preserve the bounded shell text until the scripted replacement happens.`;
}

function staticHtml() {
  return articleHtml({
    title: 'RBS static',
    marker: 'RBS_STATIC',
    body:
      'RBS static keeps the baseline deterministic. The copy is plain, public, and stable so browser extraction can be compared without search drift, changing DOM structure, or unrelated network dependencies.',
  });
}

function jsShellHtml() {
  const article = articleHtml({
    title: 'RBS JS shell',
    marker: 'RBS_JS',
    body:
      'RBS JS waits for a short timer before replacing the notice with article content. The test ensures that a JavaScript-only shell becomes usable without depending on a static article being present at first paint.',
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>RBS JS shell</title>
</head>
<body>
  <main>
    <p id="notice">JavaScript is required</p>
    <script>
      setTimeout(() => {
        document.body.innerHTML = ${JSON.stringify(article)};
      }, 150);
    </script>
  </main>
</body>
</html>`;
}

function lateArticleHtml() {
  const article = articleHtml({
    title: 'RBS late article',
    marker: 'RBS_LATE',
    body:
      'RBS late waits much longer before inserting the final article. The shell stays benign for a while so adapters do not confuse the initial navigation text with the eventual content replacement.',
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>RBS late article</title>
</head>
<body>
  <main>
    <p>${longShellText('RBS late article shell.')}</p>
    <p>${longShellText('RBS late article shell continuation.')}</p>
    <script>
      setTimeout(() => {
        document.body.innerHTML = ${JSON.stringify(article)};
      }, 1500);
    </script>
  </main>
</body>
</html>`;
}

function moduleHtml() {
  const article = articleHtml({
    title: 'RBS module',
    marker: 'RBS_MODULE',
    body:
      'RBS module imports a tiny data URL module and then swaps the page content in response. The point is to exercise module-script loading rather than classic script execution.',
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>RBS module</title>
</head>
<body>
  <main>
    <p id="status">Loading module...</p>
    <script type="module">
      const marker = (await import('data:text/javascript,export default "RBS_MODULE";')).default;
      document.body.innerHTML = ${JSON.stringify(article)};
      document.body.dataset.marker = marker;
    </script>
  </main>
</body>
</html>`;
}

function humanGateHtml() {
  return articleHtml({
    title: 'RBS human gate',
    marker: 'Verify you are human',
    body:
      'Verify you are human before continuing. This harmless gate copy is intentionally article-sized so challenge detection can classify the page without trying to treat it as normal useful content.',
    footer: '<p>Access is temporarily gated by a public verification message.</p>',
  });
}

function buildFixture(caseDef) {
  if (caseDef.kind === 'live') {
    return {
      ...caseDef,
      expectedUrl: caseDef.expectedUrl ?? caseDef.url,
    };
  }

  const html = caseDef.kind === 'redirect' ? caseDef.targetHtmlFactory() : caseDef.htmlFactory();
  const fixtureUrl = httpbinBase64Url(html);
  const url = caseDef.kind === 'redirect' ? encodeRedirectTarget(fixtureUrl) : fixtureUrl;
  return {
    ...caseDef,
    url,
    expectedUrl: caseDef.kind === 'redirect' ? fixtureUrl : fixtureUrl,
    fixtureHtml: html,
    fixtureSha256: sha256(html),
    contentType: 'text/html',
    transport: caseDef.kind === 'redirect' ? 'httpbin-redirect' : 'httpbin-base64',
  };
}

const baseCorpus = [
  {
    name: 'static',
    kind: 'fixture',
    title: 'RBS static',
    expectedTitle: 'RBS static',
    markers: ['RBS_STATIC'],
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'article' },
    htmlFactory: staticHtml,
  },
  {
    name: 'js-shell',
    kind: 'fixture',
    title: 'RBS JS shell',
    expectedTitle: 'RBS JS shell',
    markers: ['RBS_JS'],
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'article', delayMs: 150 },
    timingMs: 150,
    htmlFactory: jsShellHtml,
  },
  {
    name: 'late-article',
    kind: 'fixture',
    title: 'RBS late article',
    expectedTitle: 'RBS late article',
    markers: ['RBS_LATE'],
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'article', delayMs: 1500 },
    timingMs: 1500,
    htmlFactory: lateArticleHtml,
  },
  {
    name: 'module',
    kind: 'fixture',
    title: 'RBS module',
    expectedTitle: 'RBS module',
    markers: ['RBS_MODULE'],
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'article', requiresModule: true },
    htmlFactory: moduleHtml,
  },
  {
    name: 'human-gate',
    kind: 'fixture',
    title: 'RBS human gate',
    expectedTitle: 'RBS human gate',
    markers: ['Verify you are human'],
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'human-gate', phrase: 'Verify you are human' },
    htmlFactory: humanGateHtml,
  },
  {
    name: 'redirect',
    kind: 'redirect',
    title: 'RBS static',
    expectedTitle: 'RBS static',
    markers: ['RBS_STATIC'],
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'redirect', targetName: 'static' },
    targetHtmlFactory: staticHtml,
  },
  {
    name: 'live-example',
    kind: 'live',
    title: 'Example Domain',
    expectedTitle: 'Example Domain',
    url: 'https://example.com/',
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'live', minLinks: 1 },
  },
  {
    name: 'live-hn',
    kind: 'live',
    title: 'Hacker News',
    expectedTitle: 'Hacker News',
    url: 'https://news.ycombinator.com/',
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'live', minLinks: 1 },
  },
  {
    name: 'live-wiki',
    kind: 'live',
    title: 'Web scraping',
    expectedTitle: 'Web scraping',
    url: 'https://en.wikipedia.org/wiki/Web_scraping',
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'live', minLinks: 1 },
  },
  {
    name: 'live-mdn',
    kind: 'live',
    title: 'Fetch API',
    expectedTitle: 'Fetch API',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    includeLinks: true,
    maxCharacters: 20000,
    oracle: { kind: 'live', minLinks: 1 },
  },
];

export const corpus = baseCorpus.map(buildFixture);
export { buildFixture };

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(corpus, null, 2));
}
