import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPhaseERemotePr } from './phase-e-controller.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const guideRoot = path.resolve(process.env.LOOP_GUIDE_ROOT ?? path.join(here, '..', '..', '..', 'web-project-guide'));
const guideSchema = path.join(guideRoot, 'maintenance', 'loop-policy.schema.json');
if (!fs.existsSync(guideSchema)) throw new Error(`Current Guide Loop schema not found: ${guideSchema}`);

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function gitOut(cwd, args) {
  return git(cwd, args).stdout.trim();
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makePolicy(loopId, repository) {
  return {
    policyVersion: '1',
    loopId,
    repository,
    autonomyLevel: 'L2_PR',
    goal: {
      statement: 'Publish a verified Phase D integration branch for human review.',
      completionCriteria: ['Required checks pass', 'Human approval exists', 'Runtime stops before merge']
    },
    scope: {
      workingBranchPolicy: 'isolated_worktree',
      allowedPaths: ['**'],
      protectedPaths: ['.github/workflows/**'],
      requiredSources: ['README.md']
    },
    trigger: { type: 'manual', source: 'phase-e-test' },
    verification: {
      minimumLevel: 'V4_PROTECTED',
      protected: true,
      requiredChecks: ['ci/test'],
      evidenceRequired: true,
      allowWorkerToModifyVerifier: false
    },
    budget: {
      maxIterations: 5,
      maxSameFailure: 2,
      maxParallelWorkers: 2,
      maxWallClockMinutes: 30,
      maxModelTokens: null,
      maxExternalCost: null,
      costCurrency: null
    },
    permissions: {
      repositoryRead: true,
      workingBranchWrite: true,
      commit: true,
      pushWorkingBranch: true,
      defaultBranchWrite: false,
      merge: false,
      deploy: false,
      externalNetwork: true,
      secretAccess: false
    },
    progress: {
      detectSameFailure: true,
      requireMeaningfulDelta: true,
      signatureInputs: ['error_category', 'failing_checks']
    },
    stop: {
      successWhen: ['required checks pass and human review gate is satisfied'],
      escalateWhen: ['user_decision_required', 'external_permission_required', 'verifier_uncertain', 'production_release_gate'],
      terminalStates: ['passed', 'failed', 'stuck', 'blocked', 'budget_exhausted', 'escalated', 'cancelled', 'needs_reconcile']
    }
  };
}

function makeSourceReceipt(loopId, repository, baseCommit, integrationBranch, integrationHead) {
  const worker = (taskId, lane) => ({
    taskId,
    lane,
    holderId: `holder-${taskId}`,
    scopePaths: [`src/${taskId}`],
    semanticScopes: [`feature/${taskId}`],
    assignmentRevision: 1,
    workerBranch: `loop/${loopId}/${taskId}-d1`,
    candidateCommit: integrationHead,
    changedFiles: [`src/${taskId}/file.txt`],
    verification: {
      status: 'pass',
      satisfiedRequirements: ['ci/test'],
      checks: [{ name: 'ci/test', status: 'pass', evidence: 'fixture pass' }]
    },
    usage: {
      modelTokens: 0,
      externalCost: 0,
      implementationReported: true,
      verificationReported: true
    },
    finalTaskStatus: 'completed'
  });
  return {
    schemaVersion: 1,
    receiptId: `phase-d-${loopId}`,
    mode: 'phase_d_parallel',
    loopId,
    repository,
    startedAt: '2026-09-17T00:00:00.000Z',
    finishedAt: '2026-09-17T00:01:00.000Z',
    finalState: 'passed',
    baseBranch: 'main',
    baseCommit,
    baseBranchUnchanged: true,
    workers: [worker('task-a', 'lane-a'), worker('task-b', 'lane-b')],
    integration: {
      branch: integrationBranch,
      order: ['task-a', 'task-b'],
      head: integrationHead,
      status: 'passed',
      verification: {
        status: 'pass',
        satisfiedRequirements: ['ci/test'],
        checks: [{ name: 'ci/test', status: 'pass', evidence: 'integration pass' }]
      },
      conflictTaskId: null
    },
    aggregateUsage: { modelTokens: 0, externalCost: 0, wallClockMinutes: 1 },
    unresolvedItems: []
  };
}

function createFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `loop-phase-e-${label}-`));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(repo, { recursive: true });
  git(root, ['init', '--bare', remote]);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Loop Phase E Test']);
  git(repo, ['config', 'user.email', 'loop-phase-e@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  const baseCommit = gitOut(repo, ['rev-parse', 'HEAD']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', 'origin', 'main:main']);

  const loopId = `phase-e-${label}`;
  const integrationBranch = `loop/${loopId}/integration-d1`;
  git(repo, ['checkout', '-b', integrationBranch]);
  fs.mkdirSync(path.join(repo, 'src', 'task-a'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'task-b'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'task-a', 'file.txt'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'src', 'task-b', 'file.txt'), 'b\n', 'utf8');
  git(repo, ['add', 'src']);
  git(repo, ['commit', '-m', 'verified integration candidate']);
  const integrationHead = gitOut(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', 'main']);

  const repository = 'EliteMay/phase-e-fixture';
  const receipt = makeSourceReceipt(loopId, repository, baseCommit, integrationBranch, integrationHead);
  const receiptPath = path.join(root, 'phase-d-receipt.json');
  writeJson(receiptPath, receipt);
  const policyPath = path.join(root, 'policy.json');
  writeJson(policyPath, makePolicy(loopId, repository));
  const remoteBranch = `loop/${loopId}/review`;
  const plan = {
    schemaVersion: 1,
    mode: 'phase_e_remote_pr',
    loopId,
    repository,
    sourceReceiptId: receipt.receiptId,
    remote: { name: 'origin', branch: remoteBranch },
    pullRequest: {
      baseBranch: 'main',
      title: `Phase E ${label}`,
      body: 'Fixture PR',
      draft: false,
      requiredChecks: ['ci/test'],
      humanReviewRequired: true,
      minApprovals: 1
    }
  };
  return { root, repo, remote, runDir, policyPath, receiptPath, plan, baseCommit, integrationHead, remoteBranch };
}

function remoteBranchHead(fixture) {
  const result = git(fixture.repo, ['ls-remote', '--heads', 'origin', `refs/heads/${fixture.remoteBranch}`]);
  const line = result.stdout.trim();
  return line ? line.split(/\s+/)[0] : null;
}

async function testPendingThenHumanGate() {
  const fx = createFixture('resume');
  let openCount = 0;
  let observation = 'pending';
  const openPullRequest = async ({ headSha, baseBranch }) => {
    openCount += 1;
    return { id: 101, url: 'https://example.invalid/pr/101', state: 'open', headSha, baseBranch };
  };
  const observePullRequest = async ({ pullRequest }) => ({
    state: 'open',
    headSha: pullRequest.headSha,
    baseBranch: pullRequest.baseBranch,
    checks: [{ name: 'ci/test', status: observation === 'pending' ? 'pending' : 'success', evidence: observation }],
    reviews: observation === 'approved' ? [{ state: 'approved', author: 'human' }] : []
  });

  const first = await runPhaseERemotePr({
    policyPath: fx.policyPath,
    schemaPath: guideSchema,
    plan: fx.plan,
    sourceReceiptPath: fx.receiptPath,
    repoRoot: fx.repo,
    runDir: fx.runDir,
    openPullRequest,
    observePullRequest
  });
  assert.equal(first.state.status, 'awaiting_checks');
  assert.equal(remoteBranchHead(fx), fx.integrationHead);
  assert.equal(openCount, 1);
  assert.equal(gitOut(fx.repo, ['rev-parse', 'main']), fx.baseCommit);

  observation = 'checks-pass';
  const second = await runPhaseERemotePr({
    policyPath: fx.policyPath,
    schemaPath: guideSchema,
    plan: fx.plan,
    sourceReceiptPath: fx.receiptPath,
    repoRoot: fx.repo,
    runDir: fx.runDir,
    openPullRequest,
    observePullRequest
  });
  assert.equal(second.state.status, 'awaiting_human_review');
  assert.equal(openCount, 1, 'resume must reuse the existing PR');

  observation = 'approved';
  const third = await runPhaseERemotePr({
    policyPath: fx.policyPath,
    schemaPath: guideSchema,
    plan: fx.plan,
    sourceReceiptPath: fx.receiptPath,
    repoRoot: fx.repo,
    runDir: fx.runDir,
    openPullRequest,
    observePullRequest
  });
  assert.equal(third.state.status, 'ready_for_human_merge');
  assert.equal(third.receipt.mergePerformed, false);
  assert.equal(third.receipt.deployPerformed, false);
  assert.equal(gitOut(fx.repo, ['rev-parse', 'main']), fx.baseCommit);
  assert.equal(gitOut(fx.repo, ['status', '--porcelain']), '');
}

async function testFailedRequiredCheckBlocks() {
  const fx = createFixture('check-fail');
  const result = await runPhaseERemotePr({
    policyPath: fx.policyPath,
    schemaPath: guideSchema,
    plan: fx.plan,
    sourceReceiptPath: fx.receiptPath,
    repoRoot: fx.repo,
    runDir: fx.runDir,
    openPullRequest: async ({ headSha, baseBranch }) => ({ id: 102, url: 'https://example.invalid/pr/102', state: 'open', headSha, baseBranch }),
    observePullRequest: async ({ pullRequest }) => ({
      state: 'open',
      headSha: pullRequest.headSha,
      baseBranch: pullRequest.baseBranch,
      checks: [{ name: 'ci/test', status: 'failure', evidence: 'fixture failure' }],
      reviews: [{ state: 'approved' }]
    })
  });
  assert.equal(result.state.status, 'blocked');
  assert.ok(result.state.unresolvedItems.includes('required_check_failed'));
  assert.equal(gitOut(fx.repo, ['rev-parse', 'main']), fx.baseCommit);
}

async function testRemoteBranchDivergenceFailsClosed() {
  const fx = createFixture('remote-diverged');
  git(fx.repo, ['push', 'origin', `refs/heads/main:refs/heads/${fx.remoteBranch}`]);
  let opened = false;
  const result = await runPhaseERemotePr({
    policyPath: fx.policyPath,
    schemaPath: guideSchema,
    plan: fx.plan,
    sourceReceiptPath: fx.receiptPath,
    repoRoot: fx.repo,
    runDir: fx.runDir,
    openPullRequest: async () => {
      opened = true;
      throw new Error('must not open PR after divergence');
    },
    observePullRequest: async () => ({})
  });
  assert.equal(result.state.status, 'needs_reconcile');
  assert.ok(result.state.unresolvedItems.includes('remote_branch_points_to_different_commit'));
  assert.equal(opened, false);
}

async function testRemoteBaseMovementFailsClosed() {
  const fx = createFixture('base-moved');
  const clone = path.join(fx.root, 'base-writer');
  git(fx.root, ['clone', fx.remote, clone]);
  git(clone, ['config', 'user.name', 'Base Writer']);
  git(clone, ['config', 'user.email', 'base-writer@example.invalid']);
  git(clone, ['checkout', 'main']);
  fs.writeFileSync(path.join(clone, 'remote-change.txt'), 'new base\n', 'utf8');
  git(clone, ['add', 'remote-change.txt']);
  git(clone, ['commit', '-m', 'advance remote base']);
  git(clone, ['push', 'origin', 'main:main']);

  const result = await runPhaseERemotePr({
    policyPath: fx.policyPath,
    schemaPath: guideSchema,
    plan: fx.plan,
    sourceReceiptPath: fx.receiptPath,
    repoRoot: fx.repo,
    runDir: fx.runDir,
    openPullRequest: async () => { throw new Error('must not open PR on stale base'); },
    observePullRequest: async () => ({})
  });
  assert.equal(result.state.status, 'needs_reconcile');
  assert.ok(result.state.unresolvedItems.includes('remote_base_changed_since_phase_d'));
  assert.equal(remoteBranchHead(fx), null);
}

async function testDefaultBranchPublicationIsRejected() {
  const fx = createFixture('default-branch-guard');
  fx.plan.remote.branch = 'main';
  let opened = false;
  await assert.rejects(
    runPhaseERemotePr({
      policyPath: fx.policyPath,
      schemaPath: guideSchema,
      plan: fx.plan,
      sourceReceiptPath: fx.receiptPath,
      repoRoot: fx.repo,
      runDir: fx.runDir,
      openPullRequest: async () => {
        opened = true;
        return {};
      },
      observePullRequest: async () => ({})
    }),
    error => error?.code === 'PHASE_E_PLAN_UNSAFE'
  );
  assert.equal(opened, false);
  const remoteMain = gitOut(fx.repo, ['ls-remote', '--heads', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  assert.equal(remoteMain, fx.baseCommit);
  assert.equal(gitOut(fx.repo, ['rev-parse', 'main']), fx.baseCommit);
}

await testPendingThenHumanGate();
await testFailedRequiredCheckBlocks();
await testRemoteBranchDivergenceFailsClosed();
await testRemoteBaseMovementFailsClosed();
await testDefaultBranchPublicationIsRejected();
console.log('Phase E remote publication regression tests passed.');
