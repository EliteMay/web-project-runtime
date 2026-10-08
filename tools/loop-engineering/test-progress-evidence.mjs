import assert from 'node:assert/strict';
import { summarizeVerifierChecks, evidenceBasedProgress, consecutiveNoProgress } from './progress-evidence.mjs';

const checks = entries => entries.map(([name, status]) => ({ name, status }));
const previous = {
  verificationStatus: 'fail',
  verificationChecks: checks([['syntax', 'pass'], ['unit', 'fail'], ['integration', 'fail']])
};
const receipt = (items, overrides = {}) => ({
  finalState: 'failed',
  verification: {
    status: 'fail',
    protected: true,
    workerTreeCleanAfterVerification: true,
    checks: checks(items)
  },
  repositoryEvidence: { candidateCommit: 'candidate' },
  unresolvedItems: [],
  ...overrides
});
const unchanged = receipt([['syntax', 'pass'], ['unit', 'fail'], ['integration', 'fail']]);
assert.equal(evidenceBasedProgress(null, unchanged), false);
assert.equal(evidenceBasedProgress(previous, unchanged), false);

const improved = receipt([['syntax', 'pass'], ['unit', 'pass'], ['integration', 'fail']]);
assert.equal(evidenceBasedProgress(previous, improved), true);

// Failure churn and renaming/deleting an acceptance check do not prove progress.
assert.equal(evidenceBasedProgress(previous, receipt([
  ['syntax', 'pass'], ['unit', 'pass'], ['different-integration', 'fail']
])), false);
assert.equal(evidenceBasedProgress(previous, receipt([
  ['syntax', 'pass'], ['unit', 'pass']
])), false);
assert.equal(evidenceBasedProgress(previous, receipt([
  ['syntax', 'pass'], ['unit', 'pass'], ['integration', 'not_run']
])), false);
assert.equal(evidenceBasedProgress(previous, receipt([
  ['syntax', 'fail'], ['unit', 'pass'], ['integration', 'fail']
])), false);

// No weaker proof can substitute for an independent, clean verifier.
assert.equal(evidenceBasedProgress(previous, receipt(improved.verification.checks.map(x => [x.name, x.status]), {
  verification: { ...improved.verification, protected: false }
})), false);
assert.equal(evidenceBasedProgress(previous, receipt(improved.verification.checks.map(x => [x.name, x.status]), {
  repositoryEvidence: { candidateCommit: null }
})), false);
assert.equal(evidenceBasedProgress(previous, receipt(improved.verification.checks.map(x => [x.name, x.status]), {
  unresolvedItems: ['scope_violation']
})), false);
assert.equal(evidenceBasedProgress(previous, receipt([
  ['syntax', 'pass'], ['unit', 'pass'], ['unit', 'fail']
])), false);
assert.equal(summarizeVerifierChecks(receipt([['syntax', 'pass'], ['syntax', 'fail']])), null);

assert.equal(evidenceBasedProgress(previous, { finalState: 'passed' }), true);
assert.equal(consecutiveNoProgress([
  { meaningfulProgress: false }, { meaningfulProgress: false }
]), 2);
assert.equal(consecutiveNoProgress([
  { meaningfulProgress: false }, { meaningfulProgress: true }, { meaningfulProgress: false }
]), 1);
console.log('Loop Engineering progress evidence tests passed.');
