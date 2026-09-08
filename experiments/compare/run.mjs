import { createWriteStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, appendFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import z from 'zod/v4';
import { buildCorpus, STACK_PROFILES, TUNING_GRID, sha256 as corpusSha256 } from './corpus.mjs';
import { requiredBackendsForProfile, requiredServicesForProfile, resourceEnvelope, diagnosticTrackCaps, loadComposeTemplate, writeComposeProfile, diagnosticComposeForBackend } from './deploy.mjs';
import { scoreResponse, normalizeWhitespace, truncate } from './score.mjs';
import { appendJsonl, evidenceRow, nowIso, commandObservation, redactCommandArgs } from './evidence.mjs';

const LAB_TOKEN = process.env.CRAWL4AI_TOKEN ?? process.env.BROWSER_SEARCH_API_KEY ?? randomBytes(24).toString('hex');
process.env.BROWSER_SEARCH_API_KEY ||= LAB_TOKEN;
process.env.CRAWL4AI_TOKEN ||= LAB_TOKEN;
process.env.CAMOFOX_API_KEY ||= LAB_TOKEN;
process.env.SCRAPLING_TOKEN ||= LAB_TOKEN;

const cliSchema = z.object({
  command: z.enum(['prepare', 'tune', 'measure', 'diagnose', 'report', 'all']),
  config: z.string().optional(),
  run: z.string().optional(),
  out: z.string().optional(),
  engine: z.enum(['camofox', 'cloakbrowser', 'obscura', 'scrapling']).optional(),
  'base-url': z.string().optional(),
  'compose-template': z.string().optional(),
  'no-build': z.boolean().optional(),
}).strict();

const benchmarkSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.array(z.enum(STACK_PROFILES)).length(STACK_PROFILES.length),
  seed: z.number().int(),
  trainingCases: z.array(z.string()).min(1),
  testCases: z.array(z.string()).min(1),
  tuningGrid: z.array(z.object({ id: z.string(), browserTimeoutMs: z.number().int(), browserSettleMs: z.number().int() })).length(6),
  resources: z.object({ cpu: z.number(), memoryMiB: z.number().int() }),
  requestDeadlineMs: z.number().int(),
  repetitions: z.number().int().positive(),
  concurrency: z.literal(1),
  diagnosticConcurrency: z.array(z.number().int().positive()).min(1),
}).strict();

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashObject(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

const sourceFingerprintPaths = [
  'package.json',
  'package-lock.json',
  'experiments/compare/run.mjs',
  'experiments/compare/deploy.mjs',
  'experiments/compare/score.mjs',
  'experiments/compare/corpus.mjs',
  'experiments/compare/evidence.mjs',
  'experiments/compare/cdp-probe.mjs',
  'src/config.ts',
  'src/orchestrator.ts',
  'src/backends/scrapling.ts',
  'src/stack-profiles.ts',
  'src/types.ts',
];

async function hashSourceFiles(repoRoot) {
  const files = {};
  for (const rel of sourceFingerprintPaths) {
    const abs = join(repoRoot, rel);
    try {
      files[rel] = createHash('sha256').update(await readFile(abs)).digest('hex');
    } catch {
      files[rel] = null;
    }
  }
  return {
    files,
    combined: hashObject(files),
  };
}
function seededOrder(items, seed, salt = '') {
  return [...items]
    .map((item) => ({ item, digest: createHash('sha256').update(`${seed}:${salt}:${item.id ?? item}`, 'utf8').digest('hex') }))
    .sort((a, b) => a.digest.localeCompare(b.digest, 'en'))
    .map((entry) => entry.item);
}

function rotate(items, offset) {
  const copy = [...items];
  if (!copy.length) return copy;
  const index = ((offset % copy.length) + copy.length) % copy.length;
  return copy.slice(index).concat(copy.slice(0, index));
}

function latinSquare(items, roundIndex) {
  return rotate(items, roundIndex);
}

function parseArgs(argv) {
  if (!argv.length) throw new Error('missing command');
  const [command, ...rest] = argv;
  const out = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];
    switch (arg) {
      case '--config':
      case '--run':
      case '--out':
      case '--engine':
      case '--base-url':
      case '--compose-template':
        if (!next || next.startsWith('--')) throw new Error(`missing value for ${arg}`);
        out[arg.slice(2)] = next;
        index += 1;
        break;
      case '--no-build':
        out['no-build'] = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  return cliSchema.parse(out);
}

async function loadBenchmark(filePath) {
  return benchmarkSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
}

function corpusFromBenchmark(benchmark) {
  const corpus = buildCorpus();
  const byId = corpus.byId;
  const pick = (ids, kind) => ids.map((id) => {
    const caseDef = byId.get(id);
    if (!caseDef) throw new Error(`benchmark references unknown ${kind} case ${id}`);
    return caseDef;
  });
  return {
    ...corpus,
    trainingCases: pick(benchmark.trainingCases, 'training'),
    testCases: pick(benchmark.testCases, 'test'),
  };
}

function planRounds(benchmark, corpus) {
  const profileOrderBase = seededOrder(benchmark.profiles, benchmark.seed, 'profiles');
  const heldoutCases = seededOrder(corpus.testCases, benchmark.seed, 'heldout-cases');
  const trainingCases = seededOrder(corpus.trainingCases, benchmark.seed, 'training-cases');
  return {
    schemaVersion: 1,
    seed: benchmark.seed,
    profiles: [...benchmark.profiles],
    profileOrderBase,
    rounds: Array.from({ length: benchmark.repetitions }, (_, round) => ({
      round: round + 1,
      profileOrder: latinSquare(profileOrderBase, round),
      trainingCaseOrder: trainingCases.map((entry) => entry.id),
      heldoutCaseOrder: heldoutCases.map((entry) => entry.id),
      configOrder: round % 2 === 0 ? ['common-default', 'tuned'] : ['tuned', 'common-default'],
    })),
    trainingCases: trainingCases.map((entry) => entry.id),
    heldoutCases: heldoutCases.map((entry) => entry.id),
    tuningGrid: benchmark.tuningGrid.map((grid) => ({ ...grid })),
  };
}

function profilePort(runId, profileIndex) {
  const digest = createHash('sha256').update(String(runId), 'utf8').digest();
  const offset = digest.readUInt16BE(0) % 1000;
  return 18_100 + offset * 10 + profileIndex * 10;
}

function composeProjectName(runId, profile) {
  return `compare-${String(runId).toLowerCase()}-${profile}`.replace(/[^a-z0-9_.-]+/g, '-');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function ensureFreshRunDir(runDir) {
  const manifestPath = join(runDir, 'manifest.json');
  if (existsSync(manifestPath)) return false;
  await mkdir(runDir, { recursive: true });
  return true;
}

function manifestPaths(runDir) {
  return {
    manifest: join(runDir, 'manifest.json'),
    schedule: join(runDir, 'schedule.json'),
    tuning: join(runDir, 'tuning.jsonl'),
    selected: join(runDir, 'selected-configs.json'),
    requests: join(runDir, 'requests.jsonl'),
    resources: join(runDir, 'resources.jsonl'),
    events: join(runDir, 'events.jsonl'),
    reportJson: join(runDir, 'report.json'),
    reportCsv: join(runDir, 'report.csv'),
  };
}

function commandProbe(command, args, cwd) {
  const startedUtc = nowIso();
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  const completedUtc = nowIso();
  const elapsedMs = Date.now() - started;
  return {
    ...commandObservation({
      command,
      args,
      cwd,
      exitCode: result.status ?? result.signal ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      startedUtc,
      completedUtc,
      elapsedMs,
    }),
    ok: result.status === 0,
    signal: result.signal ?? null,
  };
}
async function commandProbeStream(command, args, cwd, logPath) {
  const startedUtc = nowIso();
  const started = Date.now();
  await mkdir(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrTail = '';
  const attach = (chunk, isErr = false) => {
    stream.write(chunk);
    if (isErr) stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4096);
  };
  child.stdout.on('data', (chunk) => attach(chunk, false));
  child.stderr.on('data', (chunk) => attach(chunk, true));
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => stream.end());
  const completedUtc = nowIso();
  const elapsedMs = Date.now() - started;
  return {
    kind: 'command',
    command,
    args: redactCommandArgs(args),
    cwd,
    exitCode: exit.code ?? exit.signal ?? 0,
    stdout: `artifact://${logPath}`,
    stderr: stderrTail ? `artifact://${logPath}` : '',
    startedUtc,
    completedUtc,
    elapsedMs,
    ok: (exit.code ?? 0) === 0,
    signal: exit.signal ?? null,
    stdoutArtifact: logPath,
    stderrArtifact: logPath,
  };
}

function inspectDockerImageId(imageRef) {
  const result = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageRef], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`docker image inspect failed for ${imageRef}: ${(result.stderr ?? result.stdout ?? '').trim()}`.trim());
  }
  const id = String(result.stdout ?? '').trim().split(/\r?\n/)[0];
  if (!id) throw new Error(`docker image inspect returned no id for ${imageRef}`);
  return id;
}

function prepareBuildProfiles() {
  return ['baseline', 'add-obscura', 'add-scrapling'];
}
function parseEnvFile(content) {
  const env = {};
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 0) continue;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

function renderRunSecrets(token) {
  return [
    `BROWSER_SEARCH_API_KEY=${token}`,
    `CRAWL4AI_TOKEN=${token}`,
    `CAMOFOX_API_KEY=${token}`,
    `SCRAPLING_TOKEN=${token}`,
    '',
  ].join('\n');
}

async function ensureRunSecrets(runDir, expectedHash = null) {
  const secretsPath = resolve(runDir, 'secrets.env');
  if (existsSync(secretsPath)) {
    const content = await readFile(secretsPath, 'utf8');
    const hash = createHash('sha256').update(content, 'utf8').digest('hex');
    if (expectedHash && expectedHash !== hash) {
      throw new Error(`refusing to resume run with mismatched secrets hash at ${secretsPath}`);
    }
    return { secretsPath, content, hash, env: parseEnvFile(content) };
  }
  const token = randomBytes(24).toString('hex');
  const content = renderRunSecrets(token);
  await writeFile(secretsPath, content, { mode: 0o600 });
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  return { secretsPath, content, hash, env: parseEnvFile(content) };
}

function composeArgs({ runDir, composeOutPath, project, args }) {
  return ['compose', '--env-file', resolve(runDir, 'secrets.env'), '-f', composeOutPath, '-p', project, ...args];
}




function requestBodyForCase(caseDef, backend) {
  const body = {
    url: caseDef.url,
    backend,
    maxCharacters: caseDef.maxCharacters ?? 20_000,
    includeLinks: caseDef.includeLinks ?? true,
  };
  if (caseDef.query) body.query = caseDef.query;
  if (caseDef.preferCrawl4ai) body.preferCrawl4ai = true;
  return body;
}

async function postJson(url, body, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const startedUtc = nowIso();
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      startedUtc,
      completedUtc: nowIso(),
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runRawHttpPreflight(caseDef, profile, config, phase, runDir, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const startedUtc = nowIso();
  const started = Date.now();
  const expectedHash = caseDef.fixtureSha256 ?? null;
  const expectedContentType = String(caseDef.fixtureContentType ?? 'text/html').toLowerCase();
  try {
    const response = await fetch(caseDef.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await response.text();
    const bodyHash = createHash('sha256').update(text, 'utf8').digest('hex');
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    const hashMatches = expectedHash === null || bodyHash === expectedHash;
    const contentTypeMatches = contentType.startsWith(expectedContentType);
    const usefulContent = response.ok && hashMatches && contentTypeMatches;
    const score = {
      backend: 'raw-http',
      outcome: usefulContent ? 'success' : 'fixture_mismatch',
      ...(usefulContent ? {} : { reason: !hashMatches ? 'body_hash_mismatch' : !contentTypeMatches ? 'content_type_mismatch' : `http_${response.status}` }),
      url: caseDef.url,
      finalUrl: response.url,
      title: '',
      content: '',
      links: [],
      httpStatus: response.status,
      contentType,
      elapsedMs: Date.now() - started,
      truncated: false,
      usefulContent,
      falseSuccess: false,
      passed: usefulContent,
      terminalOutcome: usefulContent ? 'success' : 'fixture_mismatch',
    };
    const row = evidenceRow({
      runDir,
      profile,
      backend: 'raw-http',
      suite: caseDef.suite ?? 'training',
      caseId: caseDef.id,
      configId: config.id,
      phase,
      trialId: `${profile}:${config.id}:${caseDef.id}:${phase}`,
      repetition: 0,
      round: 0,
      startedUtc,
      completedUtc: nowIso(),
      elapsedMs: Date.now() - started,
      availability: usefulContent ? 'available' : 'available',
      scored: true,
      expected: {
        title: caseDef.expectedTitle ?? null,
        finalUrl: caseDef.expectedFinalUrl ?? null,
        markers: caseDef.requiredMarkers ?? [],
        links: caseDef.requiredLinks ?? [],
        terminalOutcome: caseDef.expectedTerminalOutcome ?? null,
      },
      rawHttpText: text,
      rawHttpStatus: response.status,
      rawHttpHeaders: Object.fromEntries(response.headers.entries()),
    });
    row.score = score;
    row.usefulContent = usefulContent;
    row.falseSuccess = false;
    row.passed = usefulContent;
    row.terminalOutcome = score.terminalOutcome;
    row.rawBodyHash = bodyHash;
    row.rawContentType = contentType;
    return row;
  } catch (error) {
    const row = evidenceRow({
      runDir,
      profile,
      backend: 'raw-http',
      suite: caseDef.suite ?? 'training',
      caseId: caseDef.id,
      configId: config.id,
      phase,
      trialId: `${profile}:${config.id}:${caseDef.id}:${phase}`,
      repetition: 0,
      round: 0,
      startedUtc,
      completedUtc: nowIso(),
      elapsedMs: Date.now() - started,
      availability: 'available',
      scored: false,
      expected: {
        title: caseDef.expectedTitle ?? null,
        finalUrl: caseDef.expectedFinalUrl ?? null,
        markers: caseDef.requiredMarkers ?? [],
        links: caseDef.requiredLinks ?? [],
        terminalOutcome: caseDef.expectedTerminalOutcome ?? null,
      },
      rawHttpStatus: null,
      rawHttpHeaders: null,
    });
    row.score = {
      backend: 'raw-http',
      outcome: 'network_error',
      reason: String(error?.message ?? error),
      url: caseDef.url,
      finalUrl: caseDef.url,
      title: '',
      content: '',
      links: [],
      httpStatus: null,
      contentType: null,
      elapsedMs: Date.now() - started,
      truncated: false,
      usefulContent: false,
      falseSuccess: false,
      passed: false,
      terminalOutcome: 'network_error',
    };
    row.usefulContent = false;
    row.falseSuccess = false;
    row.passed = false;
    row.terminalOutcome = 'network_error';
    return row;
  } finally {
    clearTimeout(timer);
  }
}

function parseResponseEnvelope(rawText) {
  if (!rawText) return { parsed: null, error: 'empty response body' };
  try {
    return { parsed: JSON.parse(rawText), error: null };
  } catch (error) {
    return { parsed: null, error: `invalid json: ${String(error?.message ?? error)}` };
  }
}

function responseFlags(parsed) {
  const attempts = Array.isArray(parsed?.attempts) ? parsed.attempts : [];
  return {
    timedOut: Boolean(parsed?.result?.timedOut || attempts.some((attempt) => attempt?.timedOut)),
    cleanupUnconfirmed: Boolean(parsed?.result?.cleanupUnconfirmed || attempts.some((attempt) => attempt?.cleanupUnconfirmed)),
  };
}

async function readReadyz(baseUrl, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/readyz`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady(baseUrl, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const ready = await readReadyz(baseUrl, token, Math.min(7000, timeoutMs));
      try {
        const parsed = JSON.parse(ready.text);
        if (parsed?.ready === true || parsed?.status === 'ok' || parsed?.service === 'ok' || parsed?.readyz?.ready === true) return parsed;
      } catch {
        if (/\"service\"\s*:\s*\"ok\"/i.test(ready.text) || /\"status\"\s*:\s*\"ok\"/i.test(ready.text) || /ready\s*:\s*true/i.test(ready.text)) {
          return { ready: true, text: ready.text };
        }
      }
      lastError = ready.text;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`readyz timed out: ${lastError ?? 'unknown error'}`);
}

async function readHealthz(baseUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/healthz`, { signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDiagnosticReady({ baseUrl, token, backend, profile, config, runDir, smokeCase, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await readHealthz(baseUrl, Math.min(5000, timeoutMs));
      if (health.ok) break;
      lastError = health.text;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!lastError && Date.now() >= deadline) {
    throw new Error('diagnostic healthz timed out');
  }
  const smoke = await runFetchCase({
    baseUrl,
    token,
    caseDef: smokeCase,
    backend,
    profile,
    config,
    phase: 'diagnose-smoke',
    trialId: `${profile}:${backend}:${smokeCase.id}:smoke`,
    repetition: 0,
    round: 0,
    timeoutMs,
    runDir,
    availability: 'available',
    warmup: true,
  });
  if (!smoke.usefulContent) {
    throw new Error(`diagnostic smoke failed for ${profile}/${backend}: ${smoke.score?.reason ?? smoke.transportError ?? smoke.terminalOutcome ?? 'unknown'}`);
  }
  return smoke;
}


function composeFileFor(profile, configId) {
  return join('compose', profile, `${configId}.json`);
}

function composeBaseDirFromManifest(manifest) {
  return dirname(resolve(manifest.composeTemplatePath));
}

async function deployProfile({ runDir, manifest, profile, config, buildImages = false }) {
  const profileIndex = manifest.profiles.findIndex((entry) => entry.profile === profile);
  if (profileIndex < 0) throw new Error(`unknown profile ${profile}`);
  const profileEntry = manifest.profiles[profileIndex];
  const project = composeProjectName(manifest.runId, profile);
  const composePath = composeFileFor(profile, config.id);
  const composeOutPath = resolve(runDir, composePath);
  await mkdir(dirname(composeOutPath), { recursive: true });
  await writeComposeProfile({
    templatePath: manifest.composeTemplatePath,
    profile,
    tuning: { browserTimeoutMs: config.browserTimeoutMs, browserSettleMs: config.browserSettleMs, browserSearchPort: profileEntry.port },
    outPath: composeOutPath,
    baseDir: composeBaseDirFromManifest(manifest),
    runId: manifest.runId,
  });
  const baseUrl = `http://127.0.0.1:${profileEntry.port}`;
  if (buildImages) {
    const build = commandProbe('docker', composeArgs({ runDir, composeOutPath, project, args: ['build'] }), runDir);
    if (!build.ok) throw new Error(`docker compose build failed for ${profile}/${config.id}: ${build.stderr || build.stdout}`.trim());
  }
  const up = commandProbe('docker', composeArgs({ runDir, composeOutPath, project, args: ['up', '-d', '--no-build', '--pull', 'never'] }), runDir);
  if (!up.ok) throw new Error(`docker compose up failed for ${profile}/${config.id}: ${up.stderr || up.stdout}`.trim());
  await waitForReady(baseUrl, process.env.BROWSER_SEARCH_API_KEY ?? '', manifest.benchmark.requestDeadlineMs + 5000);
  return { runDir, project, composePath, composeOutPath, baseUrl, profile, config, profileEntry, manifest };
}

function parseDockerStatsLine(line) {
  try {
    const obj = JSON.parse(line);
    const memory = String(obj.MemUsage ?? obj.MemPerc ?? '0 / 0');
    const used = memory.split('/')[0].trim();
    const usedMiB = /GiB/i.test(used) ? Number.parseFloat(used) * 1024 : /MiB/i.test(used) ? Number.parseFloat(used) : Number.parseFloat(used) / (1024 * 1024);
    const cpu = String(obj.CPUPerc ?? '0').replace(/%$/, '');
    const pids = Number.parseInt(String(obj.PIDs ?? obj.PID ?? obj.Pid ?? '0'), 10);
    return {
      container: obj.Name ?? obj.Container ?? '',
      cpuMilli: Number.isFinite(Number(cpu)) ? Math.round(Number(cpu) * 10) : 0,
      memoryMiB: Number.isFinite(usedMiB) ? Math.round(usedMiB) : 0,
      pids: Number.isFinite(pids) ? pids : 0,
      raw: obj,
    };
  } catch {
    return null;
  }
}

function sumResourceSamples(samples) {
  return (Array.isArray(samples) ? samples : []).reduce(
    (acc, sample) => ({
      cpuMilli: acc.cpuMilli + Number(sample?.cpuMilli ?? 0),
      memoryMiB: acc.memoryMiB + Number(sample?.memoryMiB ?? 0),
      pids: acc.pids + Number(sample?.pids ?? 0),
    }),
    { cpuMilli: 0, memoryMiB: 0, pids: 0 },
  );
}

function eligibilityProbePassed(row) {
  if (row.transportError || row.timedOut || row.cleanupUnconfirmed) return false;
  const expectedOutcome = row.expected?.terminalOutcome ?? null;
  if (expectedOutcome) {
    return row.terminalOutcome === expectedOutcome;
  }
  return row.passed && !row.falseSuccess;
}

function sampleProjectResources(project, composeOutPath, cwd) {
  const ps = commandProbe('docker', composeArgs({ runDir: cwd, composeOutPath, project, args: ['ps', '-q'] }), cwd);
  const ids = ps.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!ids.length) return [];
  const stats = spawnSync('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids], { cwd, encoding: 'utf8' });
  if (stats.status !== 0) return [];
  return String(stats.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(parseDockerStatsLine).filter(Boolean);
}

async function stopProfile({ runDir, project, composeOutPath }) {
  const down = commandProbe('docker', composeArgs({ runDir, composeOutPath, project, args: ['down', '--timeout', '0', '--remove-orphans'] }), runDir);
  if (!down.ok) throw new Error(`docker compose down failed for ${project}: ${down.stderr || down.stdout}`.trim());
  const ps = commandProbe('docker', composeArgs({ runDir, composeOutPath, project, args: ['ps', '-q'] }), runDir);
  if (ps.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length) {
    throw new Error(`docker compose down did not clear all containers for ${project}`);
  }
}


async function runFetchCase({ baseUrl, token, caseDef, backend, profile, config, phase, trialId, repetition, round, timeoutMs, runDir, availability = 'available', warmup = false, sampled = [] }) {
  const startedUtc = nowIso();
  const started = Date.now();
  const requestBody = requestBodyForCase(caseDef, backend);
  let raw = null;
  let transportError = null;
  try {
    raw = await postJson(`${baseUrl.replace(/\/$/, '')}/v1/fetch`, requestBody, token, timeoutMs);
  } catch (error) {
    transportError = String(error?.message ?? error);
  }
  const completedUtc = nowIso();
  const elapsedMs = Date.now() - started;
  const rawText = raw?.text ?? null;
  const { parsed, error: parseError } = parseResponseEnvelope(rawText ?? '');
  if (!transportError && parseError) transportError = parseError;
  const score = parsed ? scoreResponse(caseDef, { response: parsed }) : {
    passed: false,
    falseSuccess: false,
    usefulContent: false,
    reason: 'transport_error',
    manualReviewRequired: Boolean(caseDef.manualReviewRequired),
    responseStatus: 'failed',
    terminalOutcome: null,
    title: '',
    finalUrl: '',
    linkCount: 0,
    links: [],
    content: '',
    requiredMarkers: [],
    forbiddenMarkers: [],
    requiredBodyPhrases: [],
    requiredLinks: [],
  };
  const flags = responseFlags(parsed);
  const sample = sumResourceSamples(sampled);
  const row = evidenceRow({
    runId: basename(resolve(runDir)),
    profile,
    backend,
    suite: caseDef.suite ?? 'training',
    caseId: caseDef.id,
    configId: config.id,
    phase,
    trialId,
    repetition,
    round,
    startedUtc,
    completedUtc,
    elapsedMs,
    availability,
    scored: !warmup && availability === 'available',
    expected: {
      title: caseDef.expectedTitle ?? null,
      finalUrl: caseDef.expectedFinalUrl ?? null,
      markers: caseDef.requiredMarkers ?? [],
      links: caseDef.requiredLinks ?? [],
      terminalOutcome: caseDef.expectedTerminalOutcome ?? null,
    },
    rawHttpText: rawText,
    rawHttpStatus: raw?.status ?? null,
    rawHttpHeaders: raw?.headers ?? null,
  });
  row.scored = !warmup && availability === 'available' && Boolean(parsed);
  row.score = score;
  row.usefulContent = score.usefulContent;
  row.falseSuccess = score.falseSuccess;
  row.passed = score.passed;
  row.terminalOutcome = score.terminalOutcome;
  row.manualReviewRequired = score.manualReviewRequired;
  row.sampledMemoryMiB = sample.memoryMiB;
  row.sampledCpuMilli = sample.cpuMilli;
  if (transportError) row.transportError = transportError;
  if (flags.timedOut) row.timedOut = true;
  if (flags.cleanupUnconfirmed) row.cleanupUnconfirmed = true;
  return row;
}

function preflightCases(cases) {
  return (Array.isArray(cases) ? cases : []).filter((entry) => entry.preflight);
}

async function runEligibilityProbes({ baseUrl, token, profile, config, corpus, runDir, timeoutMs, phase }) {
  const probes = [];
  const requiredBackends = requiredBackendsForProfile(profile);
  const denialCases = [
    { id: 'deny-private', url: 'http://10.0.0.5/admin', expectedTerminalOutcome: 'policy_denied' },
    { id: 'deny-metadata', url: 'http://169.254.169.254/latest/meta-data/', expectedTerminalOutcome: 'policy_denied' },
    { id: 'deny-credentials', url: 'https://user:pass@example.com/', expectedTerminalOutcome: 'policy_denied' },
    { id: 'deny-canary', url: 'http://127.0.0.1:18080/', expectedTerminalOutcome: 'policy_denied' },
  ];
  const pairs = [
    ['eligibility-static-a1', 'eligibility-static-b1'],
    ['eligibility-static-a2', 'eligibility-static-b2'],
  ].map(([a, b]) => [corpus.byId.get(a), corpus.byId.get(b)]).filter(([a, b]) => a && b);
  for (const backend of requiredBackends) {
    for (const denial of denialCases) {
      probes.push(await runFetchCase({
        baseUrl,
        token,
        caseDef: {
          id: `${backend}:${denial.id}`,
          suite: 'eligibility',
          kind: 'fixture',
          expectedTitle: '',
          requiredMarkers: [],
          forbiddenMarkers: [],
          expectedTerminalOutcome: denial.expectedTerminalOutcome,
          url: denial.url,
          expectedFinalUrl: denial.url,
          includeLinks: false,
          maxCharacters: 1000,
          preflight: false,
        },
        backend,
        profile,
        config,
        phase,
        trialId: `${profile}:${config.id}:${backend}:${denial.id}`,
        repetition: 0,
        round: 0,
        timeoutMs,
        runDir,
      }));
    }
    for (const [first, second] of pairs) {
      const [rowA, rowB] = await Promise.all([
        runFetchCase({ baseUrl, token, caseDef: first, backend, profile, config, phase, trialId: `${profile}:${config.id}:${backend}:${first.id}`, repetition: 0, round: 0, timeoutMs, runDir }),
        runFetchCase({ baseUrl, token, caseDef: second, backend, profile, config, phase, trialId: `${profile}:${config.id}:${backend}:${second.id}`, repetition: 0, round: 0, timeoutMs, runDir }),
      ]);
      rowA.parallelPair = [first.id, second.id];
      rowB.parallelPair = [first.id, second.id];
      probes.push(rowA, rowB);
    }
  }
  return probes;
}

async function runPreflightBatch({ baseUrl, token, profile, config, cases, runDir, timeoutMs, phase }) {
  const rows = [];
  for (const caseDef of preflightCases(cases)) {
    rows.push(await runRawHttpPreflight(caseDef, profile, config, phase, runDir, timeoutMs));
  }
  return rows;
}

function summarizeConfig(configId, rows, requestDeadlineMs) {
  const scored = rows.filter((row) => row.scored !== false);
  const evaluated = scored.filter((row) => !row.transportError && !row.timedOut && !row.cleanupUnconfirmed);
  const usefulRows = evaluated.filter((row) => row.usefulContent);
  const total = evaluated.length;
  const completeContentPassRate = total ? usefulRows.length / total : 0;
  const falseSuccesses = scored.filter((row) => row.falseSuccess).length;
  const deadlinePenalizedTimeMs = scored.reduce((sum, row) => sum + (row.usefulContent ? row.elapsedMs : requestDeadlineMs), 0);
  const sampledMemoryMiB = scored.reduce((max, row) => Math.max(max, Number(row.sampledMemoryMiB ?? 0)), 0);
  const sampledCpuMilli = scored.reduce((max, row) => Math.max(max, Number(row.sampledCpuMilli ?? 0)), 0);
  return { configId, completeContentPassRate, falseSuccesses, deadlinePenalizedTimeMs, sampledMemoryMiB, sampledCpuMilli, scoredCount: scored.length, usefulCount: usefulRows.length, evaluableCount: total };
}

function compareConfigSummaries(a, b) {
  if (b.completeContentPassRate !== a.completeContentPassRate) return b.completeContentPassRate - a.completeContentPassRate;
  if (a.falseSuccesses !== b.falseSuccesses) return a.falseSuccesses - b.falseSuccesses;
  if (a.deadlinePenalizedTimeMs !== b.deadlinePenalizedTimeMs) return a.deadlinePenalizedTimeMs - b.deadlinePenalizedTimeMs;
  if (a.sampledMemoryMiB !== b.sampledMemoryMiB) return a.sampledMemoryMiB - b.sampledMemoryMiB;
  return a.configId.localeCompare(b.configId, 'en');
}

function selectConfig(summaryRows) {
  const summaries = summaryRows.filter((summary) => summary.eligibilityPassed !== false);
  if (!summaries.length) throw new Error('no eligible configs');
  summaries.sort(compareConfigSummaries);
  return summaries[0];
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.profile ?? 'unknown', row.suite ?? 'unknown', row.phase ?? 'unknown', row.configVariant ?? row.configId ?? 'n/a'].join('|');
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return groups;
}

function rawAttemptsFromRow(row) {
  const { parsed, error } = parseResponseEnvelope(row?.rawHttpText ?? '');
  if (!parsed) return { attempts: null, reason: error ?? 'missing rawHttpText' };
  if (!Array.isArray(parsed.attempts)) return { attempts: null, reason: 'raw attempts unavailable' };
  return { attempts: parsed.attempts, reason: null };
}

function numericMax(rows, field) {
  const values = rows
    .map((row) => Number(row?.[field]))
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function sampleCoverage(rows, field) {
  return rows.filter((row) => Number.isFinite(Number(row?.[field]))).length;
}

function candidateBackendForProfile(profile) {
  if (profile === 'add-obscura' || profile === 'replace-obscura') return 'obscura';
  if (profile === 'add-scrapling' || profile === 'replace-scrapling') return 'scrapling';
  return null;
}

function cycleCases(items, count, offset = 0) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => list[(offset + index) % list.length]);
}


function diagnosticTrackSpecs() {
  return [
    { profile: 'baseline', backend: 'camofox', track: 'engine-camofox' },
    { profile: 'baseline', backend: 'cloakbrowser', track: 'engine-cloakbrowser' },
    { profile: 'replace-obscura', backend: 'obscura', track: 'engine-obscura' },
    { profile: 'replace-scrapling', backend: 'scrapling', track: 'engine-scrapling' },
  ];
}

function diagnosticPortForBackend(backend) {
  const index = ['camofox', 'cloakbrowser', 'obscura', 'scrapling'].indexOf(backend);
  if (index < 0) throw new Error(`unknown diagnostic backend ${backend}`);
  return 18100 + index;
}




async function runDiagnosticTrack({ runDir, manifest, benchmark, corpus, profile, backend, track, config, token }) {
  const diagnosticPort = diagnosticPortForBackend(backend);
  const project = composeProjectName(manifest.runId, `${profile}-${backend}`);
  const diagDir = resolve(runDir, 'diagnostics', 'engine', `${profile}-${backend}`);
  const composeOutPath = resolve(diagDir, `${config.id}.json`);
  await mkdir(diagDir, { recursive: true });
  await writeFile(composeOutPath, JSON.stringify(
    diagnosticComposeForBackend(
      await loadComposeTemplate(manifest.composeTemplatePath),
      profile,
      backend,
      { browserTimeoutMs: config.browserTimeoutMs, browserSettleMs: config.browserSettleMs, browserSearchPort: diagnosticPort },
      {},
      dirname(resolve(manifest.composeTemplatePath)),
      manifest.runId,
    ),
    null,
    2,
  ));
  const baseUrl = `http://127.0.0.1:${diagnosticPort}`;
  const up = commandProbe('docker', composeArgs({ runDir, composeOutPath, project, args: ['up', '-d', '--no-build', '--pull', 'never'] }), runDir);
  if (!up.ok) throw new Error(`docker compose up failed for ${profile}/${backend}: ${up.stderr || up.stdout}`.trim());

  const diagRequests = join(diagDir, 'requests.jsonl');
  const diagResources = join(diagDir, 'resources.jsonl');
  const diagEvents = join(diagDir, 'events.jsonl');
  const selectedCases = seededOrder(corpus.diagnosticCases, benchmark.seed, `${profile}:${backend}:diagnostic`);
  const batches = 5;
  const rows = [];
  const blockers = [];
  const concurrencyPattern = [2, 4, 2, 4, 2];

  try {
    await waitForDiagnosticReady({
      baseUrl,
      token,
      backend,
      profile,
      config,
      runDir,
      smokeCase: corpus.diagnosticCases[0],
      timeoutMs: benchmark.requestDeadlineMs + 5000,
    });
    for (let batch = 0; batch < batches; batch += 1) {
      const concurrency = concurrencyPattern[batch] ?? 2;
      const batchCases = cycleCases(selectedCases, 10, batch * 2);
      const sampled = sampleProjectResources(project, composeOutPath, runDir);
      await appendJsonl(diagResources, {
        phase: 'diagnose',
        track,
        profile,
        backend,
        batch: batch + 1,
        concurrency,
        runId: manifest.runId,
        timestamp: nowIso(),
        sampled,
        summary: sumResourceSamples(sampled),
        caps: diagnosticTrackCaps(backend),
      });
      const chunkRows = [];
      for (let offset = 0; offset < batchCases.length; offset += concurrency) {
        const slice = batchCases.slice(offset, offset + concurrency);
        const results = await Promise.all(slice.map((caseDef, index) => runFetchCase({
          baseUrl,
          token,
          caseDef,
          backend,
          profile,
          config,
          phase: 'diagnose',
          trialId: `${profile}:${backend}:${batch + 1}:${offset + index}:${caseDef.id}`,
          repetition: batch + 1,
          round: concurrency,
          timeoutMs: benchmark.requestDeadlineMs,
          runDir,
          sampled,
          availability: 'available',
        })));
        for (const row of results) {
          row.concurrency = concurrency;
          row.track = track;
          row.diagnosticBackend = backend;
          row.diagnosticBatch = batch + 1;
          rows.push(row);
          chunkRows.push(row);
          await appendJsonl(diagRequests, row);
        }
      }
      await appendJsonl(diagEvents, {
        phase: 'diagnose',
        track,
        profile,
        backend,
        batch: batch + 1,
        concurrency,
        runId: manifest.runId,
        timestamp: nowIso(),
        completed: true,
        rows: chunkRows.length,
      });
      if (batch < batches - 1) {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    }
  } catch (error) {
    blockers.push({ profile, backend, track, reason: String(error?.message ?? error) });
  } finally {
    await stopProfile({ runDir, project, composeOutPath }).catch(() => {});
  }

  await writeJson(resolve(diagDir, 'summary.json'), {
    runId: manifest.runId,
    profile,
    backend,
    track,
    sampleCount: rows.length,
    blockerCount: blockers.length,
    blockers,
    batchCount: batches,
    concurrencyPattern,
    idleMs: 30_000,
    caps: diagnosticTrackCaps(backend),
  });
  if (rows.length === 0 || blockers.length > 0) {
    const error = new Error(`diagnostics blocked for ${profile}/${backend}: ${blockers.length} blockers, ${rows.length} samples`);
    error.blockers = blockers;
    throw error;
  }
  return { rows, diagDir };
}






function summariseRows(rows, profile = null) {
  const scoredRows = rows.filter((row) => row.scored !== false && row.availability !== 'missing');
  const evaluableRows = scoredRows.filter((row) => !row.transportError && !row.timedOut && !row.cleanupUnconfirmed);
  const usefulRows = evaluableRows.filter((row) => row.usefulContent);
  const total = scoredRows.length;
  const passed = usefulRows.length;
  const falseSuccesses = scoredRows.filter((row) => row.falseSuccess && !row.usefulContent).length;
  const timedOut = rows.filter((row) => row.timedOut).length;
  const cleanupUnconfirmed = rows.filter((row) => row.cleanupUnconfirmed).length;
  const inclusiveLatency = evaluableRows.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const usefulLatency = usefulRows.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const p = (values, percent) => (values.length ? values[Math.floor((values.length - 1) * percent)] : null);
  const parsedAttempts = scoredRows.map((row) => rawAttemptsFromRow(row));
  const attemptedRows = parsedAttempts.filter((entry) => Array.isArray(entry.attempts));
  const selectedCandidate = candidateBackendForProfile(profile ?? scoredRows[0]?.profile ?? null);
  const renderedBackendRate =
    scoredRows.length && attemptedRows.length === scoredRows.length
      ? attemptedRows.filter((entry) => entry.attempts.some((attempt) => String(attempt?.backend ?? '').toLowerCase() !== 'direct')).length / attemptedRows.length
      : null;
  const candidateInvocationRate =
    !selectedCandidate
      ? null
      : scoredRows.length && attemptedRows.length === scoredRows.length
        ? attemptedRows.filter((entry) => entry.attempts.some((attempt) => String(attempt?.backend ?? '').toLowerCase() === selectedCandidate)).length / attemptedRows.length
        : null;
  const candidateInvocationReason =
    !scoredRows.length
      ? 'no scored rows'
      : !selectedCandidate
        ? 'not applicable'
        : attemptedRows.length === scoredRows.length
          ? null
          : parsedAttempts.find((entry) => !Array.isArray(entry.attempts))?.reason ?? 'raw attempts unavailable';
  const sampledRows = scoredRows.filter((row) => Number.isFinite(Number(row?.sampledMemoryMiB)) || Number.isFinite(Number(row?.sampledCpuMilli)));
  const sampledMemoryMiB = numericMax(sampledRows, 'sampledMemoryMiB');
  const sampledCpuMilli = numericMax(sampledRows, 'sampledCpuMilli');
  const resourceCoverage = {
    scoredRows: scoredRows.length,
    sampledRows: sampledRows.length,
    memorySamples: sampleCoverage(sampledRows, 'sampledMemoryMiB'),
    cpuSamples: sampleCoverage(sampledRows, 'sampledCpuMilli'),
    reason: scoredRows.length ? (sampledRows.length ? null : 'resource samples unavailable') : 'no scored rows',
  };
  return {
    requests: total,
    observedRequests: rows.length,
    passed,
    matchedQualityCount: passed,
    falseSuccesses,
    falsePositiveCount: falseSuccesses,
    timedOut,
    cleanupUnconfirmed,
    timeoutInclusiveCount: total,
    timeoutExclusiveCount: evaluableRows.length,
    completeContentPassRate: scoredRows.length ? passed / scoredRows.length : null,
    falseSuccessRate: scoredRows.length ? falseSuccesses / scoredRows.length : null,
    latencyMs: { p50: p(inclusiveLatency, 0.5), p95: p(inclusiveLatency, 0.95) },
    usefulLatencyMs: { p50: p(usefulLatency, 0.5), p95: p(usefulLatency, 0.95) },
    deadlinePenalizedTimeMs: scoredRows.length ? scoredRows.reduce((sum, row) => sum + (row.usefulContent ? row.elapsedMs : 60_000), 0) : null,
    candidateInvocationRate,
    candidateInvocationReason,
    renderedBackendRate,
    sampledMemoryMiB,
    sampledCpuMilli,
    resourceCoverage,
  };
}


function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function bootstrapInterval(values, seed, iterations = 2000) {
  if (!values.length) return { estimate: null, low: null, high: null, samples: 0 };
  const rng = seededRandom(seed);
  const draws = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let total = 0;
    for (let j = 0; j < values.length; j += 1) {
      total += values[Math.floor(rng() * values.length)];
    }
    draws[i] = total / values.length;
  }
  draws.sort((a, b) => a - b);
  const lower = draws[Math.floor((draws.length - 1) * 0.025)];
  const upper = draws[Math.floor((draws.length - 1) * 0.975)];
  return { estimate: mean(values), low: lower, high: upper, samples: values.length };
}

function clusterRowsByCase(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.caseId;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  return [...grouped.entries()].map(([caseId, clusterRows]) => {
    const usefulRows = clusterRows.filter((row) => row.usefulContent);
    return {
      caseId,
      quality: mean(clusterRows.map((row) => (row.usefulContent ? 1 : 0))),
      falseSuccessRate: mean(clusterRows.map((row) => (row.falseSuccess ? 1 : 0))),
      usefulLatencyMs: mean(usefulRows.map((row) => row.elapsedMs)),
      latencyMs: mean(clusterRows.map((row) => row.elapsedMs)),
    };
  });
}

function compareProfileToBaseline({ profileRows, baselineRows, seed }) {
  const profileClusters = clusterRowsByCase(profileRows);
  const baselineClusters = new Map(clusterRowsByCase(baselineRows).map((row) => [row.caseId, row]));
  const shared = profileClusters.filter((row) => baselineClusters.has(row.caseId));
  const qualityDiffs = [];
  const falseSuccessDiffs = [];
  const usefulLatencyDiffs = [];
  for (const profileCluster of shared) {
    const baselineCluster = baselineClusters.get(profileCluster.caseId);
    if (profileCluster.quality !== null && baselineCluster.quality !== null) {
      qualityDiffs.push(profileCluster.quality - baselineCluster.quality);
    }
    if (profileCluster.falseSuccessRate !== null && baselineCluster.falseSuccessRate !== null) {
      falseSuccessDiffs.push(profileCluster.falseSuccessRate - baselineCluster.falseSuccessRate);
    }
    if (profileCluster.usefulLatencyMs !== null && baselineCluster.usefulLatencyMs !== null) {
      usefulLatencyDiffs.push(profileCluster.usefulLatencyMs - baselineCluster.usefulLatencyMs);
    }
  }
  return {
    matchedCases: shared.length,
    quality: bootstrapInterval(qualityDiffs, seed + 1),
    falseSuccessRate: bootstrapInterval(falseSuccessDiffs, seed + 2),
    usefulLatencyMs: bootstrapInterval(usefulLatencyDiffs, seed + 3),
  };
}

function computeFrontier(summaries) {
  const candidates = summaries
    .filter((summary) => summary.suite === 'heldout' && summary.phase === 'measure' && summary.configVariant === 'tuned')
    .filter(
      (summary) =>
        Number.isFinite(summary.completeContentPassRate) &&
        Number.isFinite(summary.falseSuccessRate) &&
        Number.isFinite(summary.usefulLatencyMs?.p95) &&
        Number.isFinite(summary.sampledMemoryMiB) &&
        Number.isFinite(summary.sampledCpuMilli),
    )
    .map((summary) => ({
      profile: summary.profile,
      configVariant: summary.configVariant,
      completeContentPassRate: summary.completeContentPassRate,
      falseSuccessRate: summary.falseSuccessRate,
      usefulLatencyP95Ms: summary.usefulLatencyMs.p95,
      sampledMemoryMiB: summary.sampledMemoryMiB,
      sampledCpuMilli: summary.sampledCpuMilli,
      requests: summary.requests,
    }));
  const dominates = (a, b) => {
    const aLatency = a.usefulLatencyP95Ms ?? Number.POSITIVE_INFINITY;
    const bLatency = b.usefulLatencyP95Ms ?? Number.POSITIVE_INFINITY;
    return (
      a.completeContentPassRate >= b.completeContentPassRate &&
      a.falseSuccessRate <= b.falseSuccessRate &&
      aLatency <= bLatency &&
      a.sampledMemoryMiB <= b.sampledMemoryMiB &&
      (a.completeContentPassRate > b.completeContentPassRate ||
        a.falseSuccessRate < b.falseSuccessRate ||
        aLatency < bLatency ||
        a.sampledMemoryMiB < b.sampledMemoryMiB)
    );
  };
  return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && dominates(other, candidate)));
}

async function writePrepareArtifacts({ benchmarkPath, runDir, composeTemplatePath }) {
  const benchmark = await loadBenchmark(benchmarkPath);
  const corpus = corpusFromBenchmark(benchmark);
  const templatePath = composeTemplatePath ?? join(dirname(benchmarkPath), 'compose.yaml');
  const template = await loadComposeTemplate(templatePath);
  const sourceHashes = await hashSourceFiles(dirname(dirname(dirname(resolve(benchmarkPath)))));
  const runId = basename(resolve(runDir));
  const frozen = {
    schemaVersion: 1,
    runId,
    benchmarkPath: resolve(benchmarkPath),
    composeTemplatePath: resolve(templatePath),
    benchmark,
    hashes: {
      benchmark: hashObject(benchmark),
      corpus: corpusSha256(JSON.stringify({
        eligibility: corpus.eligibilityCases.map((entry) => entry.id),
        training: corpus.trainingCases.map((entry) => entry.id),
        test: corpus.testCases.map((entry) => entry.id),
        diagnostic: corpus.diagnosticCases.map((entry) => entry.id),
      })),
      composeTemplate: hashObject(template),
      source: sourceHashes.combined,
    },
    sourceHashes,
    corpus: {
      eligibilityCases: corpus.eligibilityCases.map((entry) => entry.id),
      trainingCases: corpus.trainingCases.map((entry) => entry.id),
      testCases: corpus.testCases.map((entry) => entry.id),
      diagnosticCases: corpus.diagnosticCases.map((entry) => entry.id),
    },
    profiles: benchmark.profiles.map((profile, index) => ({
      profile,
      port: profilePort(runId, index),
      project: composeProjectName(runId, profile),
      requiredBackends: requiredBackendsForProfile(profile),
      requiredServices: requiredServicesForProfile(profile),
      resources: resourceEnvelope(profile),
    })),
  };
  const fresh = await ensureFreshRunDir(runDir);
  if (!fresh) {
    const existing = JSON.parse(await readFile(manifestPaths(runDir).manifest, 'utf8'));
    if (existing.hashes?.benchmark !== frozen.hashes.benchmark || existing.hashes?.corpus !== frozen.hashes.corpus || existing.hashes?.composeTemplate !== frozen.hashes.composeTemplate || existing.hashes?.source !== frozen.hashes.source) {
      throw new Error(`refusing to resume mismatched run at ${runDir}`);
    }
    await ensureRunSecrets(runDir, existing.secretsHash ?? null);
    return existing;
  }
  const secrets = await ensureRunSecrets(runDir);
  frozen.secretsHash = secrets.hash;
  const paths = manifestPaths(runDir);
  await writeJson(paths.manifest, frozen);
  await writeJson(paths.schedule, planRounds(benchmark, corpus));
  await writeJson(join(runDir, 'corpus.json'), {
    eligibilityCases: corpus.eligibilityCases.map((entry) => entry.id),
    trainingCases: corpus.trainingCases.map((entry) => entry.id),
    testCases: corpus.testCases.map((entry) => entry.id),
    diagnosticCases: corpus.diagnosticCases.map((entry) => entry.id),
  });
  await writeFile(paths.requests, '');
  await writeFile(paths.resources, '');
  await writeFile(paths.events, '');
  await writeFile(paths.tuning, '');
  await writeFile(paths.selected, '');
  await writeFile(paths.reportJson, '');
  for (const row of benchmark.profiles.map((profile, index) => ({ profile, index }))) {
    const profileDir = join(runDir, 'compose', row.profile);
    await mkdir(profileDir, { recursive: true });
    await writeComposeProfile({
      templatePath,
      profile: row.profile,
      tuning: { browserTimeoutMs: 20_000, browserSettleMs: 0, browserSearchPort: profilePort(runId, row.index) },
      outPath: join(profileDir, 'common-default.json'),
      baseDir: dirname(resolve(templatePath)),
      runId,
    });
  }
  return frozen;
}

async function prepareRun({ benchmarkPath, runDir, composeTemplatePath, buildImages = true }) {
  runDir = resolve(runDir);
  const prepared = await writePrepareArtifacts({ benchmarkPath, runDir, composeTemplatePath });
  const manifest = JSON.parse(await readFile(manifestPaths(runDir).manifest, 'utf8'));
  if (buildImages) {
    const template = await loadComposeTemplate(manifest.composeTemplatePath);
    for (const profile of prepareBuildProfiles()) {
      const profileEntry = manifest.profiles.find((entry) => entry.profile === profile);
      if (!profileEntry) continue;
      const composePath = join('compose', profileEntry.profile, 'common-default.json');
      const composeOutPath = resolve(runDir, composePath);
      const logPath = resolve(runDir, 'artifacts', 'prepare', `${profileEntry.profile}.log`);
      await appendEvent(runDir, {
        phase: 'prepare',
        profile: profileEntry.profile,
        composePath,
        composeOutPath,
        kind: 'command-start',
        command: 'docker',
        args: composeArgs({ runDir, composeOutPath, project: profileEntry.project, args: ['build'] }),
        cwd: runDir,
        startedUtc: nowIso(),
        stdoutArtifact: logPath,
        stderrArtifact: logPath,
      });
      const result = await commandProbeStream('docker', composeArgs({ runDir, composeOutPath, project: profileEntry.project, args: ['build'] }), runDir, logPath);
      await appendEvent(runDir, { phase: 'prepare', profile: profileEntry.profile, composePath, composeOutPath, ...result });
      if (!result.ok) {
        throw new Error(`docker compose build failed for ${profileEntry.profile}: ${result.stderr || result.stdout}`.trim());
      }
    }
    const images = {};
    for (const [serviceName, service] of Object.entries(template.services ?? {})) {
      if (!service?.image || !service.build) continue;
      images[serviceName] = inspectDockerImageId(service.image);
    }
    const finalized = { ...manifest, images };
    await writeJson(manifestPaths(runDir).manifest, finalized);
    return finalized;
  }
  return manifest;
}


async function appendEvent(runDir, row) {
  await appendJsonl(manifestPaths(runDir).events, row);
}

async function appendRequest(runDir, row) {
  await appendJsonl(manifestPaths(runDir).requests, row);
}

async function appendTuning(runDir, row) {
  await appendJsonl(manifestPaths(runDir).tuning, row);
}

async function appendResource(runDir, row) {
  await appendJsonl(manifestPaths(runDir).resources, row);
}

async function recordResourceSnapshot(runDir, meta, sampled) {
  const timestamp = nowIso();
  const total = sumResourceSamples(sampled);
  for (const sample of sampled) {
    await appendResource(runDir, {
      ...meta,
      timestamp,
      container: sample.container,
      cpuMilli: sample.cpuMilli,
      memoryMiB: sample.memoryMiB,
      pids: sample.pids ?? 0,
      raw: sample.raw,
    });
  }
  await appendResource(runDir, {
    ...meta,
    timestamp,
    container: '__sum__',
    cpuMilli: total.cpuMilli,
    memoryMiB: total.memoryMiB,
    pids: total.pids,
    raw: {
      kind: 'sum',
      containerCount: Array.isArray(sampled) ? sampled.length : 0,
      containers: Array.isArray(sampled) ? sampled.map((sample) => sample.container) : [],
      cpuMilli: total.cpuMilli,
      memoryMiB: total.memoryMiB,
      pids: total.pids,
    },
  });
}

async function buildOrDeployProfile({ runDir, manifest, profile, config, buildImages = false }) {
  return await deployProfile({ runDir, manifest, profile, config, buildImages });
}
async function tuneRun({ runDir, baseUrl, token }) {
  runDir = resolve(runDir);
  const manifest = JSON.parse(await readFile(manifestPaths(runDir).manifest, 'utf8'));
  const benchmark = manifest.benchmark;
  const corpus = corpusFromBenchmark(benchmark);
  const tuningRows = [];
  const selected = [];


  for (const profile of benchmark.profiles) {
    const profileRows = [];
    for (const config of benchmark.tuningGrid) {
      const state = await buildOrDeployProfile({ runDir, manifest, profile, config });
      const sampled = sampleProjectResources(state.project, state.composeOutPath, runDir);
      const sampledTotals = sumResourceSamples(sampled);
      await recordResourceSnapshot(runDir, { profile, configId: config.id, phase: 'tune', runId: manifest.runId }, sampled);

      const preflightBefore = await runPreflightBatch({
        baseUrl: state.baseUrl,
        token,
        profile,
        config,
        cases: corpus.trainingCases,
        runDir,
        timeoutMs: benchmark.requestDeadlineMs,
        phase: 'tune-preflight-before',
      });
      for (const row of preflightBefore) {
        row.scored = false;
        row.phase = 'tune-preflight-before';
        row.sampledCpuMilli = sampledTotals.cpuMilli;
        row.sampledMemoryMiB = sampledTotals.memoryMiB;
        await appendRequest(runDir, row);
      }

      const eligibilityRows = await runEligibilityProbes({ baseUrl: state.baseUrl, token, profile, config, corpus, runDir, timeoutMs: benchmark.requestDeadlineMs, phase: 'tune-eligibility' });
      for (const row of eligibilityRows) {
        row.scored = false;
        row.sampledCpuMilli = sampledTotals.cpuMilli;
        row.sampledMemoryMiB = sampledTotals.memoryMiB;
        await appendRequest(runDir, row);
      }

      const eligibilityPassed = eligibilityRows.every(eligibilityProbePassed);
      if (!eligibilityPassed) {
        const summary = summarizeConfig(config.id, [], benchmark.requestDeadlineMs);
        summary.profile = profile;
        summary.eligibilityPassed = false;
        summary.eligibilityCount = eligibilityRows.length;
        summary.trainingRows = 0;
        summary.preflightBeforePassed = preflightBefore.every((row) => row.usefulContent && !row.falseSuccess);
        summary.preflightAfterPassed = false;
        profileRows.push(summary);
        tuningRows.push({ profile, ...summary });
        await appendTuning(runDir, { type: 'config', profile, configId: config.id, summary });
        await stopProfile(state);
        continue;
      }

      const trainingRows = [];
      for (let repetition = 1; repetition <= 2; repetition += 1) {
        const order = seededOrder(corpus.trainingCases, benchmark.seed, `training-${repetition}`);
        for (const caseDef of order) {
          const row = await runFetchCase({
            baseUrl: state.baseUrl,
            token,
            caseDef,
            backend: 'auto',
            profile,
            config,
            phase: 'tune',
            trialId: `${profile}:${config.id}:${caseDef.id}:r${repetition}`,
            repetition,
            round: repetition,
            timeoutMs: benchmark.requestDeadlineMs,
            runDir,
            sampled,
          });
          trainingRows.push(row);
          await appendRequest(runDir, row);
          if (row.timedOut || row.cleanupUnconfirmed) {
            await stopProfile(state);
            const recovered = await buildOrDeployProfile({ runDir, manifest, profile, config });
            state.project = recovered.project;
            state.composePath = recovered.composePath;
            state.baseUrl = recovered.baseUrl;
          }
        }
      }

      const preflightAfter = await runPreflightBatch({
        baseUrl: state.baseUrl,
        token,
        profile,
        config,
        cases: corpus.trainingCases,
        runDir,
        timeoutMs: benchmark.requestDeadlineMs,
        phase: 'tune-preflight-after',
      });
      for (const row of preflightAfter) {
        row.scored = false;
        row.sampledCpuMilli = sampledTotals.cpuMilli;
        row.sampledMemoryMiB = sampledTotals.memoryMiB;
        await appendRequest(runDir, row);
      }

      const summary = summarizeConfig(config.id, trainingRows, benchmark.requestDeadlineMs);
      summary.profile = profile;
      summary.eligibilityPassed = eligibilityRows.every(eligibilityProbePassed);
      summary.eligibilityCount = eligibilityRows.length;
      summary.trainingRows = trainingRows.length;
      summary.preflightBeforePassed = preflightBefore.every((row) => row.usefulContent && !row.falseSuccess);
      summary.preflightAfterPassed = preflightAfter.every((row) => row.usefulContent && !row.falseSuccess);
      profileRows.push(summary);
      tuningRows.push({ profile, ...summary });
      await appendTuning(runDir, { type: 'config', profile, configId: config.id, summary });
      await stopProfile(state);
    }

    const chosen = selectConfig(profileRows);
    selected.push({ profile, configId: chosen.configId, selected: chosen, selectedAtUtc: nowIso(), profiles: benchmark.profiles });
  }

  await writeJson(manifestPaths(runDir).selected, selected);
  return { tuningRows, selected };
}

async function runHoldoutBlock({ state, token, profile, config, corpus, benchmark, runDir, round, configVariant, sampled }) {
  const rows = [];
  const sampledTotals = sumResourceSamples(sampled);
  const preflightBefore = await runPreflightBatch({
    baseUrl: state.baseUrl,
    token,
    profile,
    config,
    cases: corpus.testCases,
    runDir,
    timeoutMs: benchmark.requestDeadlineMs,
    phase: `measure-preflight-before-${configVariant}`,
  });
  for (const row of preflightBefore) {
    row.scored = false;
    row.sampledCpuMilli = sampledTotals.cpuMilli;
    row.sampledMemoryMiB = sampledTotals.memoryMiB;
    await appendRequest(runDir, row);
  }
  const heldoutCases = seededOrder(corpus.testCases, benchmark.seed, `heldout-${round.round}`);
  for (const caseDef of heldoutCases) {
    const row = await runFetchCase({ baseUrl: state.baseUrl, token, caseDef, backend: 'auto', profile, config, phase: 'measure', trialId: `${profile}:${caseDef.id}:r${round.round}:${config.id}`, repetition: 1, round: round.round, timeoutMs: benchmark.requestDeadlineMs, runDir, sampled });
    row.configVariant = configVariant;
    row.commonDefault = configVariant === 'common-default';
    row.tuned = configVariant === 'tuned';
    rows.push(row);
    await appendRequest(runDir, row);
  }
  const preflightAfter = await runPreflightBatch({
    baseUrl: state.baseUrl,
    token,
    profile,
    config,
    cases: corpus.testCases,
    runDir,
    timeoutMs: benchmark.requestDeadlineMs,
    phase: `measure-preflight-after-${configVariant}`,
  });
  for (const row of preflightAfter) {
    row.scored = false;
    row.sampledCpuMilli = sampledTotals.cpuMilli;
    row.sampledMemoryMiB = sampledTotals.memoryMiB;
    await appendRequest(runDir, row);
  }
  return { rows, preflightBefore, preflightAfter };
}
async function measureRun({ runDir, baseUrl, token }) {
  runDir = resolve(runDir);
  const manifest = JSON.parse(await readFile(manifestPaths(runDir).manifest, 'utf8'));
  const benchmark = manifest.benchmark;
  const schedule = JSON.parse(await readFile(manifestPaths(runDir).schedule, 'utf8'));
  const selectedConfigs = JSON.parse(await readFile(manifestPaths(runDir).selected, 'utf8'));
  const corpus = corpusFromBenchmark(benchmark);
  const selectedByProfile = new Map(selectedConfigs.map((row) => [row.profile, row.configId]));
  const rows = [];
  for (const round of schedule.rounds) {
    for (const profile of round.profileOrder) {
      const selectedConfigId = selectedByProfile.get(profile);
      const commonDefault = benchmark.tuningGrid.find((entry) => entry.id === 't20000-s0');
      const tunedConfig = benchmark.tuningGrid.find((entry) => entry.id === selectedConfigId) ?? commonDefault;
      const variants = round.configOrder.map((configId) => ({ configId, config: configId === 'common-default' ? commonDefault : tunedConfig }));
      if (!variants[0].config || !variants[1].config) throw new Error(`missing config for ${profile}`);
      if (variants[0].config.id === variants[1].config.id) {
        const state = await buildOrDeployProfile({ runDir, manifest, profile, config: variants[0].config });
        const sampled = sampleProjectResources(state.project, state.composeOutPath, runDir);
        await recordResourceSnapshot(runDir, { profile, configId: variants[0].config.id, phase: 'measure', runId: manifest.runId, configVariant: 'common-default+tuned' }, sampled);
        const block = await runHoldoutBlock({ state, token, profile, config: variants[0].config, corpus, benchmark, runDir, round, configVariant: 'common-default+tuned', sampled });
        for (const row of block.rows) {
          row.pairedConfigVariants = ['common-default', 'tuned'];
          rows.push(row);
        }
        await stopProfile(state);
        continue;
      }
      for (const variant of variants) {
        const state = await buildOrDeployProfile({ runDir, manifest, profile, config: variant.config });
        const sampled = sampleProjectResources(state.project, state.composeOutPath, runDir);
        await recordResourceSnapshot(runDir, { profile, configId: variant.config.id, phase: 'measure', runId: manifest.runId, configVariant: variant.configId }, sampled);
        const block = await runHoldoutBlock({ state, token, profile, config: variant.config, corpus, benchmark, runDir, round, configVariant: variant.configId, sampled });
        await stopProfile(state);
        for (const row of block.rows) {
          row.pairedConfigVariants = round.configOrder;
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

async function diagnoseRun({ runDir, baseUrl, token, engine = null }) {
  runDir = resolve(runDir);
  const manifest = JSON.parse(await readFile(manifestPaths(runDir).manifest, 'utf8'));
  const benchmark = manifest.benchmark;
  const corpus = corpusFromBenchmark(benchmark);
  const selectedConfigs = JSON.parse(await readFile(manifestPaths(runDir).selected, 'utf8'));
  const selectedByProfile = new Map(selectedConfigs.map((row) => [row.profile, row]));
  const rows = [];
  const blockers = [];
  const specs = diagnosticTrackSpecs().filter((spec) => !engine || spec.backend === engine);
  for (const spec of specs) {
    const selected = selectedByProfile.get(spec.profile);
    if (!selected) {
      blockers.push({ ...spec, reason: `missing selected config for ${spec.profile}` });
      continue;
    }
    const config = benchmark.tuningGrid.find((entry) => entry.id === selected.configId) ?? benchmark.tuningGrid[0];
    try {
      const result = await runDiagnosticTrack({
        runDir,
        manifest,
        benchmark,
        corpus,
        profile: spec.profile,
        backend: spec.backend,
        track: spec.track,
        config,
        token,
      });
      rows.push(...result.rows);
    } catch (error) {
      blockers.push({ ...spec, profile: spec.profile, configId: config?.id ?? null, reason: String(error?.message ?? error) });
    }
  }

  const diagSummaryPath = resolve(runDir, 'diagnostics', 'engine', 'summary.json');
  await mkdir(dirname(diagSummaryPath), { recursive: true });
  await writeJson(diagSummaryPath, {
    runId: manifest.runId,
    controllerPid: process.pid,
    sampleCount: rows.length,
    blockerCount: blockers.length,
    blockers,
    tracks: specs.map((spec) => ({
      ...spec,
      selectedConfigId: selectedByProfile.get(spec.profile)?.configId ?? null,
      caps: diagnosticTrackCaps(spec.backend),
    })),
  });
  if (rows.length === 0 || blockers.length > 0) {
    const error = new Error(`diagnostics blocked: ${blockers.length} blockers, ${rows.length} samples`);
    error.blockers = blockers;
    throw error;
  }

  return rows;
}

function aggregateRows(rows) {
  const grouped = groupRows(rows);
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, group]) => {
    const [profile, suite, phase, configVariant] = key.split('|');
    const summary = summariseRows(group);
    return { profile, suite, phase, configVariant, ...summary };
  });
}

function formatReportValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '');
  }
  return String(value);
}

function formatReportTable(summaries) {
  const header = ['profile', 'suite', 'phase', 'configVariant', 'requests', 'passed', 'falseSuccesses', 'completePassRate', 'falseSuccessRate', 'latencyP50Ms', 'latencyP95Ms', 'usefulLatencyP50Ms', 'usefulLatencyP95Ms', 'deadlinePenalizedTimeMs', 'candidateInvocationRate'];
  const rows = summaries.map((summary) => [summary.profile, summary.suite, summary.phase, summary.configVariant, summary.requests, summary.passed, summary.falseSuccesses, summary.completeContentPassRate, summary.falseSuccessRate, summary.latencyMs.p50, summary.latencyMs.p95, summary.usefulLatencyMs.p50, summary.usefulLatencyMs.p95, summary.deadlinePenalizedTimeMs, summary.candidateInvocationRate].map(formatReportValue));
  const widths = header.map((name, index) => Math.max(name.length, ...rows.map((row) => row[index].length)));
  const render = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [render(header), render(widths.map((width) => '-'.repeat(width))), ...rows.map(render)].join('\n');
}
async function reportRun({ runDir }) {
  runDir = resolve(runDir);
  const manifest = JSON.parse(await readFile(manifestPaths(runDir).manifest, 'utf8'));
  const benchmark = manifest.benchmark;
  const requestsPath = manifestPaths(runDir).requests;
  const raw = await readFile(requestsPath, 'utf8');
  const requestRows = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.caseId);
  const selectedConfigs = JSON.parse(await readFile(manifestPaths(runDir).selected, 'utf8'));
  const summaries = aggregateRows(requestRows);
  const baselineHeldoutRows = requestRows.filter((row) => row.profile === 'baseline' && row.suite === 'heldout' && row.phase === 'measure' && row.configVariant === 'tuned');
  const confidenceIntervals = {
    method: 'cluster-bootstrap',
    resamples: 2000,
    baselineProfile: 'baseline',
    pairwise: selectedConfigs
      .filter((row) => row.profile !== 'baseline')
      .map((selected, index) => ({
        profile: selected.profile,
        configId: selected.configId,
        matchedCases: compareProfileToBaseline({
          profileRows: requestRows.filter((row) => row.profile === selected.profile && row.suite === 'heldout' && row.phase === 'measure' && row.configVariant === 'tuned'),
          baselineRows: baselineHeldoutRows,
          seed: benchmark.seed + index,
        }),
      })),
  };
  const frontier = computeFrontier(summaries);
  const json = {
    schemaVersion: 1,
    runId: basename(resolve(runDir)),
    requestCount: requestRows.length,
    trainingSelected: selectedConfigs,
    beforeAfterSelected: selectedConfigs,
    confidenceIntervals,
    frontier,
    profiles: summaries,
  };
  await writeJson(manifestPaths(runDir).reportJson, json);
  await writeJson(join(runDir, 'report-ci.json'), confidenceIntervals);
  await writeJson(join(runDir, 'report-frontier.json'), frontier);
  const csvLines = ['profile,suite,phase,configVariant,requests,passed,falseSuccesses,completeContentPassRate,falseSuccessRate,latencyP50Ms,latencyP95Ms,usefulLatencyP50Ms,usefulLatencyP95Ms,deadlinePenalizedTimeMs,candidateInvocationRate'];
  for (const summary of summaries) {
    csvLines.push([summary.profile, summary.suite, summary.phase, summary.configVariant, summary.requests, summary.passed, summary.falseSuccesses, summary.completeContentPassRate, summary.falseSuccessRate, summary.latencyMs.p50 ?? '', summary.latencyMs.p95 ?? '', summary.usefulLatencyMs.p50 ?? '', summary.usefulLatencyMs.p95 ?? '', summary.deadlinePenalizedTimeMs, summary.candidateInvocationRate ?? ''].join(','));
  }
  await writeFile(manifestPaths(runDir).reportCsv, `${csvLines.join('\n')}\n`);
  if (summaries.length) process.stdout.write(`${formatReportTable(summaries)}\n`);
  return { manifest: json, summaries, requestRows, selectedConfigs, confidenceIntervals, frontier };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'prepare') {
    if (!args.config || !args.out) throw new Error('prepare requires --config and --out');
    await prepareRun({ benchmarkPath: args.config, runDir: resolve(args.out), composeTemplatePath: args['compose-template'], buildImages: !args['no-build'] });
    return;
  }
  if (args.command === 'tune') {
    if (!args.run) throw new Error('tune requires --run');
    await tuneRun({ runDir: resolve(args.run), baseUrl: args['base-url'] ?? 'http://127.0.0.1:18088', token: process.env.BROWSER_SEARCH_API_KEY ?? '' });
    return;
  }
  if (args.command === 'measure') {
    if (!args.run) throw new Error('measure requires --run');
    await measureRun({ runDir: resolve(args.run), baseUrl: args['base-url'] ?? 'http://127.0.0.1:18088', token: process.env.BROWSER_SEARCH_API_KEY ?? '' });
    return;
  }
  if (args.command === 'diagnose') {
    if (!args.run) throw new Error('diagnose requires --run');
    await diagnoseRun({ runDir: resolve(args.run), baseUrl: args['base-url'] ?? 'http://127.0.0.1:18088', token: process.env.BROWSER_SEARCH_API_KEY ?? '', engine: args.engine ?? null });
    return;
  }
  if (args.command === 'report') {
    if (!args.run) throw new Error('report requires --run');
    await reportRun({ runDir: resolve(args.run) });
    return;
  }
  if (args.command === 'all') {
    if (!args.config || !args.out) throw new Error('all requires --config and --out');
    await prepareRun({ benchmarkPath: args.config, runDir: resolve(args.out), composeTemplatePath: args['compose-template'], buildImages: !args['no-build'] });
    await tuneRun({ runDir: resolve(args.out), baseUrl: args['base-url'] ?? 'http://127.0.0.1:18088', token: process.env.BROWSER_SEARCH_API_KEY ?? '' });
    await measureRun({ runDir: resolve(args.out), baseUrl: args['base-url'] ?? 'http://127.0.0.1:18088', token: process.env.BROWSER_SEARCH_API_KEY ?? '' });
    await diagnoseRun({ runDir: resolve(args.out), baseUrl: args['base-url'] ?? 'http://127.0.0.1:18088', token: process.env.BROWSER_SEARCH_API_KEY ?? '' });
    await reportRun({ runDir: resolve(args.out) });
    return;
  }
  throw new Error(`unknown command ${args.command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: String(error?.stack ?? '') }, null, 2));
    process.exitCode = 1;
  });
}

export {
  parseArgs,
  loadBenchmark,
  corpusFromBenchmark,
  planRounds,
  selectConfig,
  summarizeConfig,
  aggregateRows,
  reportRun,
  prepareRun,
  tuneRun,
  measureRun,
  diagnoseRun,
  runFetchCase,
  diagnosticTrackSpecs,
  diagnosticTrackCaps,
};
