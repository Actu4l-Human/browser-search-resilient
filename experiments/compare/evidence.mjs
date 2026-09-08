import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

export function redactCommandArgs(args) {
  const out = [];
  const redactedFlags = new Set(['--env-file', '--token', '--password', '--secret', '-e']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    out.push(arg);
    if (redactedFlags.has(arg) && index + 1 < args.length) {
      out.push('<redacted>');
      index += 1;
    }
  }
  return out;
}

export function evidenceRow({
  runId,
  profile,
  backend = null,
  suite,
  caseId,
  configId,
  phase,
  trialId,
  repetition,
  round,
  startedUtc,
  completedUtc,
  elapsedMs,
  availability,
  scored,
  expected,
  transportError,
  timedOut,
  cleanupUnconfirmed,
  response,
  attempts,
  rawHttpText,
  rawHttpStatus,
  rawHttpHeaders,
  sampledMemoryMiB,
  sampledCpuMilli,
}) {
  const row = {
    runId,
    profile,
    backend,
    suite,
    caseId,
    configId,
    phase,
    trialId,
    repetition,
    round,
    startedUtc,
    completedUtc,
    elapsedMs,
    availability,
    scored,
    expected,
  };

  if (transportError !== undefined) row.transportError = transportError;
  if (timedOut !== undefined) row.timedOut = timedOut;
  if (cleanupUnconfirmed !== undefined) row.cleanupUnconfirmed = cleanupUnconfirmed;
  if (response !== undefined) row.response = response;
  if (attempts !== undefined) row.attempts = attempts;
  if (rawHttpText !== undefined) {
    row.rawHttpText = rawHttpText;
    row.rawHttpSha256 = rawHttpText === null ? null : sha256(rawHttpText);
  }
  if (rawHttpStatus !== undefined) row.rawHttpStatus = rawHttpStatus;
  if (rawHttpHeaders !== undefined) row.rawHttpHeaders = rawHttpHeaders;
  if (sampledMemoryMiB !== undefined) row.sampledMemoryMiB = sampledMemoryMiB;
  if (sampledCpuMilli !== undefined) row.sampledCpuMilli = sampledCpuMilli;

  return row;
}

export async function appendJsonl(path, row) {
  await appendFile(path, `${JSON.stringify(row)}\n`);
}

export function commandObservation({
  command,
  args,
  cwd,
  exitCode,
  stdout,
  stderr,
  startedUtc,
  completedUtc,
  elapsedMs,
}) {
  return {
    kind: 'command',
    command,
    args: redactCommandArgs(args),
    cwd,
    exitCode,
    stdout,
    stderr,
    startedUtc,
    completedUtc,
    elapsedMs,
  };
}
