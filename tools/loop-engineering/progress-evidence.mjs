// An independent verifier is the only source of progress evidence. Worker prose,
// a new candidate commit, or a changed error signature is never enough.
const permittedStatuses = new Set(['pass', 'fail', 'uncertain', 'not_run']);

export function summarizeVerifierChecks(receipt) {
  const checks = receipt?.verification?.checks;
  if (!Array.isArray(checks) || checks.length === 0) return null;
  const names = new Set();
  const summary = [];
  for (const check of checks) {
    if (!check || typeof check.name !== 'string' || !check.name.trim() ||
        !permittedStatuses.has(check.status) || names.has(check.name)) return null;
    names.add(check.name);
    summary.push({ name: check.name, status: check.status });
  }
  return summary.sort((a, b) => a.name.localeCompare(b.name));
}

export function evidenceBasedProgress(previousAttempt, receipt) {
  if (receipt?.finalState === 'passed') return true;
  if (!previousAttempt || previousAttempt.verificationStatus !== 'fail' ||
      receipt?.finalState !== 'failed' || receipt?.verification?.status !== 'fail' ||
      receipt?.verification?.protected !== true ||
      receipt?.verification?.workerTreeCleanAfterVerification !== true ||
      !receipt?.repositoryEvidence?.candidateCommit ||
      // A failed required check is expected during partial improvement.
      // All *other* unresolved items remain blockers, not progress.
      (receipt?.unresolvedItems ?? []).some(item =>
        !String(item).startsWith('missing_verification_requirements:'))) return false;

  const before = previousAttempt.verificationChecks;
  const after = summarizeVerifierChecks(receipt);
  if (!Array.isArray(before) || !after || before.length === 0 || before.length !== after.length) return false;

  const oldStatuses = new Map();
  for (const check of before) {
    if (!check || typeof check.name !== 'string' || oldStatuses.has(check.name) ||
        !permittedStatuses.has(check.status)) return false;
    oldStatuses.set(check.name, check.status);
  }

  let fixedFailures = 0;
  for (const check of after) {
    const old = oldStatuses.get(check.name);
    if (old === undefined || !['pass', 'fail'].includes(check.status)) return false;
    // Previously passing checks must remain passing. A previously failing check
    // can only remain failed or become passing, never vanish or become unverified.
    if (old === 'pass' && check.status !== 'pass') return false;
    if (old !== 'pass' && old !== 'fail') return false;
    if (old === 'fail' && check.status === 'pass') fixedFailures++;
  }
  return fixedFailures > 0;
}

export function consecutiveNoProgress(attempts) {
  let count = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].meaningfulProgress === true) break;
    count++;
  }
  return count;
}
