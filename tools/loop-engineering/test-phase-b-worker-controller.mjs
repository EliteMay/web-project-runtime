import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPhaseBWorker } from './phase-b-worker-controller.mjs';
import { acquireRepositoryWriterLock } from '../reliability/single-writer-lock.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
    scope: {
      type: 'object',
      required: ['workingBranchPolicy', 'allowedPaths', 'protectedPaths'],
      properties: {
        workingBranchPolicy: { type: 'string' },
        allowedPaths: { type: 'array', minItems: 1, items: { type: 'string' } },
        protectedPaths: { type: 'array', items: { type: 'string' } },
        requiredSources: { type: 'array', items: { type: 'string' } }
      }
    },
    trigger: { type: 'object' },
    verification: {
      type: 'object',
      required: ['minimumLevel', 'protected', 'requiredChecks', 'allowWorkerToModifyVerifier'],
      properties: {
        minimumLevel: { type: 'string' },
        protected: { type: 'boolean' },
        requiredChecks: { type: 'array', minItems: 1, items: { type: 'string' } },
        evidenceRequired: { type: 'boolean' },
        allowWorkerToModifyVerifier: { type: 'boolean' }
      }
    },
    budget: {
      type: 'object',
      required: ['maxIterations', 'maxSameFailure', 'maxParallelWorkers'],
      properties: {
        maxIterations: { type: 'integer', minimum: 1 },
        maxSameFailure: { type: 'integer', minimum: 1 },
        maxParallelWorkers: { type: 'integer', minimum: 1 }
      }
    },
    permissions: {
      type: 'object',
      required: ['repositoryRead', 'workingBranchWrite', 'commit', 'pushWorkingBranch', 'defaultBranchWrite', 'merge', 'deploy', 'externalNetwork', 'secretAccess'],
      properties: {
        repositoryRead: { type: 'boolean' },
        workingBranchWrite: { type: 'boolean' },
        commit: { type: 'boolean' },
        pushWorkingBranch: { type: 'boolean' },
        defaultBranchWrite: { type: 'boolean' },
        merge: { type: 'boolean' },
        deploy: { type: 'boolean' },
        externalNetwork: { type: 'boolean' },
        secretAccess: { type: 'boolean' }
      }
    },
    progress: { type: 'object' },
    stop: { type: 'object' }
  }
};

const basePolicy = {
  policyVersion: '1',
  loopId: 'phase-b-test',
  repository: 'Owner/repo',
  autonomyLevel: 'L1_WORKTREE',
  goal: { statement: 'Implement one task.', completionCriteria: ['task completed', 'verification passed'] },
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
    maxIterations: 6,
    maxSameFailure: 3,
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
  progress: { detectSameFailure: true, requireMeaningfulDelta: true, signatureInputs: ['error_category', 'failing_checks'] },
  stop: {
    successWhen: ['completion criteria evidenced'],
    escalateWhen: ['user_decision_required', 'verifier_uncertain'],
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-phase-b-'));
  const repoRoot = path.join(root, 'target');
  const dataRoot = path.join(root, 'data');
  const queueDir = path.join(dataRoot, 'work-queues', 'Owner--repo');
  const policyPath = path.join(root, 'policy.json');
  const schemaPath = path.join(root, 'schema.json');

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'REQUIREMENTS.md'), '# requirements\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'PROJECT_LEARNINGS.md'), '# learnings\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'base.txt'), 'base\n', 'utf8');
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'phase-b@example.invalid']);
  git(repoRoot, ['config', 'user.name', 'Phase B Test']);
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
    permissions: { ...basePolicy.permissions, ...(policyOverrides.permissions ?? {}) }
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
  const nowFn = () => new Date(Date.parse('2026-09-17T00:00:00Z') + tick++ * 1000).toISOString();
  return { root, repoRoot, dataRoot, queueDir, policyPath, schemaPath, baseCommit, nowFn };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const fixture = createFixture();
  try {
    const result = await runPhaseBWorker({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-b-holder-0001',
      now: fixture.nowFn,
      implement: async ({ worktreeDir }) => {
        fs.writeFileSync(path.join(worktreeDir, 'src', 'result.txt'), 'implemented\n', 'utf8');
      },
      verify: async ({ worktreeDir, requiredRequirements }) => {
        assert.equal(fs.readFileSync(path.join(worktreeDir, 'src', 'result.txt'), 'utf8'), 'implemented\n');
        return {
          status: 'pass',
          satisfiedRequirements: requiredRequirements,
          checks: [
            { name: 'static validation', status: 'pass', evidence: 'fixture static pass' },
            { name: 'runtime check', status: 'pass', evidence: 'fixture runtime pass' },
            { name: 'task deterministic test', status: 'pass', evidence: 'fixture deterministic pass' }
          ]
        };
      }
    });

    assert.equal(result.receipt.finalState, 'passed');
    assert.equal(result.receipt.queue.finalTaskStatus, 'completed');
    assert.equal(result.receipt.repositoryEvidence.baseBranchUnchanged, true);
    assert.deepEqual(result.receipt.repositoryEvidence.changedFiles, ['src/result.txt']);
    assert.equal(result.receipt.verification.status, 'pass');
    assert.equal(result.workerWorktreeRetained, false);
    assert.ok(fs.existsSync(result.receiptPath));

    const item = JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-alpha.json'), 'utf8'));
    const lane = JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'lanes', 'A.json'), 'utf8'));
    assert.equal(item.status, 'completed');
    assert.equal(lane.state, 'waiting');
    assert.equal(lane.currentTaskId, null);

    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
    assert.equal(git(fixture.repoRoot, ['branch', '--show-current']), 'main');
    const workerBranch = result.receipt.repositoryEvidence.workerBranch;
    assert.notEqual(git(fixture.repoRoot, ['rev-parse', workerBranch]), fixture.baseCommit);
    assert.equal(git(fixture.repoRoot, ['show', `${workerBranch}:src/result.txt`]), 'implemented');
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture();
  try {
    const result = await runPhaseBWorker({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-b-holder-0002',
      now: fixture.nowFn,
      implement: async ({ worktreeDir }) => {
        fs.writeFileSync(path.join(worktreeDir, 'src', 'result.txt'), 'candidate\n', 'utf8');
      },
      verify: async ({ requiredRequirements }) => ({
        status: 'fail',
        satisfiedRequirements: requiredRequirements,
        checks: [{ name: 'runtime check', status: 'fail', evidence: 'fixture rejection' }]
      })
    });

    assert.equal(result.receipt.finalState, 'failed');
    assert.equal(result.receipt.queue.finalTaskStatus, 'working');
    assert.equal(result.receipt.repositoryEvidence.baseBranchUnchanged, true);
    assert.equal(result.receipt.verification.status, 'fail');
    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
    assert.ok(result.receipt.repositoryEvidence.candidateCommit);
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture({ permissions: { defaultBranchWrite: true } });
  try {
    await assert.rejects(
      runPhaseBWorker({
        policyPath: fixture.policyPath,
        schemaPath: fixture.schemaPath,
        queueDir: fixture.queueDir,
        repoRoot: fixture.repoRoot,
        taskId: 'task-alpha',
        lane: 'A',
        holderId: 'phase-b-holder-0003',
        now: fixture.nowFn,
        implement: async () => {},
        verify: async () => ({ status: 'pass', satisfiedRequirements: [], checks: [] })
      }),
      /defaultBranchWrite must remain false/
    );
    const item = JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-alpha.json'), 'utf8'));
    assert.equal(item.status, 'queued');
    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture();
  let lock;
  try {
    lock = acquireRepositoryWriterLock(fixture.repoRoot, {
      transactionId: 'external-writer-test',
      branch: 'main',
      baseCommit: fixture.baseCommit
    });

    const result = await runPhaseBWorker({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      taskId: 'task-alpha',
      lane: 'A',
      holderId: 'phase-b-holder-0004',
      now: fixture.nowFn,
      implement: async () => {
        throw new Error('implement must not run while another writer owns the repository lock');
      },
      verify: async () => ({ status: 'pass', satisfiedRequirements: [], checks: [] })
    });

    assert.equal(result.receipt.finalState, 'failed');
    assert.equal(result.receipt.queue.finalTaskStatus, 'queued');
    assert.equal(result.operationalError?.code, 'repository-writer-locked');
    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
    const item = JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-alpha.json'), 'utf8'));
    assert.equal(item.status, 'queued');
  } finally {
    lock?.release();
    cleanup(fixture.root);
  }
}

console.log('Loop Engineering Phase B isolated worker tests passed.');
