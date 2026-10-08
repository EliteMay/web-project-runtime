import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Defense in depth for an independently owned Phase B verify callback.
// This is a deterministic Git diff gate, NOT an OS sandbox and NOT a semantic
// proof. The actual acceptance checks must live outside worker write access.
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error('PILOT_GIT_EVIDENCE_UNAVAILABLE');
  return result.stdout;
}

function matchesScope(file, scopes) {
  return scopes.some(scope => typeof scope === 'string' &&
    (scope.endsWith('/') ? file.startsWith(scope) : file === scope));
}

function check(name, status, evidence) {
  return { name, status, evidence };
}

export function assessCandidateDiff({
  worktreeDir, baseCommit, candidateCommit, allowedPaths,
  protectedPaths = [], maxChangedFiles = 3, maxDiffLines = 160
}) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 ||
      !Array.isArray(protectedPaths) ||
      ![maxChangedFiles, maxDiffLines].every(n => Number.isSafeInteger(n) && n > 0) ||
      ![...allowedPaths, ...protectedPaths].every(p =>
        typeof p === 'string' && p.length > 0 && !p.startsWith('/') &&
        !p.includes('..') && !p.includes('\\') && !p.includes('*'))) {
    throw new Error('PILOT_INVALID_OPERATOR_SCOPE');
  }
  if (![baseCommit, candidateCommit].every(x => /^[a-f0-9]{40}$/.test(x))) {
    throw new Error('PILOT_INVALID_COMMIT_ID');
  }
  const root = fs.realpathSync.native(worktreeDir);
  const parent = git(root, ['rev-parse', candidateCommit + '^']).trim();
  const linear = parent === baseCommit;
  const rows = git(root, ['diff', '--name-status', '-z', '--no-renames', baseCommit, candidateCommit])
    .split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < rows.length; i += 2) {
    if (!rows[i + 1] || !/^[A-Z]$/.test(rows[i])) throw new Error('PILOT_INVALID_DIFF_FORMAT');
    changes.push({ status: rows[i], file: rows[i + 1] });
  }

  let totalDiffLines = 0;
  let binary = false;
  const numstats = git(root, ['diff', '--numstat', '-z', '--no-renames', baseCommit, candidateCommit])
    .split('\0').filter(Boolean);
  for (const row of numstats) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(row);
    if (!match) throw new Error('PILOT_INVALID_NUMSTAT');
    if (match[1] === '-' || match[2] === '-') binary = true;
    else totalDiffLines += Number(match[1]) + Number(match[2]);
  }

  const onlyAddOrModify = changes.every(item => ['A', 'M'].includes(item.status));
  const scopesValid = changes.length > 0 && changes.every(({file}) =>
    matchesScope(file, allowedPaths) && !matchesScope(file, protectedPaths));
  const withinBudget = changes.length > 0 && changes.length <= maxChangedFiles &&
    totalDiffLines <= maxDiffLines && !binary;

  let regularFiles = true;
  for (const {file} of changes) {
    const tree = git(root, ['ls-tree', '-z', candidateCommit, '--', file]).trim();
    // Reject symlinks, submodules and changed file types. In a fully isolated
    // pilot, regular executable files are still a separate security concern.
    if (!/^10064[04] blob [0-9a-f]{40}\t/.test(tree)) regularFiles = false;
  }

  const checks = [
    check('guard/linear-parent', linear ? 'pass' : 'fail', 'baseline-parent-match=' + linear),
    check('guard/allowed-scope', scopesValid ? 'pass' : 'fail', 'changed-files=' + changes.length),
    check('guard/no-delete', onlyAddOrModify ? 'pass' : 'fail', 'delete-rename-typechange-denied'),
    check('guard/diff-budget', withinBudget ? 'pass' : 'fail',
      'files=' + changes.length + ',diff-lines=' + totalDiffLines + ',binary=' + binary),
    check('guard/regular-files', regularFiles ? 'pass' : 'fail', 'regular-file-modes-only')
  ];
  return { status: checks.every(x => x.status === 'pass') ? 'pass' : 'fail', checks, changes };
}

// The trusted operator supplies a fixed, separately protected acceptance
// callback. The worker cannot select tests, status labels or requirement IDs.
// runAcceptance should execute in a separately restricted process/OS sandbox.
export function createPilotVerifier({ allowedPaths, protectedPaths = [],
  maxChangedFiles = 3, maxDiffLines = 160, runAcceptance
}) {
  if (typeof runAcceptance !== 'function') throw new Error('PILOT_ACCEPTANCE_REQUIRED');
  const frozenAllowed = Object.freeze([...allowedPaths]);
  const frozenProtected = Object.freeze([...protectedPaths]);
  return async function verify(context) {
    const { requiredRequirements = [], policy = {} } = context;
    const fixedNames = [...new Set([
      ...(policy.verification?.requiredChecks ?? []), ...requiredRequirements
    ])];
    const diff = assessCandidateDiff({
      worktreeDir: context.worktreeDir, baseCommit: context.baseCommit,
      candidateCommit: context.candidateCommit, allowedPaths: frozenAllowed,
      protectedPaths: frozenProtected, maxChangedFiles, maxDiffLines
    });
    if (diff.status !== 'pass') {
      return { status: 'fail', satisfiedRequirements: [], checks: diff.checks };
    }
    try {
      // This callback and its fixtures MUST be inaccessible to the worker.
      const raw = await runAcceptance(context);
      const returned = Array.isArray(raw) ? raw : [];
      const names = returned.map(x => x?.name);
      const consistent = fixedNames.length > 0 &&
        returned.length === fixedNames.length &&
        new Set(names).size === fixedNames.length &&
        fixedNames.every(name => names.includes(name));
      const valid = consistent && returned.every(x =>
        x.status === 'pass' && typeof x.evidence === 'string' &&
        x.evidence.trim().length > 0);
      const checks = valid ? returned : [
        check('guard/acceptance-evidence', 'fail', 'missing-failing-or-untrusted-acceptance')
      ];
      return {
        status: valid ? 'pass' : 'fail',
        satisfiedRequirements: valid ? [...requiredRequirements] : [],
        checks: [...diff.checks, ...checks]
      };
    } catch {
      return {
        status: 'uncertain', satisfiedRequirements: [],
        checks: [...diff.checks,
          check('guard/acceptance-unavailable', 'uncertain', 'protected-verifier-exception')]
      };
    }
  };
}
