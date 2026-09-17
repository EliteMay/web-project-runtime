import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPhaseDParallel } from './phase-d-controller.mjs';

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
    verification: { type: 'object' },
    budget: { type: 'object' },
    permissions: { type: 'object' },
    progress: { type: 'object' },
    stop: { type: 'object' }
  }
};

const basePolicy = {
  policyVersion: '1',
  loopId: 'phase-d-test',
  repository: 'Owner/repo',
  autonomyLevel: 'L1_WORKTREE',
  goal: { statement: 'Implement independent tasks in parallel.', completionCriteria: ['all tasks verified', 'integration verified'] },
  scope: {
    workingBranchPolicy: 'isolated_worktree',
    allowedPaths: ['src/**'],
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
    maxParallelWorkers: 2,
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

function task(taskId, revision, scope, priority = 100) {
  const now = '2026-09-17T00:00:00Z';
  return {
    schemaVersion: 1,
    taskId,
    repository: 'Owner/repo',
    sourceRequirements: { path: 'REQUIREMENTS.md', revisionType: 'blobSha', revision },
    generationRevision: 1,
    title: `Implement ${taskId}`,
    scope,
    dependencies: [],
    completionCriteria: [`${taskId} output exists`],
    validationRequirements: [`${taskId} deterministic test`],
    status: 'queued',
    priority,
    role: 'preparation',
    assignedLane: null,
    assignmentRevision: 1,
    safeParallel: true,
    publicSummary: taskId,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
}

function plan(overrides = {}) {
  const value = {
    schemaVersion: 1,
    repository: 'Owner/repo',
    loopId: 'phase-d-test',
    tasks: [
      { taskId: 'task-alpha', lane: 'A', holderId: 'phase-d-alpha-0001', scopePaths: ['src/alpha'], semanticScopes: ['feature/alpha'] },
      { taskId: 'task-beta', lane: 'B', holderId: 'phase-d-beta-0001', scopePaths: ['src/beta'], semanticScopes: ['feature/beta'] }
    ],
    integration: { requiredChecks: ['cross-worker integration'] }
  };
  return {
    ...value,
    ...overrides,
    tasks: overrides.tasks ?? value.tasks,
    integration: { ...value.integration, ...(overrides.integration ?? {}) }
  };
}

function createFixture(policyOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-phase-d-'));
  const repoRoot = path.join(root, 'target');
  const dataRoot = path.join(root, 'data');
  const queueDir = path.join(dataRoot, 'work-queues', 'Owner--repo');
  const runDir = path.join(dataRoot, 'loop-runs', 'Owner--repo', 'phase-d-test');
  const policyPath = path.join(root, 'policy.json');
  const schemaPath = path.join(root, 'schema.json');

  fs.mkdirSync(path.join(repoRoot, 'src', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src', 'beta'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'REQUIREMENTS.md'), '# requirements\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'PROJECT_LEARNINGS.md'), '# learnings\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'alpha', 'base.txt'), 'alpha base\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'beta', 'base.txt'), 'beta base\n', 'utf8');
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'phase-d@example.invalid']);
  git(repoRoot, ['config', 'user.name', 'Phase D Test']);
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
    workerLanes: ['A', 'B'],
    lastError: null,
    updatedAt: now
  });
  for (const lane of ['A', 'B']) {
    writeJson(path.join(queueDir, 'lanes', `${lane}.json`), {
      schemaVersion: 1,
      repository: 'Owner/repo',
      lane,
      state: 'idle',
      currentTaskId: null,
      assignmentRevision: 1,
      updatedAt: now
    });
  }
  writeJson(path.join(queueDir, 'items', 'task-alpha.json'), task('task-alpha', revision, 'src/alpha'));
  writeJson(path.join(queueDir, 'items', 'task-beta.json'), task('task-beta', revision, 'src/beta', 90));

  let tick = 0;
  const nowFn = () => new Date(Date.parse('2026-09-17T00:00:00Z') + tick++ * 1000).toISOString();
  return { root, repoRoot, dataRoot, queueDir, runDir, policyPath, schemaPath, baseCommit, nowFn };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function taskFile(taskId) {
  return taskId === 'task-alpha' ? ['alpha', 'result.txt'] : ['beta', 'result.txt'];
}

{
  const fixture = createFixture();
  let active = 0;
  let maxActive = 0;
  try {
    const result = await runPhaseDParallel({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      plan: plan(),
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async ({ worktreeDir, task }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 80));
        const [folder, file] = taskFile(task.taskId);
        fs.writeFileSync(path.join(worktreeDir, 'src', folder, file), `${task.taskId} implemented\n`, 'utf8');
        active -= 1;
        return { usage: { modelTokens: 10, externalCost: 0 } };
      },
      verify: async ({ worktreeDir, task, requiredRequirements }) => {
        const [folder, file] = taskFile(task.taskId);
        assert.equal(fs.readFileSync(path.join(worktreeDir, 'src', folder, file), 'utf8').trim(), `${task.taskId} implemented`);
        return {
          status: 'pass',
          satisfiedRequirements: requiredRequirements,
          checks: requiredRequirements.map(name => ({ name, status: 'pass', evidence: `${task.taskId} pass` })),
          usage: { modelTokens: 5, externalCost: 0 }
        };
      },
      verifyIntegration: async ({ worktreeDir, requiredRequirements }) => {
        assert.equal(fs.readFileSync(path.join(worktreeDir, 'src', 'alpha', 'result.txt'), 'utf8').trim(), 'task-alpha implemented');
        assert.equal(fs.readFileSync(path.join(worktreeDir, 'src', 'beta', 'result.txt'), 'utf8').trim(), 'task-beta implemented');
        return {
          status: 'pass',
          satisfiedRequirements: requiredRequirements,
          checks: requiredRequirements.map(name => ({ name, status: 'pass', evidence: 'integration pass' })),
          usage: { modelTokens: 5, externalCost: 0 }
        };
      }
    });

    assert.equal(result.receipt.finalState, 'passed');
    assert.ok(maxActive >= 2, `Expected real concurrent implementation callbacks, maxActive=${maxActive}`);
    assert.equal(result.receipt.baseBranchUnchanged, true);
    assert.deepEqual(result.receipt.integration.order, ['task-alpha', 'task-beta']);
    assert.equal(result.receipt.integration.status, 'passed');
    assert.equal(result.receipt.integration.verification.status, 'pass');
    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
    assert.equal(git(fixture.repoRoot, ['branch', '--show-current']), 'main');
    const integrationBranch = result.receipt.integration.branch;
    assert.equal(git(fixture.repoRoot, ['show', `${integrationBranch}:src/alpha/result.txt`]), 'task-alpha implemented');
    assert.equal(git(fixture.repoRoot, ['show', `${integrationBranch}:src/beta/result.txt`]), 'task-beta implemented');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-alpha.json'), 'utf8')).status, 'completed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-beta.json'), 'utf8')).status, 'completed');
    assert.ok(fs.existsSync(result.receiptPath));
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture();
  try {
    const overlappingPlan = plan({
      tasks: [
        { taskId: 'task-alpha', lane: 'A', holderId: 'phase-d-alpha-0002', scopePaths: ['src/alpha'], semanticScopes: ['feature/shared'] },
        { taskId: 'task-beta', lane: 'B', holderId: 'phase-d-beta-0002', scopePaths: ['src/alpha/nested'], semanticScopes: ['feature/shared/beta'] }
      ]
    });
    await assert.rejects(
      runPhaseDParallel({
        policyPath: fixture.policyPath,
        schemaPath: fixture.schemaPath,
        plan: overlappingPlan,
        queueDir: fixture.queueDir,
        repoRoot: fixture.repoRoot,
        runDir: fixture.runDir,
        now: fixture.nowFn,
        implement: async () => {},
        verify: async () => ({ status: 'pass', satisfiedRequirements: [], checks: [] }),
        verifyIntegration: async () => ({ status: 'pass', satisfiedRequirements: [], checks: [] })
      }),
      /scopes overlap/
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-alpha.json'), 'utf8')).status, 'queued');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-beta.json'), 'utf8')).status, 'queued');
    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture();
  try {
    const result = await runPhaseDParallel({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      plan: plan(),
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async ({ worktreeDir, task }) => {
        const [folder, file] = taskFile(task.taskId);
        fs.writeFileSync(path.join(worktreeDir, 'src', folder, file), `${task.taskId} candidate\n`, 'utf8');
      },
      verify: async ({ requiredRequirements }) => ({
        status: 'pass',
        satisfiedRequirements: requiredRequirements,
        checks: requiredRequirements.map(name => ({ name, status: 'pass', evidence: 'worker pass' }))
      }),
      verifyIntegration: async ({ requiredRequirements }) => ({
        status: 'fail',
        satisfiedRequirements: requiredRequirements,
        checks: [{ name: 'cross-worker integration', status: 'fail', evidence: 'combined behavior rejected' }]
      })
    });

    assert.equal(result.receipt.finalState, 'failed');
    assert.equal(result.receipt.integration.status, 'failed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-alpha.json'), 'utf8')).status, 'blocked');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-beta.json'), 'utf8')).status, 'blocked');
    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
  } finally {
    cleanup(fixture.root);
  }
}

{
  const fixture = createFixture({ budget: { maxModelTokens: 20 } });
  try {
    const result = await runPhaseDParallel({
      policyPath: fixture.policyPath,
      schemaPath: fixture.schemaPath,
      plan: plan(),
      queueDir: fixture.queueDir,
      repoRoot: fixture.repoRoot,
      runDir: fixture.runDir,
      now: fixture.nowFn,
      implement: async ({ worktreeDir, task }) => {
        const [folder, file] = taskFile(task.taskId);
        fs.writeFileSync(path.join(worktreeDir, 'src', folder, file), `${task.taskId} budget\n`, 'utf8');
        return { usage: { modelTokens: 8, externalCost: 0 } };
      },
      verify: async ({ requiredRequirements }) => ({
        status: 'pass',
        satisfiedRequirements: requiredRequirements,
        checks: requiredRequirements.map(name => ({ name, status: 'pass', evidence: 'worker pass' })),
        usage: { modelTokens: 4, externalCost: 0 }
      }),
      verifyIntegration: async ({ requiredRequirements }) => ({
        status: 'pass',
        satisfiedRequirements: requiredRequirements,
        checks: requiredRequirements.map(name => ({ name, status: 'pass', evidence: 'integration pass' })),
        usage: { modelTokens: 1, externalCost: 0 }
      })
    });

    assert.equal(result.receipt.finalState, 'budget_exhausted');
    assert.ok(result.receipt.unresolvedItems.includes('budget:max_model_tokens'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-alpha.json'), 'utf8')).status, 'blocked');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.queueDir, 'items', 'task-beta.json'), 'utf8')).status, 'blocked');
    assert.equal(git(fixture.repoRoot, ['rev-parse', 'main']), fixture.baseCommit);
  } finally {
    cleanup(fixture.root);
  }
}

console.log('Loop Engineering Phase D parallel orchestration tests passed.');
