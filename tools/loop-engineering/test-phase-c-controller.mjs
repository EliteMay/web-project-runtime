import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPhaseCLoop } from './phase-c-controller.mjs';
import { requestPhaseCControl } from './phase-c-control.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

const schema = {
  type: 'object',
  additionalProperties: true,
  required: ['policyVersion', 'loopId', 'repository', 'goal', 'scope', 'trigger', 'verification', 'budget', 'permissions', 'progress', 'stop'],
  properties: {
    policyVersion: { type: 'string', const: '1' },
    loopId: { type: 'string', minLength: 1 },
    repository: { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' },
    autonomyLevel: { type: 'string' },
    goal: { type: 'object' },
    scope: { type: 'object' },
    trigger: { type: 'object' },
    verification: { type: 'object' },
    budget: { type: 'object' },
    permissions: { type: 'object' },
    progress: { type: 'object' },
    stop: { type: 'object' }
  }
};

const basePolicy = {
  policyVersion: '1',
  loopId: 'phase-c-test',
  repository: 'Owner/repo',
  autonomyLevel: 'L1_WORKTREE',
  goal: { statement: 'Complete one task safely.', completionCriteria: ['task completed', 'verification passed'] },
  scope: {
    workingBranchPolicy: 'isolated_worktree',
    allowedPaths: ['src/**', 'README.md'],
    protectedPaths: ['tests/acceptance/**', '.github/workflows/**'],
    requiredSources: ['README.md', 'REQUIREMENTS.md', 'PROJECT_LEARNINGS.md']
  },
  trigger: { type: 'queue', source: 'formal-work-queue' },
  verification: {
    minimumLevel: 'V3_RUNTIME',
    protected: true,
    requiredChecks: ['static validation', 'runtime check'],
    evidenceRequired: true,
    allowWorkerToModifyVerifier: false
  },
  budget: {
    maxIterations: 4,
    maxSameFailure: 2,
    maxParallelWorkers: 1,
    maxWallClockMinutes: null,
    maxModelTokens: null,
    maxExternalCost: null,
    costCurrency: null
  },
  permissions: {
    repositoryRead: true,
    workingBranchWrite: true,
    commit: true,
    pushWorkingBranch: false,
    defaultBranchWrite: false,
    merge: false,
    deploy: false,
    externalNetwork: false,
    secretAccess: false
  },
  progress: {
    detectSameFailure: true,
    requireMeaningfulDelta: true,
    signatureInputs: ['error_category', 'normalized_message', 'failing_checks', 'affected_area', 'blocker']
  },
  stop: {
    successWhen: ['required verification passed'],
    escalateWhen: ['verifier_uncertain'],
    terminalStates: ['passed', 'failed', 'stuck', 'blocked', 'budget_exhausted', 'escalated', 'cancelled']
  }
};

function createTask(revision) {
  const now = '2026-09-17T00:00:00Z';
  return {
    schemaVersion: 1,
    taskId: 'task-alpha',
    repository: 'Owner/repo',
    sourceRequirements: { path: 'REQUIREMENTS.md', revisionType: 'blobSha', revision },
    generationRevision: 1,
    title: 'Implement alpha',
    scope: 'Write src/result.txt',
    dependencies: [],
    completionCriteria: ['src/result.txt exists'],
    validationRequirements: ['task deterministic test'],
    status: 'queued',
    priority: 100,
    role: 'preparation',
    assignedLane: null,
    assignmentRevision: 1,
    safeParallel: false,
    publicSummary: 'alpha task',
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
}

function createFixture(policyOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-phase-c-'));
  const repoRoot = path.join(root, 'target');
  const dataRoot = path.join(root, 'data');
  const queueDir = path.join(dataRoot, 'work-queues', 'Owner--repo');
  const runDir = path.join(dataRoot, 'loop-runs', 'Owner--repo', 'phase-c-test');
  const policyPath = path.join(root, 'policy.json');
  const schemaPath = path.join(root, 'schema.json');

  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'REQUIREMENTS.md'), '# requirements\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'PROJECT_LEARNINGS.md'), '# learnings\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'base.txt'), 'base\n', 'utf8');
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'phase-c@example.invalid']);
  git(repoRoot, ['config', 'user.name', 'Phase C Test']);
  git(repoRoot, ['remote', 'add', 'origin', 'https://github.com/Owner/repo.git']);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'fixture']);

  const baseCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  const revision = git(repoRoot, ['rev-parse', 'HEAD:REQUIREMENTS.md']);
  const now = '2026-09-17T00:00:00Z';
  const policy = {
    ...basePolicy,
    ...policyOverrides,
    scope: { ...basePolicy.scope, ...(policyOverrides.scope ?? {}) },
    verification: { ...basePolicy.verification, ...(policyOverrides.verification ?? {}) },
    budget: { ...basePolicy.budget, ...(policyOverrides.budget ?? {}) },
    permissions: { ...basePolicy.permissions, ...(policyOverrides.permissions ?? {}) },
    progress: { ...basePolicy.progress, ...(policyOverrides.progress ?? {}) },
    stop: { ...basePolicy.stop, ...(policyOverrides.stop ?? {}) }
  };

  writeJson(policyPath, policy);
  writeJson(schemaPath, schema);
  writeJson(path.join(queueDir, 'control.json'), {
    schemaVersion: 1,
    repository: 'Owner/repo',
    requirements: { path: 'REQUIREMENTS.md', revisionType: 'blobSha', revision, readyAt: now },
    generationRevision: 1,
    syncState: 'synced',
    activeRunId: null,
    workerLanes: ['A'],
    lastError: null,
    updatedAt: now
  });
  writeJson(path.join(queueDir, 'lanes', 'A.json'), {
    schemaVersion: 1,
    repository: 'Owner/repo',
    lane: 'A',
    state: 'idle',
    currentTaskId: null,
    assignmentRevision: 1,
    updatedAt: now
  });
  writeJson(path.join(queueDir, 'items', 'task-alpha.json'), createTask(revision));

  let tick = 0;
  const nowFn = () => new Date(Date.parse(now) + tick++ * 1000).toISOString();
  return { root, repoRoot, dataRoot, queueDir, runDir, policyPath, schemaPath, baseCommit, nowFn, policy };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function passingVerification(requiredRequirements) {
  return {
    status: 'pass',
    satisfiedRequirements: requiredRequirements,
    checks: [
      { name: 'static validation', status: 'pass', evidence: 'static pass' },
      { name: 'runtime check', status: 'pass', evidence: 'runtime pass' },
      { name: 'task deterministic test', status: 'pass', evidence: 'task pass' }
    ],
    usage: { modelTokens: 50, externalCost: 0 }
  };
}

function failingVerification() {
  return {
    status: 'fail',
    satisfiedRequirements: [],
    checks: [
      { name: 'static validation', status: 'pass', evidence: 'static pass' },
      { name: 'runtime check', status: 'fail', evidence: 'same deterministic failure' },
      { name: 'task deterministic test', status: 'fail', evidence: 'same deterministic failure' }
    ],
    usage: { modelTokens: 25, externalCost: 0 }
  };
}

{
  const fixture = createFixture();
  try {
    let verifyAttempt = 0;
    const result = await runPhaseCLoop({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-c-holder-0001',
      runDir: fixture.runDir,
      now: fixture.nowFn,
      selectStrategy: async ({ attempt }) => attempt === 1 ? 'baseline-fix' : 'alternate-fix',
      implement: async ({ worktreeDir, attempt }) => {
        fs.writeFileSync(path.join(worktreeDir, 'src', 'result.txt'), `attempt-${attempt}\n`, 'utf8');
        return { usage: { modelTokens: 100, externalCost: 0 } };
      },
      verify: async ({ requiredRequirements }) => ++verifyAttempt === 1 ? failingVerification() : passingVerification(requiredRequirements)
    });
    assert.equal(result.state.status, 'passed');
    assert.equal(result.state.attempts.length, 2);
    assert.equal(result.state.attempts[0].finalState, 'failed');
    assert.equal(result.state.attempts[1].finalState, 'passed');
    assert.equal(result.state.budgetUsage.modelTokens, 275);
    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
    const item = readJson(path.join(fixture.queueDir, 'items', 'task-alpha.json'));
    assert.equal(item.status, 'completed');
    assert.ok(fs.existsSync(path.join(fixture.runDir, 'state.json')));
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture({ budget: { maxSameFailure: 2 } });
  try {
    const result = await runPhaseCLoop({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-c-holder-0002',
      runDir: fixture.runDir,
      now: fixture.nowFn,
      selectStrategy: async ({ attempt }) => `strategy-${attempt}`,
      implement: async ({ worktreeDir, attempt }) => {
        fs.writeFileSync(path.join(worktreeDir, 'src', 'result.txt'), `attempt-${attempt}\n`, 'utf8');
        return { usage: { modelTokens: 10, externalCost: 0 } };
      },
      verify: async () => failingVerification()
    });
    assert.equal(result.state.status, 'stuck');
    assert.equal(result.state.sameFailureCount, 2);
    assert.equal(result.state.attempts.length, 2);
    const item = readJson(path.join(fixture.queueDir, 'items', 'task-alpha.json'));
    const lane = readJson(path.join(fixture.queueDir, 'lanes', 'A.json'));
    assert.equal(item.status, 'blocked');
    assert.equal(lane.state, 'blocked');
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture({ budget: { maxIterations: 1, maxSameFailure: 99 } });
  try {
    const result = await runPhaseCLoop({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-c-holder-0003',
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async ({ worktreeDir }) => {
        fs.writeFileSync(path.join(worktreeDir, 'src', 'result.txt'), 'fail\n', 'utf8');
      },
      verify: async () => failingVerification()
    });
    assert.equal(result.state.status, 'budget_exhausted');
    assert.equal(result.state.attempts.length, 1);
    assert.ok(result.state.unresolvedItems.includes('budget:max_iterations'));
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture();
  try {
    requestPhaseCControl({ runDir: fixture.runDir, loopId: fixture.policy.loopId, repository: fixture.policy.repository, action: 'pause', now: fixture.nowFn() });
    const paused = await runPhaseCLoop({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-c-holder-0004',
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async () => { throw new Error('must not run while paused'); },
      verify: async () => { throw new Error('must not verify while paused'); }
    });
    assert.equal(paused.state.status, 'paused');
    assert.equal(paused.state.attempts.length, 0);

    requestPhaseCControl({ runDir: fixture.runDir, loopId: fixture.policy.loopId, repository: fixture.policy.repository, action: 'run', now: fixture.nowFn() });
    const resumed = await runPhaseCLoop({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-c-holder-0004',
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async ({ worktreeDir }) => {
        fs.writeFileSync(path.join(worktreeDir, 'src', 'result.txt'), 'resume-pass\n', 'utf8');
      },
      verify: async ({ requiredRequirements }) => passingVerification(requiredRequirements)
    });
    assert.equal(resumed.state.status, 'passed');
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture();
  try {
    requestPhaseCControl({ runDir: fixture.runDir, loopId: fixture.policy.loopId, repository: fixture.policy.repository, action: 'cancel', now: fixture.nowFn() });
    const cancelled = await runPhaseCLoop({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-c-holder-0005',
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async () => { throw new Error('must not run when cancelled'); },
      verify: async () => { throw new Error('must not verify when cancelled'); }
    });
    assert.equal(cancelled.state.status, 'cancelled');
    assert.equal(cancelled.state.attempts.length, 0);
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture();
  try {
    requestPhaseCControl({ runDir: fixture.runDir, loopId: fixture.policy.loopId, repository: fixture.policy.repository, action: 'pause', now: fixture.nowFn() });
    const paused = await runPhaseCLoop({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-c-holder-0006',
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async () => {},
      verify: async () => ({})
    });
    assert.equal(paused.state.status, 'paused');
    git(fixture.repoRoot, ['branch', 'loop/phase-c-test/task-alpha-a1']);
    requestPhaseCControl({ runDir: fixture.runDir, loopId: fixture.policy.loopId, repository: fixture.policy.repository, action: 'run', now: fixture.nowFn() });
    const reconciled = await runPhaseCLoop({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-c-holder-0006',
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async () => { throw new Error('must not run with unsettled branch'); },
      verify: async () => { throw new Error('must not verify with unsettled branch'); }
    });
    assert.equal(reconciled.state.status, 'needs_reconcile');
    assert.ok(reconciled.state.unresolvedItems.includes('unsettled_worker_branch_without_recorded_receipt'));
  } finally {
    cleanup(fixture.root);
  }
}

console.log('Loop Engineering Phase C tests passed.');
