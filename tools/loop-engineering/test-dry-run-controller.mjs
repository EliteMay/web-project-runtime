import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDryRunController } from './dry-run-controller.mjs';
import { validateJsonSchema } from './json-schema-lite.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

const testSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['policyVersion', 'loopId', 'repository', 'goal', 'scope', 'trigger', 'verification', 'budget', 'permissions', 'progress', 'stop'],
  properties: {
    policyVersion: { type: 'string', const: '1' },
    loopId: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9._-]+$' },
    repository: { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' },
    autonomyLevel: { type: 'string', enum: ['L0_ASSISTED', 'L1_WORKTREE', 'L2_PR', 'L3_GUARDED_MERGE', 'L4_GUARDED_RELEASE'] },
    goal: {
      type: 'object',
      additionalProperties: false,
      required: ['statement', 'completionCriteria'],
      properties: {
        statement: { type: 'string', minLength: 1 },
        completionCriteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }
      }
    },
    scope: {
      type: 'object',
      additionalProperties: false,
      required: ['workingBranchPolicy', 'allowedPaths', 'protectedPaths'],
      properties: {
        workingBranchPolicy: { type: 'string', enum: ['isolated_branch', 'isolated_worktree', 'read_only'] },
        allowedPaths: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        protectedPaths: { type: 'array', items: { type: 'string', minLength: 1 } },
        requiredSources: { type: 'array', items: { type: 'string', minLength: 1 } }
      }
    },
    trigger: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: { type: { type: 'string', enum: ['manual', 'queue', 'schedule', 'event'] }, source: { type: 'string' } }
    },
    verification: {
      type: 'object',
      additionalProperties: false,
      required: ['minimumLevel', 'protected', 'requiredChecks'],
      properties: {
        minimumLevel: { type: 'string', enum: ['V0_SELF', 'V1_STATIC', 'V2_DETERMINISTIC', 'V3_RUNTIME', 'V4_PROTECTED', 'V5_HUMAN'] },
        protected: { type: 'boolean' },
        requiredChecks: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        evidenceRequired: { type: 'boolean' },
        allowWorkerToModifyVerifier: { type: 'boolean' }
      }
    },
    budget: {
      type: 'object',
      additionalProperties: true,
      required: ['maxIterations', 'maxSameFailure', 'maxParallelWorkers'],
      properties: {
        maxIterations: { type: 'integer', minimum: 1 },
        maxSameFailure: { type: 'integer', minimum: 1 },
        maxParallelWorkers: { type: 'integer', minimum: 1 }
      }
    },
    permissions: {
      type: 'object',
      additionalProperties: true,
      required: ['repositoryRead', 'workingBranchWrite', 'commit', 'pushWorkingBranch', 'defaultBranchWrite', 'merge', 'deploy', 'externalNetwork', 'secretAccess'],
      properties: {
        repositoryRead: { type: 'boolean' }, workingBranchWrite: { type: 'boolean' }, commit: { type: 'boolean' }, pushWorkingBranch: { type: 'boolean' },
        defaultBranchWrite: { type: 'boolean' }, merge: { type: 'boolean' }, deploy: { type: 'boolean' }, externalNetwork: { type: 'boolean' }, secretAccess: { type: 'boolean' }
      }
    },
    progress: {
      type: 'object',
      additionalProperties: true,
      required: ['detectSameFailure', 'requireMeaningfulDelta'],
      properties: { detectSameFailure: { type: 'boolean' }, requireMeaningfulDelta: { type: 'boolean' } }
    },
    stop: {
      type: 'object',
      additionalProperties: true,
      required: ['successWhen', 'escalateWhen', 'terminalStates'],
      properties: {
        successWhen: { type: 'array', minItems: 1, items: { type: 'string' } },
        escalateWhen: { type: 'array', minItems: 1, items: { type: 'string' }, uniqueItems: true },
        terminalStates: { type: 'array', minItems: 1, items: { type: 'string' }, uniqueItems: true }
      }
    }
  }
};

const policy = {
  policyVersion: '1',
  loopId: 'phase-a-test',
  repository: 'EliteMay/example-project',
  autonomyLevel: 'L1_WORKTREE',
  goal: { statement: 'Implement one eligible queue task.', completionCriteria: ['task completed', 'verification passed'] },
  scope: {
    workingBranchPolicy: 'isolated_worktree',
    allowedPaths: ['src/**', 'tests/**'],
    protectedPaths: ['tests/acceptance/**'],
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
  budget: { maxIterations: 6, maxSameFailure: 3, maxParallelWorkers: 1, maxWallClockMinutes: null, maxModelTokens: null, maxExternalCost: null, costCurrency: null },
  permissions: {
    repositoryRead: true,
    workingBranchWrite: true,
    commit: true,
    pushWorkingBranch: true,
    defaultBranchWrite: false,
    merge: false,
    deploy: false,
    externalNetwork: false,
    secretAccess: false
  },
  progress: { detectSameFailure: true, requireMeaningfulDelta: true, signatureInputs: ['error_category'] },
  stop: {
    successWhen: ['completion criteria evidenced'],
    escalateWhen: ['user_decision_required', 'verifier_uncertain'],
    terminalStates: ['passed', 'failed', 'stuck', 'blocked', 'budget_exhausted', 'escalated', 'cancelled']
  }
};

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-phase-a-'));
  const repoRoot = path.join(root, 'target');
  const queueDir = path.join(root, 'queue');
  const policyPath = path.join(root, 'policy.json');
  const schemaPath = path.join(root, 'schema.json');

  fs.mkdirSync(repoRoot, { recursive: true });
  for (const name of ['README.md', 'REQUIREMENTS.md', 'PROJECT_LEARNINGS.md']) {
    fs.writeFileSync(path.join(repoRoot, name), `# ${name}\n`, 'utf8');
  }
  git(repoRoot, ['init']);
  git(repoRoot, ['config', 'user.email', 'phase-a@example.invalid']);
  git(repoRoot, ['config', 'user.name', 'Phase A Test']);
  git(repoRoot, ['remote', 'add', 'origin', 'https://github.com/EliteMay/example-project.git']);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'fixture']);

  const requirementsBlob = git(repoRoot, ['rev-parse', 'HEAD:REQUIREMENTS.md']);
  const sourceRequirements = { path: 'REQUIREMENTS.md', revisionType: 'blobSha', revision: requirementsBlob };

  writeJson(policyPath, policy);
  writeJson(schemaPath, testSchema);
  writeJson(path.join(queueDir, 'control.json'), {
    schemaVersion: 1,
    repository: policy.repository,
    requirements: { ...sourceRequirements, readyAt: '2026-09-17T00:00:00Z' },
    generationRevision: 1,
    syncState: 'synced',
    activeRunId: null,
    workerLanes: ['A'],
    lastError: null,
    updatedAt: '2026-09-17T00:00:00Z'
  });
  writeJson(path.join(queueDir, 'lanes', 'A.json'), {
    schemaVersion: 1,
    lane: 'A',
    repository: policy.repository,
    state: 'idle',
    currentTaskId: null,
    assignmentRevision: 1,
    updatedAt: '2026-09-17T00:00:00Z'
  });
  writeJson(path.join(queueDir, 'items', 'task-high.json'), {
    schemaVersion: 1,
    taskId: 'task-high',
    repository: policy.repository,
    sourceRequirements,
    generationRevision: 1,
    title: 'High priority task',
    dependencies: [],
    validationRequirements: ['task deterministic test'],
    status: 'queued',
    priority: 100,
    role: 'preparation',
    assignedLane: null,
    assignmentRevision: 1,
    safeParallel: false
  });
  writeJson(path.join(queueDir, 'items', 'task-low.json'), {
    schemaVersion: 1,
    taskId: 'task-low',
    repository: policy.repository,
    sourceRequirements,
    generationRevision: 1,
    title: 'Low priority task',
    dependencies: ['task-high'],
    validationRequirements: ['follow-up check'],
    status: 'queued',
    priority: 10,
    role: 'preparation',
    assignedLane: null,
    assignmentRevision: 1,
    safeParallel: false
  });

  return { root, repoRoot, queueDir, policyPath, schemaPath, requirementsBlob };
}

function snapshotFiles(root) {
  const result = new Map();
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
    }
  }
  walk(root);
  return result;
}

const schemaSmoke = validateJsonSchema({ a: 1 }, {
  type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer', minimum: 1 } }
});
assert.equal(schemaSmoke.valid, true);
assert.equal(validateJsonSchema({ a: 0, extra: true }, {
  type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer', minimum: 1 } }
}).valid, false);

const fixture = createFixture();
try {
  const beforeQueue = snapshotFiles(fixture.queueDir);
  const beforeRepo = snapshotFiles(fixture.repoRoot);
  const beforeStatus = git(fixture.repoRoot, ['status', '--porcelain']);

  const ready = runDryRunController({ ...fixture, now: '2026-09-17T01:00:00Z' });
  assert.equal(ready.authority, 'derived-loop-dry-run-only');
  assert.equal(ready.mode, 'read_only_dry_run');
  assert.equal(ready.repository.identityState, 'matched');
  assert.equal(ready.queue.requirementsEvidence.revisionState, 'matched');
  assert.equal(ready.queue.requirementsEvidence.expectedRevision, fixture.requirementsBlob);
  assert.equal(ready.queue.requirementsEvidence.observedRevision, fixture.requirementsBlob);
  assert.equal(ready.queue.requirementsEvidence.workingTreeDirty, false);
  assert.equal(ready.decision.state, 'ready');
  assert.equal(ready.decision.selectedTask.taskId, 'task-high');
  assert.equal(ready.decision.assignmentAuthority, false);
  assert.equal(ready.verifier.finalAuthorityBoundary, 'protected');
  assert.deepEqual(ready.verifier.taskValidationRequirements, ['task deterministic test']);
  assert.equal(ready.permissions.readOnlyOverride, true);
  assert.equal(ready.permissions.effectiveForPhaseA.workingBranchWrite, false);
  assert.equal(ready.permissions.effectiveForPhaseA.commit, false);
  assert.equal(ready.permissions.effectiveForPhaseA.pushWorkingBranch, false);
  assert.equal(ready.permissions.effectiveForPhaseA.merge, false);
  assert.equal(ready.permissions.effectiveForPhaseA.deploy, false);

  assert.deepEqual(snapshotFiles(fixture.queueDir), beforeQueue, 'Queue files changed during dry-run.');
  assert.deepEqual(snapshotFiles(fixture.repoRoot), beforeRepo, 'Target repository files changed during dry-run.');
  assert.equal(git(fixture.repoRoot, ['status', '--porcelain']), beforeStatus, 'Target git status changed during dry-run.');

  const controlFile = path.join(fixture.queueDir, 'control.json');
  const highFile = path.join(fixture.queueDir, 'items', 'task-high.json');
  const lowFile = path.join(fixture.queueDir, 'items', 'task-low.json');
  const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  const highTask = JSON.parse(fs.readFileSync(highFile, 'utf8'));
  const lowTask = JSON.parse(fs.readFileSync(lowFile, 'utf8'));

  writeJson(controlFile, { ...control, syncState: 'failed' });
  const failedSync = runDryRunController({ ...fixture, now: '2026-09-17T01:01:00Z' });
  assert.equal(failedSync.decision.state, 'blocked');
  assert(failedSync.decision.blockers.includes('queue_not_synced'));

  writeJson(controlFile, { ...control, activeRunId: 'run-existing' });
  const activeRun = runDryRunController({ ...fixture, now: '2026-09-17T01:02:00Z' });
  assert.equal(activeRun.decision.state, 'blocked');
  assert(activeRun.decision.blockers.includes('queue_active_run_present'));

  const staleRevision = '0000000000000000000000000000000000000000';
  const staleSource = { path: 'REQUIREMENTS.md', revisionType: 'blobSha', revision: staleRevision };
  writeJson(controlFile, { ...control, requirements: { ...staleSource, readyAt: control.requirements.readyAt } });
  writeJson(highFile, { ...highTask, sourceRequirements: staleSource });
  writeJson(lowFile, { ...lowTask, sourceRequirements: staleSource });
  const staleQueue = runDryRunController({ ...fixture, now: '2026-09-17T01:03:00Z' });
  assert.equal(staleQueue.queue.requirementsEvidence.revisionState, 'mismatch');
  assert.equal(staleQueue.decision.state, 'blocked');
  assert(staleQueue.decision.blockers.includes('queue_requirements_revision_mismatch'));

  writeJson(controlFile, control);
  writeJson(highFile, highTask);
  writeJson(lowFile, lowTask);
  fs.appendFileSync(path.join(fixture.repoRoot, 'REQUIREMENTS.md'), '\nlocal uncommitted change\n', 'utf8');
  const dirtyRequirements = runDryRunController({ ...fixture, now: '2026-09-17T01:04:00Z' });
  assert.equal(dirtyRequirements.queue.requirementsEvidence.revisionState, 'matched');
  assert.equal(dirtyRequirements.queue.requirementsEvidence.workingTreeDirty, true);
  assert.equal(dirtyRequirements.decision.state, 'blocked');
  assert(dirtyRequirements.decision.blockers.includes('queue_requirements_worktree_dirty'));
  git(fixture.repoRoot, ['checkout', '--', 'REQUIREMENTS.md']);

  fs.rmSync(path.join(fixture.repoRoot, 'PROJECT_LEARNINGS.md'));
  const missingSource = runDryRunController({ ...fixture, now: '2026-09-17T01:05:00Z' });
  assert.equal(missingSource.decision.state, 'blocked');
  assert(missingSource.decision.blockers.includes('required_source_missing'));

  const invalidPolicy = { ...policy, policyVersion: '2' };
  writeJson(fixture.policyPath, invalidPolicy);
  assert.throws(
    () => runDryRunController({ ...fixture, now: '2026-09-17T01:06:00Z' }),
    error => error.code === 'INVALID_LOOP_POLICY' && Array.isArray(error.validationErrors) && error.validationErrors.length > 0
  );

  console.log('Loop Engineering Phase A dry-run controller tests passed.');
} finally {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}
