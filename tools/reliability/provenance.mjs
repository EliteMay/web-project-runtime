const KNOWN_TRAILERS = new Set(['Interaction-Id', 'Development-Transaction', 'Workstream-Id', 'Producer']);

export const PROVENANCE_STATES = Object.freeze([
  'verified', 'declared', 'inferred', 'expected_external', 'unknown', 'conflicting',
]);

export const PRODUCER_VALUES = Object.freeze([
  'conversation', 'manual', 'automation', 'bot', 'unknown',
]);

const PRODUCER_SET = new Set(PRODUCER_VALUES);

function unique(values) {
  return [...new Set(values)];
}

function sameSet(left, right) {
  const a = unique(left).sort();
  const b = unique(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return unique(value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()));
}

export function parseProvenanceTrailers(message) {
  if (typeof message !== 'string') throw new Error('commit message must be a string.');
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  let index = lines.length - 1;
  while (index >= 0 && lines[index].trim() === '') index -= 1;

  const collected = [];
  for (; index >= 0; index -= 1) {
    const match = lines[index].match(/^([A-Za-z0-9-]+):\s*(.+)$/);
    if (!match) break;
    collected.push({ key: match[1], value: match[2].trim() });
  }

  collected.reverse();
  const result = { interactionIds: [], developmentTransactions: [], workstreamIds: [], producers: [], unknownTrailers: [] };
  for (const trailer of collected) {
    if (!KNOWN_TRAILERS.has(trailer.key)) {
      result.unknownTrailers.push(trailer);
      continue;
    }
    if (trailer.key === 'Interaction-Id') result.interactionIds.push(trailer.value);
    if (trailer.key === 'Development-Transaction') result.developmentTransactions.push(trailer.value);
    if (trailer.key === 'Workstream-Id') result.workstreamIds.push(trailer.value);
    if (trailer.key === 'Producer') result.producers.push(trailer.value);
  }
  result.interactionIds = unique(result.interactionIds);
  result.developmentTransactions = unique(result.developmentTransactions);
  result.workstreamIds = unique(result.workstreamIds);
  result.producers = unique(result.producers);
  return result;
}

export function classifyProvenance({ commitMessage, dataEvidence = null, expectedExternal = false, inferredSource = null }) {
  const claim = parseProvenanceTrailers(commitMessage);
  const hasLinkClaim = claim.interactionIds.length > 0 || claim.developmentTransactions.length > 0 || claim.workstreamIds.length > 0;
  const invalidProducer = claim.producers.find((producer) => !PRODUCER_SET.has(producer));

  if (invalidProducer) return { classification: 'conflicting', reasonCode: 'producer-invalid', claim };
  if (!hasLinkClaim) {
    if (expectedExternal) return { classification: 'expected_external', reasonCode: 'expected-external-evidence', claim };
    if (inferredSource) return { classification: 'inferred', reasonCode: 'source-inferred-without-direct-link', claim };
    return { classification: 'unknown', reasonCode: 'provenance-missing', claim };
  }
  if (!dataEvidence || dataEvidence.commitLinked === null || dataEvidence.commitLinked === undefined) {
    return { classification: 'declared', reasonCode: 'commit-claim-awaiting-data-verification', claim };
  }
  if (dataEvidence.commitLinked !== true) return { classification: 'conflicting', reasonCode: 'data-evidence-does-not-link-commit', claim };

  const interactionIds = normalizeArray(dataEvidence.interactionIds);
  const transactionIds = normalizeArray(dataEvidence.developmentTransactions);
  const workstreamIds = normalizeArray(dataEvidence.workstreamIds);
  if (claim.interactionIds.length > 0 && !sameSet(claim.interactionIds, interactionIds)) return { classification: 'conflicting', reasonCode: 'interaction-id-mismatch', claim };
  if (claim.developmentTransactions.length > 0 && !sameSet(claim.developmentTransactions, transactionIds)) return { classification: 'conflicting', reasonCode: 'transaction-id-mismatch', claim };
  if (claim.workstreamIds.length > 0 && !sameSet(claim.workstreamIds, workstreamIds)) return { classification: 'conflicting', reasonCode: 'workstream-id-mismatch', claim };
  return { classification: 'verified', reasonCode: 'bidirectional-evidence-matched', claim };
}
