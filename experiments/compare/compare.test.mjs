import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCorpus, STACK_PROFILES } from './corpus.mjs';
import { requiredBackendsForProfile, requiredServicesForProfile, resourceEnvelope, composeForProfile, diagnosticTrackCaps, diagnosticComposeForBackend } from './deploy.mjs';
import { evidenceRow, sha256 } from './evidence.mjs';
import { aggregateRows, prepareRun, reportRun, selectConfig, planRounds, runFetchCase, diagnosticTrackSpecs } from './run.mjs';
import { scoreResponse } from './score.mjs';

const corpus = buildCorpus();
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function tempRunDir() {
  return mkdtemp(join(tmpdir(), 'compare-harness-'));
}

function sampleRequestRow({
  caseId,
  elapsedMs = 100,
  usefulContent = true,
  passed = true,
  falseSuccess = false,
  timedOut = false,
  cleanupUnconfirmed = false,
  rawHttpText = 'raw-response',
  attempts = undefined,
  sampledMemoryMiB = undefined,
  sampledCpuMilli = undefined,
  response = {
    status: 'success',
    result: {
      title: 'Compare training static',
      finalUrl: 'https://example.com/',
      content: 'Compare training static Static oracle. Example link anchors the result. COMPARE_TRAIN_STATIC',
      links: [{ text: 'Example Domain', url: 'https://example.com/' }],
      outcome: 'success',
    },
  },
} = {}) {
  const row = {
    ...evidenceRow({
      runId: 'run-1',
      profile: 'baseline',
      suite: 'heldout',
      caseId,
      configId: 't20000-s0',
      phase: 'measure',
      trialId: `${caseId}:trial`,
      repetition: 1,
      round: 1,
      startedUtc: '2026-09-07T00:00:00.000Z',
      completedUtc: '2026-09-07T00:00:00.100Z',
      elapsedMs,
      availability: 'available',
      scored: true,
      expected: { title: 'Compare training static', finalUrl: 'https://example.com/' },
      response,
      rawHttpText,
      rawHttpStatus: 200,
      sampledMemoryMiB,
      sampledCpuMilli,
    }),
    usefulContent,
    passed,
    falseSuccess,
    timedOut,
    cleanupUnconfirmed,
  };
  if (attempts !== undefined) row.attempts = attempts;
  return row;
}

const fixtureResponse = {
  status: 'success',
  result: {
    title: 'Compare training static',
    finalUrl: corpus.byId.get('train-static')?.url ?? corpus.trainingCases[0].url,
    content: 'Compare training static Static oracle. Example link anchors the result. COMPARE_TRAIN_STATIC',
    links: [{ text: 'Example Domain', url: 'https://example.com/' }],
    outcome: 'success',
  },
};

test('compare corpus exposes the five approved profiles and eligibility fixtures', () => {
  assert.deepEqual(STACK_PROFILES, ['baseline', 'add-obscura', 'add-scrapling', 'replace-obscura', 'replace-scrapling']);
  assert.equal(corpus.eligibilityCases.length, 4);
  assert.equal(corpus.trainingCases.length, 4);
  assert.equal(corpus.testCases.length, 8);
});

test('compare corpus keeps the live example and redirect fixture contracts aligned', () => {
  const example = corpus.trainingCases.find((entry) => entry.id === 'train-example');
  const redirect = corpus.testCases.find((entry) => entry.id === 'heldout-redirect');
  const heldoutStatic = corpus.testCases.find((entry) => entry.id === 'heldout-static');
  assert.ok(example);
  assert.ok(redirect);
  assert.ok(heldoutStatic);
  assert.deepEqual(example.requiredBodyPhrases, [
    'This domain is for use in documentation examples without needing permission.',
  ]);
  assert.deepEqual(example.requiredLinks, ['https://iana.org/domains/example']);
  assert.equal(redirect.fixtureHtml, heldoutStatic.fixtureHtml);
  assert.equal(redirect.fixtureSha256, heldoutStatic.fixtureSha256);
  assert.equal(redirect.expectedFinalUrl, heldoutStatic.url);
});

test('resource envelopes sum to the fixed 4 CPU / 8 GiB budget', () => {
  const envelope = resourceEnvelope('baseline');
  assert.equal(envelope.total.cpuMilli, 4000);
  assert.equal(envelope.total.memoryMiB, 8192);
  assert.equal(envelope.sumPerformance.cpuMilli, 4000);
  assert.equal(envelope.sumPerformance.memoryMiB, 8192);
  assert.equal(envelope.performance['egress-proxy'].cpuMilli, 250);
  assert.equal(envelope.performance.searxng.memoryMiB, 256);
});

test('profile backend and service chains are explicit and ordered', () => {
  assert.deepEqual(requiredBackendsForProfile('replace-scrapling'), ['direct', 'crawl4ai', 'scrapling']);
  assert.deepEqual(requiredServicesForProfile('add-obscura'), ['browser-search', 'egress-proxy', 'searxng', 'crawl4ai', 'camofox', 'obscura', 'egress-canary']);
});

test('diagnostic tracks cover four explicit engine targets with caps', () => {
  assert.deepEqual(
    diagnosticTrackSpecs().map((entry) => [entry.profile, entry.backend, entry.track]),
    [
      ['baseline', 'camofox', 'engine-camofox'],
      ['baseline', 'cloakbrowser', 'engine-cloakbrowser'],
      ['replace-obscura', 'obscura', 'engine-obscura'],
      ['replace-scrapling', 'scrapling', 'engine-scrapling'],
    ],
  );
  assert.deepEqual(diagnosticTrackCaps('camofox').proxy, { cpuMilli: 250, memoryMiB: 256 });
  assert.equal(diagnosticTrackCaps('cloakbrowser').engine, null);
  assert.deepEqual(diagnosticTrackCaps('obscura').engine, { cpuMilli: 1500, memoryMiB: 1536 });
});

test('diagnostic compose uses only app proxy selected engine and canary', () => {
  const template = {
    services: {
      'browser-search': { build: { context: '.', dockerfile: 'Dockerfile' }, image: 'app:local', environment: {}, networks: { 'camofox-control': {}, 'obscura-control': {}, 'scrapling-control': {}, 'canary-control': {}, internet: {} } },
      'egress-proxy': { image: 'proxy:local', networks: { 'camofox-control': {}, 'obscura-control': {}, 'scrapling-control': {}, 'canary-control': {}, internet: {} } },
      camofox: { image: 'camo:local', networks: { 'camofox-control': {} } },
      obscura: { image: 'obscura:local', networks: { 'obscura-control': {} } },
      scrapling: { image: 'scrapling:local', networks: { 'scrapling-control': {} } },
      'egress-canary': { image: 'canary:local', networks: { 'canary-control': {} } },
    },
    networks: {
      'camofox-control': { driver: 'bridge' },
      'obscura-control': { driver: 'bridge' },
      'scrapling-control': { driver: 'bridge' },
      'canary-control': { driver: 'bridge' },
      internet: { driver: 'bridge' },
    },
  };

  const diag = diagnosticComposeForBackend(template, 'replace-obscura', 'obscura', { browserTimeoutMs: 10000, browserSettleMs: 500, browserSearchPort: 18101 }, {}, '', 'run-id');
  assert.deepEqual(Object.keys(diag.services).sort(), ['browser-search', 'egress-canary', 'egress-proxy', 'obscura']);
  assert.equal(diag.services['browser-search'].environment.OBSCURA_ENABLED, 'true');
  assert.equal(diag.services['browser-search'].environment.CAMOFOX_ENABLED, 'false');
  assert.deepEqual(diag.services.obscura.cpus, 1.5);
  assert.equal(diag.services['egress-proxy'].mem_limit, '256m');
});



test('compose profiles drop inactive services and keep profile env selection', () => {
  const template = {
    services: {
      'browser-search': { build: { context: '.', dockerfile: 'Dockerfile' }, image: 'app:local', environment: { EXISTING: '1' }, networks: { 'searxng-control': {}, 'crawl4ai-control': {}, 'camofox-control': {}, 'obscura-control': {}, 'scrapling-control': {}, internet: {} } },
      'egress-proxy': { image: 'proxy:local', networks: { 'crawl4ai-control': {}, 'camofox-control': {}, 'obscura-control': {}, 'scrapling-control': {}, internet: {} } },
      searxng: { image: 'search:local', networks: { 'searxng-control': {}, internet: {} } },
      crawl4ai: { image: 'crawl:local', networks: { 'crawl4ai-control': {} } },
      camofox: { image: 'camo:local', networks: { 'camofox-control': {} } },
      obscura: { image: 'obscura:local', environment: { OBSCURA_ALLOW_PRIVATE_NETWORK: '1' }, networks: { 'obscura-control': {} } },
      scrapling: { build: { context: '.', dockerfile: 'Dockerfile.scrapling' }, image: 'scrapling:local', networks: { 'scrapling-control': {} } },
      'egress-canary': { image: 'canary:local', networks: { 'canary-control': {} } },
    },
    networks: {
      'searxng-control': { driver: 'bridge' },
      'crawl4ai-control': { driver: 'bridge' },
      'camofox-control': { driver: 'bridge' },
      'obscura-control': { driver: 'bridge' },
      'scrapling-control': { driver: 'bridge' },
      'canary-control': { driver: 'bridge' },
      internet: { driver: 'bridge' },
    },
  };
  const profile = composeForProfile(template, 'replace-scrapling', { browserTimeoutMs: 10000, browserSettleMs: 500 });
  const profileWithImages = composeForProfile(template, 'replace-scrapling', { browserTimeoutMs: 10000, browserSettleMs: 500 }, { 'browser-search': 'sha256:111', scrapling: 'sha256:222' });
  const addObscura = composeForProfile(template, 'add-obscura', { browserTimeoutMs: 10000, browserSettleMs: 0 });
  assert.deepEqual(Object.keys(profileWithImages.services).sort(), ['browser-search', 'crawl4ai', 'egress-canary', 'egress-proxy', 'scrapling', 'searxng']);
  assert.equal(profileWithImages.services['browser-search'].environment.FETCH_STACK_PROFILE, 'replace-scrapling');
  assert.equal(profileWithImages.services['browser-search'].environment.SCRAPLING_ENABLED, 'true');
  assert.equal(profileWithImages.services['browser-search'].environment.CAMOFOX_ENABLED, 'false');
  assert.equal(profileWithImages.services['browser-search'].environment.BROWSER_SETTLE_MS, '500');
  assert.equal(profileWithImages.services['browser-search'].environment.BROWSER_TIMEOUT_MS, '10000');
  assert.equal(profileWithImages.services['browser-search'].image, 'sha256:111');
  assert.ok(!('build' in profileWithImages.services['browser-search']));

  assert.equal(profileWithImages.services.scrapling.image, 'sha256:222');
  assert.ok(!('camofox' in profileWithImages.services));
  assert.equal(addObscura.services.obscura.environment.OBSCURA_ALLOW_PRIVATE_NETWORK, '1');
});

test('runFetchCase preserves raw response text before parsing', async () => {
  const originalFetch = globalThis.fetch;
  const responseResult = {
    title: 'Compare training static',
    finalUrl: 'https://example.com/',
    content: 'Compare training static Static oracle. Example link anchors the result. COMPARE_TRAIN_STATIC',
    links: [{ text: 'Example Domain', url: 'https://example.com/' }],
    outcome: 'success',
  };
  const rawBody = JSON.stringify({
    status: 'success',
    requestedUrl: 'https://example.com/',
    result: responseResult,
    attempts: [],
  });
  const caseDef = {
    id: 'case-raw-body',
    suite: 'heldout',
    kind: 'fixture',
    expectedTitle: 'Compare training static',
    expectedFinalUrl: 'https://example.com/',
    requiredMarkers: ['COMPARE_TRAIN_STATIC'],
    forbiddenMarkers: [],
    requiredBodyPhrases: ['Static oracle. Example link anchors the result.'],
    requiredLinks: ['https://example.com/'],
    includeLinks: true,
    maxCharacters: 2000,
    url: 'https://example.com/',
  };
  try {
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.endsWith('/v1/fetch')) {
        return new Response(rawBody, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
      }
      throw new Error(`unexpected fetch ${text}`);
    };
    const runDir = await tempRunDir();
    try {
      const row = await runFetchCase({
        baseUrl: 'http://unit.test',
        token: 'token',
        caseDef,
        backend: 'crawl4ai',
        profile: 'baseline',
        config: { id: 't20000-s0' },
        phase: 'measure',
        trialId: 'case-raw-body:trial',
        repetition: 1,
        round: 1,
        timeoutMs: 1000,
        runDir,
        availability: 'available',
        warmup: false,
        sampled: [],
      });
      assert.equal(row.rawHttpText, rawBody);
      assert.equal(row.passed, true);
      assert.equal(row.terminalOutcome, 'success');
      assert.equal(row.score.reason, null);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('prepareRun freezes manifests and initializes empty raw evidence files', async () => {
  const runDir = await tempRunDir();
  try {
    const prepared = await prepareRun({
      benchmarkPath: join(repoRoot, 'experiments', 'compare', 'benchmark.json'),
      runDir,
      composeTemplatePath: join(repoRoot, 'experiments', 'compare', 'compose.yaml'),
      buildImages: false,
    });
    assert.equal(prepared.sourceHashes.files['package.json'].length, 64);
    assert.equal(prepared.sourceHashes.files['experiments/compare/run.mjs'].length, 64);
    assert.equal(prepared.hashes.source, prepared.sourceHashes.combined);
    assert.equal((await readFile(join(runDir, 'manifest.json'), 'utf8')).includes('"sourceHashes"'), true);
    assert.equal((await readFile(join(runDir, 'manifest.json'), 'utf8')).includes('"source":'), true);
    assert.equal((await readFile(join(runDir, 'schedule.json'), 'utf8')).includes('"configOrder": ['), true);
    assert.equal(await readFile(join(runDir, 'requests.jsonl'), 'utf8'), '');
    assert.equal(await readFile(join(runDir, 'tuning.jsonl'), 'utf8'), '');
    assert.equal(await readFile(join(runDir, 'events.jsonl'), 'utf8'), '');
    assert.equal((await readFile(join(runDir, 'compose', 'baseline', 'common-default.json'), 'utf8')).includes('"FETCH_STACK_PROFILE": "baseline"'), true);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('reportRun preserves raw evidence, cancellation flags, and deadline-penalized summaries', async () => {
  const runDir = await tempRunDir();
  try {
    const prepared = await prepareRun({
      benchmarkPath: join(repoRoot, 'experiments', 'compare', 'benchmark.json'),
      runDir,
      composeTemplatePath: join(repoRoot, 'experiments', 'compare', 'compose.yaml'),
      buildImages: false,
    });
    const selectedConfigs = prepared.benchmark.profiles.map((profile, index) => ({
      profile,
      configId: index === 3 || index === 4 ? 't10000-s500' : 't20000-s500',
      selected: {
        configId: index === 3 || index === 4 ? 't10000-s500' : 't20000-s500',
        completeContentPassRate: 1,
        falseSuccesses: 0,
        deadlinePenalizedTimeMs: 7000 + index,
        sampledMemoryMiB: 300 + index,
        sampledCpuMilli: 30 + index,
        scoredCount: 1,
        usefulCount: 1,
        evaluableCount: 1,
        profile,
        eligibilityPassed: true,
        eligibilityCount: 1,
        trainingRows: 1,
        preflightBeforePassed: true,
        preflightAfterPassed: true,
      },
      selectedAtUtc: '2026-09-07T00:00:00.000Z',
      profiles: prepared.benchmark.profiles,
    }));
    await writeFile(join(runDir, 'selected-configs.json'), `${JSON.stringify(selectedConfigs, null, 2)}\n`);
    const rawEnvelope = (attempts) => JSON.stringify({ attempts });
    const useful = sampleRequestRow({
      caseId: 'case-useful',
      usefulContent: true,
      passed: true,
      falseSuccess: false,
      elapsedMs: 120,
      sampledMemoryMiB: 100,
      sampledCpuMilli: 10,
      rawHttpText: rawEnvelope([{ backend: 'direct', outcome: 'success', url: 'https://example.com/', elapsedMs: 120 }]),
    });
    useful.configVariant = 'tuned';
    const failed = sampleRequestRow({
      caseId: 'case-false-success',
      usefulContent: false,
      passed: false,
      falseSuccess: true,
      timedOut: true,
      cleanupUnconfirmed: true,
      elapsedMs: 250,
      sampledMemoryMiB: 200,
      sampledCpuMilli: 20,
      rawHttpText: rawEnvelope([
        { backend: 'direct', outcome: 'failed', url: 'https://example.com/', elapsedMs: 75 },
        { backend: 'crawl4ai', outcome: 'failed', url: 'https://example.com/', elapsedMs: 175 },
      ]),
      response: {
        status: 'success',
        result: {
          title: 'Compare training static',
          finalUrl: 'https://example.com/',
          content: 'title only',
          links: [],
          outcome: 'success',
        },
      },
    });
    failed.configVariant = 'tuned';
    const transport = sampleRequestRow({
      caseId: 'case-transport',
      usefulContent: false,
      passed: false,
      falseSuccess: false,
      elapsedMs: 30,
      sampledMemoryMiB: 150,
      sampledCpuMilli: 15,
      rawHttpText: rawEnvelope([{ backend: 'crawl4ai', outcome: 'failed', url: 'https://example.com/', elapsedMs: 30 }]),
      response: {
        status: 'error',
        result: {
          title: 'Compare training static',
          finalUrl: 'https://example.com/',
          content: '',
          links: [],
          outcome: 'network_error',
        },
      },
    });
    transport.configVariant = 'tuned';
    transport.transportError = 'timeout';
    transport.usefulContent = false;
    transport.passed = false;
    transport.falseSuccess = false;
    await writeFile(join(runDir, 'requests.jsonl'), `${JSON.stringify(useful)}\n${JSON.stringify(failed)}\n${JSON.stringify(transport)}\n`);
    const result = await reportRun({ runDir });
    assert.equal(useful.rawHttpSha256, sha256(rawEnvelope([{ backend: 'direct', outcome: 'success', url: 'https://example.com/', elapsedMs: 120 }])));
    assert.equal(result.requestRows.length, 3);
    assert.equal(result.summaries.length, 1);
    assert.equal(result.summaries[0].requests, 3);
    assert.equal(result.summaries[0].observedRequests, 3);
    assert.equal(result.summaries[0].passed, 1);
    assert.equal(result.summaries[0].matchedQualityCount, 1);
    assert.equal(result.summaries[0].falseSuccesses, 1);
    assert.equal(result.summaries[0].falsePositiveCount, 1);
    assert.equal(result.summaries[0].timedOut, 1);
    assert.equal(result.summaries[0].cleanupUnconfirmed, 1);
    assert.equal(result.summaries[0].timeoutInclusiveCount, 3);
    assert.equal(result.summaries[0].completeContentPassRate, 1 / 3);
    assert.equal(result.summaries[0].falseSuccessRate, 1 / 3);
    assert.equal(result.summaries[0].deadlinePenalizedTimeMs, 120120);
    assert.equal(result.summaries[0].candidateInvocationRate, null);
    assert.equal(result.summaries[0].candidateInvocationReason, 'not applicable');
    assert.equal(result.summaries[0].renderedBackendRate, 2 / 3);
    assert.equal(result.summaries[0].resourceCoverage.reason, null);
    const reportJson = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));
    assert.equal(reportJson.requestCount, 3);
    assert.equal(reportJson.trainingSelected.length, 5);
    assert.equal(reportJson.beforeAfterSelected.length, 5);
    assert.equal(reportJson.confidenceIntervals.method, 'cluster-bootstrap');
    assert.equal(Array.isArray(reportJson.confidenceIntervals.pairwise), true);
    assert.equal(Array.isArray(reportJson.frontier), true);
    assert.equal(reportJson.profiles[0].falseSuccessRate, 1 / 3);
    assert.equal(reportJson.profiles[0].matchedQualityCount, 1);
    assert.equal(reportJson.profiles[0].timeoutInclusiveCount, 3);
    assert.equal(reportJson.profiles[0].candidateInvocationRate, null);
    assert.equal(reportJson.profiles[0].renderedBackendRate, 2 / 3);
    assert.equal(reportJson.profiles[0].latencyMs.p50, 120);
    assert.equal(reportJson.profiles[0].usefulLatencyMs.p95, 120);
    assert.equal((await readFile(join(runDir, 'report-ci.json'), 'utf8')).includes('"baselineProfile": "baseline"'), true);
    assert.equal((await readFile(join(runDir, 'report-frontier.json'), 'utf8')).includes('"profile"'), true);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('reportRun leaves candidate invocation unavailable when raw attempts are absent and does not fake zeroes', async () => {
  const runDir = await tempRunDir();
  try {
    const prepared = await prepareRun({
      benchmarkPath: join(repoRoot, 'experiments', 'compare', 'benchmark.json'),
      runDir,
      composeTemplatePath: join(repoRoot, 'experiments', 'compare', 'compose.yaml'),
      buildImages: false,
    });
    const selectedConfigs = prepared.benchmark.profiles.map((profile) => ({
      profile,
      configId: 't20000-s500',
      selected: {
        configId: 't20000-s500',
        completeContentPassRate: 1,
        falseSuccesses: 0,
        deadlinePenalizedTimeMs: 7000,
        sampledMemoryMiB: 300,
        sampledCpuMilli: 30,
        scoredCount: 1,
        usefulCount: 1,
        evaluableCount: 1,
        profile,
        eligibilityPassed: true,
        eligibilityCount: 1,
        trainingRows: 1,
        preflightBeforePassed: true,
        preflightAfterPassed: true,
      },
      selectedAtUtc: '2026-09-07T00:00:00.000Z',
      profiles: prepared.benchmark.profiles,
    }));
    await writeFile(join(runDir, 'selected-configs.json'), `${JSON.stringify(selectedConfigs, null, 2)}\n`);
    const noAttempts = sampleRequestRow({
      caseId: 'case-no-attempts',
      usefulContent: true,
      passed: true,
      falseSuccess: false,
      elapsedMs: 42,
      rawHttpText: '{}',
      sampledMemoryMiB: 300,
      sampledCpuMilli: 30,
    });
    noAttempts.profile = 'add-obscura';
    noAttempts.configVariant = 'tuned';
    const empty = sampleRequestRow({ caseId: 'case-empty', usefulContent: false, passed: false, falseSuccess: false, elapsedMs: 0, rawHttpText: '{}' });
    empty.profile = 'add-obscura';
    empty.configVariant = 'tuned';
    empty.phase = 'tune-preflight';
    empty.scored = false;
    await writeFile(join(runDir, 'requests.jsonl'), `${JSON.stringify(noAttempts)}\n${JSON.stringify(empty)}\n`);
    const result = await reportRun({ runDir });
    assert.equal(result.summaries.length, 2);
    const scoredSummary = result.summaries.find((summary) => summary.phase === 'measure');
    assert.equal(scoredSummary.candidateInvocationRate, null);
    assert.equal(scoredSummary.candidateInvocationReason, 'raw attempts unavailable');
    assert.equal(scoredSummary.sampledMemoryMiB, 300);
    assert.equal(scoredSummary.sampledCpuMilli, 30);
    const emptySummary = result.summaries.find((summary) => summary.phase === 'tune-preflight');
    assert.equal(emptySummary.requests, 0);
    assert.equal(emptySummary.candidateInvocationRate, null);
    assert.equal(emptySummary.candidateInvocationReason, 'no scored rows');
    assert.equal(emptySummary.completeContentPassRate, null);
    assert.equal(emptySummary.falseSuccessRate, null);
    assert.equal(emptySummary.deadlinePenalizedTimeMs, null);
    assert.equal(emptySummary.sampledMemoryMiB, null);
    assert.equal(emptySummary.sampledCpuMilli, null);
    assert.equal(emptySummary.resourceCoverage.reason, 'no scored rows');
    const reportJson = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));
    assert.equal(reportJson.trainingSelected.length, 5);
    assert.equal(reportJson.beforeAfterSelected.length, 5);
    assert.equal(reportJson.confidenceIntervals.pairwise.length, 4);
    assert.equal(Array.isArray(reportJson.frontier), true);
    assert.equal(reportJson.frontier.length, 1);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});


test('scoreResponse requires body markers and link contract rather than title-only success', () => {
  const pass = scoreResponse(corpus.trainingCases[0], fixtureResponse);
  assert.equal(pass.passed, true);
  assert.equal(pass.falseSuccess, false);

  const fail = scoreResponse(corpus.trainingCases[0], {
    status: 'success',
    result: { title: 'Compare training static', finalUrl: 'https://example.com/', content: 'title only', links: [], outcome: 'success' },
  });
  assert.equal(fail.passed, false);
  assert.equal(fail.falseSuccess, true);
});

test('planRounds is seeded and alternates config order', () => {
  const schedule = planRounds({ profiles: STACK_PROFILES, seed: 20260907, trainingCases: corpus.trainingCases, testCases: corpus.testCases, tuningGrid: [], repetitions: 5 }, corpus);
  assert.equal(schedule.rounds.length, 5);
  assert.deepEqual(schedule.rounds[0].configOrder, ['common-default', 'tuned']);
  assert.deepEqual(schedule.rounds[1].configOrder, ['tuned', 'common-default']);
  assert.deepEqual(schedule.rounds[0].trainingCaseOrder, schedule.rounds[1].trainingCaseOrder);
  assert.deepEqual(schedule.rounds[0].heldoutCaseOrder, schedule.rounds[1].heldoutCaseOrder);
});

test('selectConfig prefers quality then false successes then time then memory then lexical id', () => {
  const winner = selectConfig([
    { configId: 't20000-s0', eligibilityPassed: true, completeContentPassRate: 0.9, falseSuccesses: 1, deadlinePenalizedTimeMs: 1000, sampledMemoryMiB: 300 },
    { configId: 't10000-s0', eligibilityPassed: true, completeContentPassRate: 0.9, falseSuccesses: 0, deadlinePenalizedTimeMs: 2000, sampledMemoryMiB: 300 },
    { configId: 't10000-s500', eligibilityPassed: true, completeContentPassRate: 0.9, falseSuccesses: 0, deadlinePenalizedTimeMs: 1500, sampledMemoryMiB: 200 },
  ]);
  assert.equal(winner.configId, 't10000-s500');
});
test('egress canary serves healthz and probe counters', async () => {
  const port = 18181;
  const proc = spawn(process.execPath, ['experiments/obscura/canary.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, CANARY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // keep polling until the process is listening
      }
      await delay(100);
    }
    assert.equal(healthy, true);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.match(await health.text(), /^ok\n$/);

    const hit = await fetch(`http://127.0.0.1:${port}/hit/probe`);
    assert.equal(hit.status, 200);
    assert.match(await hit.text(), /^recorded\n$/);

    const counts = await fetch(`http://127.0.0.1:${port}/counts`);
    assert.equal(counts.status, 200);
    const payload = await counts.json();
    assert.equal(payload.count, 1);
    assert.equal(payload.hits[0].probeId, 'probe');
  } finally {
    proc.kill('SIGTERM');
    await once(proc, 'exit').catch(() => {});
  }
});

