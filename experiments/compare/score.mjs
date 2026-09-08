export function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(value, maxCharacters) {
  const text = String(value ?? '');
  if (!Number.isFinite(maxCharacters) || maxCharacters < 0) return text;
  return text.length <= maxCharacters ? text : text.slice(0, maxCharacters);
}

export function dedupeLinks(links) {
  const seen = new Set();
  const out = [];
  for (const link of Array.isArray(links) ? links : []) {
    const url = String(link?.url ?? '').trim();
    if (!url) continue;
    const text = normalizeWhitespace(link?.text ?? '');
    const key = `${url}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, url });
  }
  return out;
}

function includesAll(haystack, needles) {
  const lower = haystack.toLowerCase();
  return needles.every((needle) => lower.includes(String(needle).toLowerCase()));
}

function includesAny(haystack, needles) {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(String(needle).toLowerCase()));
}

function requiredLinkSeen(links, requiredLinks = []) {
  if (!requiredLinks.length) return true;
  return requiredLinks.every((required) => links.some((link) => String(link.url ?? '').startsWith(required)));
}

export function scoreResponse(caseDef, envelope) {
  const response = envelope?.response ?? envelope ?? {};
  const status = String(response?.status ?? 'failed');
  const result = response?.result ?? {};
  const title = normalizeWhitespace(result?.title ?? '');
  const finalUrl = String(result?.finalUrl ?? result?.url ?? '');
  const content = normalizeWhitespace(result?.content ?? '');
  const links = dedupeLinks(result?.links ?? []);
  const terminalOutcome = String(result?.outcome ?? '');
  const expectedTitle = String(caseDef?.expectedTitle ?? '');
  const expectedFinalUrl = caseDef?.expectedFinalUrl ? String(caseDef.expectedFinalUrl) : '';
  const requiredMarkers = Array.isArray(caseDef?.requiredMarkers) ? caseDef.requiredMarkers : [];
  const forbiddenMarkers = Array.isArray(caseDef?.forbiddenMarkers) ? caseDef.forbiddenMarkers : [];
  const requiredBodyPhrases = Array.isArray(caseDef?.requiredBodyPhrases) ? caseDef.requiredBodyPhrases : [];
  const requiredLinks = Array.isArray(caseDef?.requiredLinks) ? caseDef.requiredLinks : [];
  const requiresManualReview = Boolean(caseDef?.manualReviewRequired);

  const successfulTerminal = status === 'success';
  const contentHasMarkers = requiredMarkers.length === 0 || includesAll(content, requiredMarkers);
  const bodyHasPhrases = requiredBodyPhrases.length === 0 || includesAll(content, requiredBodyPhrases);
  const titleMatches = !expectedTitle || title.toLowerCase().includes(expectedTitle.toLowerCase());
  const finalUrlMatches = !expectedFinalUrl || finalUrl === expectedFinalUrl;
  const forbiddenAbsent = forbiddenMarkers.length === 0 || !includesAny(`${title}\n${content}`, forbiddenMarkers);
  const linkOk = requiredLinkSeen(links, requiredLinks);

  let passed = successfulTerminal && contentHasMarkers && bodyHasPhrases && linkOk && forbiddenAbsent && titleMatches && finalUrlMatches;
  let usefulContent = passed;
  let reason = passed ? null : 'content_mismatch';

  if (caseDef?.expectedTerminalOutcome) {
    passed = terminalOutcome === caseDef.expectedTerminalOutcome && status === 'failed';
    usefulContent = false;
    reason = passed ? null : 'terminal_outcome_mismatch';
  } else if (caseDef?.kind === 'live') {
    // Live pages are automatically scored on the body/link contract. The title
    // and final URL are still required, but the case remains a content check.
    passed = successfulTerminal && bodyHasPhrases && linkOk && titleMatches && finalUrlMatches;
    usefulContent = passed;
    reason = passed ? null : 'live_content_mismatch';
  } else if (caseDef?.kind === 'redirect') {
    passed = successfulTerminal && contentHasMarkers && bodyHasPhrases && titleMatches && finalUrlMatches && linkOk && forbiddenAbsent;
    usefulContent = passed;
    reason = passed ? null : 'redirect_mismatch';
  } else if (caseDef?.kind === 'diagnostic' || caseDef?.kind === 'fixture') {
    passed = successfulTerminal && contentHasMarkers && bodyHasPhrases && titleMatches && finalUrlMatches && linkOk && forbiddenAbsent;
    usefulContent = passed;
    reason = passed ? null : 'fixture_mismatch';
  }

  const falseSuccess = successfulTerminal && !passed;
  return {
    passed,
    falseSuccess,
    usefulContent,
    reason,
    manualReviewRequired: requiresManualReview,
    responseStatus: status,
    terminalOutcome,
    title,
    finalUrl,
    linkCount: links.length,
    links,
    content,
    requiredMarkers,
    forbiddenMarkers,
    requiredBodyPhrases,
    requiredLinks,
  };
}
