import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDryRunController } from './dry-run-controller.mjs';
import { validateJsonSchema } from './json-schema-lite.mjs';
import { applyAssignmentPlan } from '../work-queues/assign-work-queue.mjs';
import { claimAssignment } from '../work-queues/claim-work-queue.mjs';
import { markReadyForApply } from '../work-queues/mark-work-queue-ready.mjs';
import { applyAdvancePlan } from '../work-queues/advance-work-queue.mjs';
import { blockWorkQueueTask } from '../work-queues/block-work-queue.mjs';
import { acquireRepositoryWriterLock } from '../reliability/single-writer-lock.mjs';
import {
  branchRef,
  buildCommitMessage,
  createCandidateCommit,
  currentSymbolicHead,
  git,
  gitOutput,
  projectionMatches,
  refValue,
  repoRoot
} from '../reliability/git-transaction-core.mjs';

const planSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-d-plan.schema.json');
const stateSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-d-state.schema.json');
const receiptSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-d-receipt.schema.json');
const activeQueueStatuses = new Set(['assigned', 'claimed', 'working', 'blocked', 'ready_for_apply', 'needs_reconcile']);
const dependencySatisfiedStatuses = new Set(['completed', 'resolved']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function unique(values) {
  return [...new Set(values)];
}

function sanitizeSegment(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'loop';
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function safeLiteralScope(value) {
  const normalized = normalizePath(value);
  return normalized &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').includes('..') &&
    !/[?*\[\]{}]/.test(normalized);
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let output = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        output += '.*';
        index += 1;
      } else {
        output += '[^/]*';
      }
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${output}$`);
}

function matchesAny(file, patterns) {
  const normalized = normalizePath(file);
  return patterns.some(pattern => globToRegExp(pattern).test(normalized));
}

function scopeContains(scopeRoot, file) {
  const root = normalizePath(scopeRoot);
  const candidate = normalizePath(file);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function scopesOverlap(a, b) {
  const left = normalizePath(a).toLowerCase();
  const right = normalizePath(b).toLowerCase();
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function semanticScopesOverlap(a, b) {
  const left = String(a).trim().toLowerCase().replace(/[.:]+/g, '/').replace(/\/+$/, '');
  const right = String(b).trim().toLowerCase().replace(/[.:]+/g, '/').replace(/\/+$/, '');
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function sameSource(a, b) {
  return a?.path === b?.path && a?.revisionType === b?.revisionType && a?.revision === b?.revision;
}

function validateWithSchema(value, schemaFile, code, label) {
  const schema = readJson(schemaFile);
  const validation = validateJsonSchema(value, schema);
  if (!validation.valid) {
    const error = new Error(`${label} validation failed with ${validation.errors.length} error(s).`);
    error.code = code;
    error.validationErrors = validation.errors;
    throw error;
  }
}

function defaultRunDir(queueDir, repository, loopId) {
  const queueRoot = path.dirname(path.resolve(queueDir));
  const dataRoot = path.dirname(queueRoot);
  return path.join(dataRoot, 'loop-runs', repository.replace('/', '--'), sanitizeSegment(loopId));
}

function worktreePath(root, suffix) {
  const key = crypto.createHash('sha256').update(repoRoot(root)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'loop-engineering-workers', key, suffix);
}

function collectChangedFiles(worktreeDir) {
  const names = [];
  for (const args of [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['ls-files', '--others', '--exclude-standard']
  ]) {
    const result = git(worktreeDir, args, { allowFailure: true });
    if (result.status === 0 && result.stdout.trim()) names.push(...result.stdout.trim().split(/\r?\n/));
  }
  return unique(names.map(normalizePath).filter(Boolean)).sort();
}

function removeCleanWorktree(root, workerDir) {
  if (!workerDir || !fs.existsSync(workerDir)) return true;
  let head;
  try {
    head = gitOutput(workerDir, ['rev-parse', 'HEAD']);
  } catch {
    return false;
  }
  if (!projectionMatches(workerDir, head)) return false;
  return git(root, ['worktree', 'remove', workerDir], { allowFailure: true }).status === 0;
}

function emptyUsage() {
  return {
    modelTokens: 0,
    externalCost: 0,
    implementationReported: false,
    verificationReported: false
  };
}

function recordUsage(usage, result, source) {
  const candidate = result?.usage;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
  const modelTokens = candidate.modelTokens ?? 0;
  const externalCost = candidate.externalCost ?? 0;
  if (!Number.isInteger(modelTokens) || modelTokens < 0) throw new Error(`${source} usage.modelTokens must be an integer >= 0.`);
  if (typeof externalCost !== 'number' || !Number.isFinite(externalCost) || externalCost < 0) {
    throw new Error(`${source} usage.externalCost must be a finite number >= 0.`);
  }
  usage.modelTokens += modelTokens;
  usage.externalCost += externalCost;
  if (source === 'implementation') usage.implementationReported = true;
  if (source === 'verification') usage.verificationReported = true;
}

function normalizeVerification(result, requiredRequirements) {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const rawStatus = ['pass', 'fail', 'uncertain'].includes(value.status) ? value.status : 'uncertain';
  const checks = Array.isArray(value.checks)
    ? value.checks.map(check => ({
        name: String(check?.name ?? 'unnamed-check'),
        status: ['pass', 'fail', 'uncertain', 'not_run'].includes(check?.status) ? check.status : 'uncertain',
        evidence: check?.evidence == null ? null : String(check.evidence)
      }))
    : [];
  const satisfiedRequirements = Array.isArray(value.satisfiedRequirements)
    ? unique(value.satisfiedRequirements.map(String))
    : [];
  const missing = requiredRequirements.filter(requirement => !satisfiedRequirements.includes(requirement));
  const checksPass = checks.length > 0 && checks.every(check => check.status === 'pass');
  const status = rawStatus === 'pass' && checksPass && missing.length === 0 ? 'pass' : rawStatus === 'pass' ? 'fail' : rawStatus;
  return { status, checks, satisfiedRequirements, missingRequirements: missing };
}

function wallClockMinutes(startedAt, currentAt) {
  const start = Date.parse(startedAt);
  const current = Date.parse(currentAt);
  if (!Number.isFinite(start) || !Number.isFinite(current) || current < start) return 0;
  return (current - start) / 60000;
}

function aggregateUsage(workerResults, integrationUsage, startedAt, currentAt) {
  return {
    modelTokens: workerResults.reduce((sum, worker) => sum + (worker.usage?.modelTokens ?? 0), 0) + (integrationUsage?.modelTokens ?? 0),
    externalCost: workerResults.reduce((sum, worker) => sum + (worker.usage?.externalCost ?? 0), 0) + (integrationUsage?.externalCost ?? 0),
    wallClockMinutes: wallClockMinutes(startedAt, currentAt)
  };
}

function budgetIssue(policy, workerResults, integrationUsage, startedAt, currentAt, { integrationRan = false } = {}) {
  const usage = aggregateUsage(workerResults, integrationUsage, startedAt, currentAt);
  if (policy.budget?.maxWallClockMinutes != null && usage.wallClockMinutes >= policy.budget.maxWallClockMinutes) return { reason: 'max_wall_clock', usage };
  if (policy.budget?.maxModelTokens != null) {
    const workerMissing = workerResults.some(worker => !worker.usage?.implementationReported || !worker.usage?.verificationReported);
    const integrationMissing = integrationRan && integrationUsage?.verificationReported !== true;
    if (workerMissing || integrationMissing) return { reason: 'model_token_usage_unreported', usage };
    if (usage.modelTokens >= policy.budget.maxModelTokens) return { reason: 'max_model_tokens', usage };
  }
  if (policy.budget?.maxExternalCost != null) {
    const workerMissing = workerResults.some(worker => !worker.usage?.implementationReported || !worker.usage?.verificationReported);
    const integrationMissing = integrationRan && integrationUsage?.verificationReported !== true;
    if (workerMissing || integrationMissing) return { reason: 'external_cost_usage_unreported', usage };
    if (usage.externalCost >= policy.budget.maxExternalCost) return { reason: 'max_external_cost', usage };
  }
  return { reason: null, usage };
}

function loadQueue(queueDir) {
  const control = readJson(path.join(queueDir, 'control.json'));
  const items = new Map();
  const itemsDir = path.join(queueDir, 'items');
  for (const name of fs.readdirSync(itemsDir).filter(name => name.endsWith('.json'))) {
    const item = readJson(path.join(itemsDir, name));
    items.set(item.taskId, item);
  }
  const lanes = new Map();
  for (const laneName of control.workerLanes ?? []) {
    lanes.set(laneName, readJson(path.join(queueDir, 'lanes', `${laneName}.json`)));
  }
  return { control, items, lanes };
}

function assertPhaseDPolicy(policy, plan) {
  const errors = [];
  if ((policy.autonomyLevel ?? 'L1_WORKTREE') !== 'L1_WORKTREE') errors.push('autonomyLevel must remain L1_WORKTREE');
  if (policy.scope?.workingBranchPolicy !== 'isolated_worktree') errors.push('workingBranchPolicy must be isolated_worktree');
  if (policy.permissions?.repositoryRead !== true) errors.push('repositoryRead permission is required');
  if (policy.permissions?.workingBranchWrite !== true) errors.push('workingBranchWrite permission is required');
  if (policy.permissions?.commit !== true) errors.push('commit permission is required');
  if (policy.permissions?.defaultBranchWrite !== false) errors.push('defaultBranchWrite must remain false');
  if (policy.permissions?.merge !== false) errors.push('merge must remain false');
  if (policy.permissions?.deploy !== false) errors.push('deploy must remain false');
  if (policy.permissions?.secretAccess !== false) errors.push('secretAccess must remain false');
  if (policy.verification?.protected !== true) errors.push('protected verification is required');
  if (policy.verification?.allowWorkerToModifyVerifier !== false) errors.push('worker verifier mutation must remain disabled');
  if (policy.verification?.minimumLevel === 'V0_SELF') errors.push('V0_SELF cannot be the Phase D completion oracle');
  if (!Number.isInteger(policy.budget?.maxParallelWorkers) || policy.budget.maxParallelWorkers < 2) errors.push('maxParallelWorkers must be >= 2');
  if (plan.tasks.length > (policy.budget?.maxParallelWorkers ?? 0)) errors.push('plan task count exceeds maxParallelWorkers');
  if (plan.tasks.length > (policy.budget?.maxIterations ?? 0)) errors.push('plan task count exceeds maxIterations attempt budget');
  if (errors.length > 0) {
    const error = new Error(`Loop policy is not eligible for Phase D: ${errors.join('; ')}`);
    error.code = 'PHASE_D_POLICY_UNSAFE';
    throw error;
  }
}

function assertPlanIdentity(policy, plan) {
  if (plan.repository !== policy.repository) throw new Error('Phase D plan repository does not match policy repository.');
  if (plan.loopId !== policy.loopId) throw new Error('Phase D plan loopId does not match policy loopId.');
  const taskIds = plan.tasks.map(task => task.taskId);
  const lanes = plan.tasks.map(task => task.lane);
  const holders = plan.tasks.map(task => task.holderId);
  if (new Set(taskIds).size !== taskIds.length) throw new Error('Phase D plan contains duplicate taskId values.');
  if (new Set(lanes).size !== lanes.length) throw new Error('Phase D plan contains duplicate lanes.');
  if (new Set(holders).size !== holders.length) throw new Error('Phase D plan contains duplicate holderId values.');
}

function assertPlanScopes(policy, plan) {
  for (const task of plan.tasks) {
    for (const scopePath of task.scopePaths) {
      if (!safeLiteralScope(scopePath)) throw new Error(`Phase D scopePaths must be literal safe relative prefixes: ${scopePath}`);
      if (!matchesAny(scopePath, policy.scope?.allowedPaths ?? [])) throw new Error(`Phase D scope is outside policy allowedPaths: ${scopePath}`);
      if (matchesAny(scopePath, policy.scope?.protectedPaths ?? [])) throw new Error(`Phase D scope overlaps protected path: ${scopePath}`);
    }
  }
  for (let leftIndex = 0; leftIndex < plan.tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plan.tasks.length; rightIndex += 1) {
      const left = plan.tasks[leftIndex];
      const right = plan.tasks[rightIndex];
      for (const leftPath of left.scopePaths) {
        for (const rightPath of right.scopePaths) {
          if (scopesOverlap(leftPath, rightPath)) throw new Error(`Phase D path scopes overlap: ${left.taskId}:${leftPath} <-> ${right.taskId}:${rightPath}`);
        }
      }
      for (const leftScope of left.semanticScopes) {
        for (const rightScope of right.semanticScopes) {
          if (semanticScopesOverlap(leftScope, rightScope)) throw new Error(`Phase D semantic scopes overlap: ${left.taskId}:${leftScope} <-> ${right.taskId}:${rightScope}`);
        }
      }
    }
  }
}

function assertQueueEligibility(queue, policy, plan) {
  const { control, items, lanes } = queue;
  if (control.repository !== policy.repository) throw new Error('Phase D queue repository does not match policy.');
  if (control.syncState !== 'synced') throw new Error(`Phase D requires synced queue; current=${control.syncState}.`);
  if (control.activeRunId !== null) throw new Error('Phase D requires queue activeRunId to be null before start.');

  const selected = new Set(plan.tasks.map(task => task.taskId));
  const unexpectedActive = [...items.values()].find(item => activeQueueStatuses.has(item.status) && !selected.has(item.taskId));
  if (unexpectedActive) throw new Error(`Phase D refuses overlapping write authority while task ${unexpectedActive.taskId} is active.`);

  for (const planned of plan.tasks) {
    const item = items.get(planned.taskId);
    const lane = lanes.get(planned.lane);
    if (!item) throw new Error(`Phase D task does not exist: ${planned.taskId}`);
    if (!lane) throw new Error(`Phase D lane does not exist: ${planned.lane}`);
    if (item.status !== 'queued' || item.assignedLane !== null) throw new Error(`Phase D task ${planned.taskId} is not queued/unassigned.`);
    if (item.role !== 'preparation') throw new Error(`Phase D task ${planned.taskId} role=${item.role} is not a preparation task.`);
    if (item.safeParallel !== true) throw new Error(`Phase D task ${planned.taskId} must declare safeParallel=true.`);
    if (!sameSource(item.sourceRequirements, control.requirements)) throw new Error(`Phase D task ${planned.taskId} is stale against current Requirements.`);
    if (!['idle', 'waiting'].includes(lane.state) || lane.currentTaskId !== null) throw new Error(`Phase D lane ${planned.lane} is not available.`);
    for (const dependencyId of item.dependencies ?? []) {
      if (selected.has(dependencyId)) throw new Error(`Phase D selected tasks are not independent; ${planned.taskId} depends on selected ${dependencyId}.`);
      const dependency = items.get(dependencyId);
      if (!dependency || !dependencySatisfiedStatuses.has(dependency.status)) {
        throw new Error(`Phase D task ${planned.taskId} dependency ${dependencyId} is not resolved.`);
      }
    }
  }
}

function assertPhaseAEvidence(phaseA, policy) {
  const blockers = [];
  if (!phaseA.repository?.exists || !phaseA.repository?.isGitRepository) blockers.push('repository_unavailable');
  if (phaseA.repository?.identityState !== 'matched') blockers.push(`repository_identity_${phaseA.repository?.identityState ?? 'unknown'}`);
  if (phaseA.repository?.dirty !== false) blockers.push('primary_repository_not_clean');
  if (phaseA.queue?.repository !== policy.repository) blockers.push('queue_repository_mismatch');
  if (phaseA.queue?.syncState !== 'synced') blockers.push('queue_not_synced');
  if (phaseA.queue?.requirementsEvidence?.revisionState !== 'matched') blockers.push('requirements_revision_not_matched');
  if (phaseA.queue?.requirementsEvidence?.workingTreeDirty !== false) blockers.push('requirements_worktree_dirty_or_unknown');
  if (blockers.length > 0) {
    const error = new Error(`Phase D preflight is not safe: ${blockers.join(', ')}`);
    error.code = 'PHASE_D_PREFLIGHT_NOT_SAFE';
    error.blockers = blockers;
    throw error;
  }
}

function readControl(runDir, policy) {
  const file = path.join(runDir, 'control.json');
  if (!fs.existsSync(file)) return { requestedAction: 'run', reason: null };
  const control = readJson(file);
  if (control.loopId !== policy.loopId || control.repository !== policy.repository) {
    throw new Error('Phase D control identity does not match policy.');
  }
  return control;
}

function currentTaskStatus(queueDir, taskId) {
  try {
    return readJson(path.join(queueDir, 'items', `${taskId}.json`)).status ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function persistState(runDir, state) {
  validateWithSchema(state, stateSchemaPath, 'INVALID_PHASE_D_STATE', 'Phase D state');
  writeJsonAtomic(path.join(runDir, 'phase-d-state.json'), state);
}

function initialState(policy, plan, phaseA, startedAt) {
  return {
    schemaVersion: 1,
    mode: 'phase_d_parallel',
    loopId: policy.loopId,
    repository: policy.repository,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    baseBranch: phaseA.repository.branch,
    baseCommit: phaseA.repository.head,
    generationRevision: phaseA.queue.generationRevision,
    workers: plan.tasks.map(task => ({
      taskId: task.taskId,
      lane: task.lane,
      holderId: task.holderId,
      scopePaths: task.scopePaths.map(normalizePath),
      semanticScopes: task.semanticScopes,
      assignmentRevision: null,
      status: 'planned',
      workerBranch: null,
      candidateCommit: null,
      changedFiles: [],
      verificationStatus: 'not_run',
      usage: emptyUsage()
    })),
    integration: {
      branch: null,
      order: [],
      head: null,
      status: 'not_started',
      verificationStatus: 'not_run',
      conflictTaskId: null
    },
    aggregateUsage: { modelTokens: 0, externalCost: 0, wallClockMinutes: 0 },
    unresolvedItems: []
  };
}

function assertWorkerScope(policy, taskPlan, changedFiles) {
  if (changedFiles.length === 0) throw new Error(`Phase D worker ${taskPlan.taskId} produced no repository change.`);
  for (const file of changedFiles) {
    if (matchesAny(file, policy.scope?.protectedPaths ?? [])) throw new Error(`Worker ${taskPlan.taskId} changed protected path: ${file}`);
    if (!taskPlan.scopePaths.some(scopePath => scopeContains(scopePath, file))) {
      throw new Error(`Worker ${taskPlan.taskId} changed file outside its exclusive scope: ${file}`);
    }
  }
}

function makeWorkerBranch(policy, taskId) {
  return `loop/${sanitizeSegment(policy.loopId)}/${sanitizeSegment(taskId)}-d1`;
}

function makeIntegrationBranch(policy) {
  return `loop/${sanitizeSegment(policy.loopId)}/integration-d1`;
}

function effectivePermissions(policy) {
  return {
    requestedByPolicy: { ...policy.permissions },
    effectiveForPhaseD: {
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
    guardedOverride: true
  };
}

function blockOwnedWorkers(queueDir, state, now, unresolvedItems) {
  for (const worker of state.workers) {
    if (worker.assignmentRevision == null) continue;
    const status = currentTaskStatus(queueDir, worker.taskId);
    if (status === 'blocked') continue;
    if (status !== 'working') {
      unresolvedItems.push(`queue_block_not_applicable:${worker.taskId}:${status}`);
      continue;
    }
    try {
      blockWorkQueueTask(queueDir, {
        schemaVersion: 1,
        repository: state.repository,
        lane: worker.lane,
        taskId: worker.taskId,
        expectedGenerationRevision: state.generationRevision,
        expectedAssignmentRevision: worker.assignmentRevision,
        holderId: worker.holderId
      }, { now });
      worker.status = 'blocked';
    } catch (error) {
      unresolvedItems.push(`queue_block_failed:${worker.taskId}:${error.code ?? error.name ?? 'error'}`);
    }
  }
}

function terminalState(status) {
  return ['passed', 'failed', 'blocked', 'budget_exhausted', 'cancelled', 'needs_reconcile'].includes(status);
}

export async function runPhaseDParallel({
  policyPath,
  schemaPath,
  plan,
  planPath = null,
  queueDir,
  repoRoot: targetRepoRoot,
  runDir = null,
  implement,
  verify,
  verifyIntegration,
  now = () => new Date().toISOString()
}) {
  if (typeof implement !== 'function') throw new Error('implement callback is required.');
  if (typeof verify !== 'function') throw new Error('verify callback is required.');
  if (typeof verifyIntegration !== 'function') throw new Error('verifyIntegration callback is required.');

  const policy = readJson(path.resolve(policyPath));
  const policySchema = readJson(path.resolve(schemaPath));
  const policyValidation = validateJsonSchema(policy, policySchema);
  if (!policyValidation.valid) {
    const error = new Error(`Loop policy validation failed with ${policyValidation.errors.length} error(s).`);
    error.code = 'INVALID_LOOP_POLICY';
    error.validationErrors = policyValidation.errors;
    throw error;
  }
  const resolvedPlan = plan ?? readJson(path.resolve(planPath));
  validateWithSchema(resolvedPlan, planSchemaPath, 'INVALID_PHASE_D_PLAN', 'Phase D plan');
  assertPlanIdentity(policy, resolvedPlan);
  assertPhaseDPolicy(policy, resolvedPlan);
  assertPlanScopes(policy, resolvedPlan);

  const startedAt = now();
  const finalRunDir = path.resolve(runDir ?? defaultRunDir(queueDir, policy.repository, policy.loopId));
  fs.mkdirSync(finalRunDir, { recursive: true });
  const existingStateFile = path.join(finalRunDir, 'phase-d-state.json');
  if (fs.existsSync(existingStateFile)) {
    const existing = readJson(existingStateFile);
    validateWithSchema(existing, stateSchemaPath, 'INVALID_PHASE_D_STATE', 'Phase D state');
    if (!terminalState(existing.status)) {
      existing.status = 'needs_reconcile';
      existing.completedAt = startedAt;
      existing.updatedAt = startedAt;
      existing.unresolvedItems = unique([...(existing.unresolvedItems ?? []), 'previous_parallel_run_did_not_reach_terminal_state']);
      persistState(finalRunDir, existing);
      return { state: existing, receipt: null, receiptPath: null };
    }
    throw new Error(`Phase D run state already exists with terminal status=${existing.status}; use a new loopId for a new run.`);
  }

  const phaseA = runDryRunController({ policyPath, schemaPath, queueDir, repoRoot: targetRepoRoot, now: startedAt });
  assertPhaseAEvidence(phaseA, policy);
  const queue = loadQueue(queueDir);
  assertQueueEligibility(queue, policy, resolvedPlan);

  const root = repoRoot(targetRepoRoot);
  const baseBranch = phaseA.repository.branch;
  const baseCommit = phaseA.repository.head;
  if (!baseBranch || !baseCommit) throw new Error('Phase D requires an attached base branch and base commit.');
  const targetRef = branchRef(baseBranch);
  if (currentSymbolicHead(root) !== targetRef || refValue(root, targetRef) !== baseCommit || !projectionMatches(root, baseCommit)) {
    throw new Error('Phase D target repository changed after preflight.');
  }

  const state = initialState(policy, resolvedPlan, phaseA, startedAt);
  persistState(finalRunDir, state);
  const unresolvedItems = state.unresolvedItems;
  const workerRuntime = new Map();
  const integrationUsage = emptyUsage();
  let integrationDir = null;
  let writerLock = null;
  let finalState = 'failed';
  let integrationVerification = { status: 'not_run', satisfiedRequirements: [], checks: [] };

  const updateState = (status = state.status) => {
    state.status = status;
    state.updatedAt = now();
    state.aggregateUsage = aggregateUsage(state.workers, integrationUsage, startedAt, state.updatedAt);
    persistState(finalRunDir, state);
  };

  const cancelled = () => readControl(finalRunDir, policy).requestedAction === 'cancel';
  const paused = () => readControl(finalRunDir, policy).requestedAction === 'pause';

  const finalize = () => {
    for (const runtime of workerRuntime.values()) {
      if (!runtime.worktreeDir || !fs.existsSync(runtime.worktreeDir)) continue;
      try {
        const removed = removeCleanWorktree(root, runtime.worktreeDir);
        if (!removed) unresolvedItems.push(`worker_worktree_requires_recovery:${runtime.taskId}`);
      } catch {
        unresolvedItems.push(`worker_worktree_cleanup_failed:${runtime.taskId}`);
      }
    }
    if (integrationDir && fs.existsSync(integrationDir)) {
      try {
        const removed = removeCleanWorktree(root, integrationDir);
        if (!removed) unresolvedItems.push('integration_worktree_requires_recovery');
      } catch {
        unresolvedItems.push('integration_worktree_cleanup_failed');
      }
    }

    const baseBranchUnchanged = refValue(root, targetRef) === baseCommit && projectionMatches(root, baseCommit);
    if (!baseBranchUnchanged) {
      unresolvedItems.push('base_branch_changed');
      finalState = 'needs_reconcile';
    }

    try {
      writerLock?.release();
    } catch {
      unresolvedItems.push('repository_writer_lock_release_failed');
      finalState = 'needs_reconcile';
    }

    const finishedAt = now();
    state.status = finalState;
    state.completedAt = finishedAt;
    state.updatedAt = finishedAt;
    state.aggregateUsage = aggregateUsage(state.workers, integrationUsage, startedAt, finishedAt);
    state.unresolvedItems = unique(unresolvedItems);
    persistState(finalRunDir, state);

    const receipt = {
      schemaVersion: 1,
      receiptId: `${sanitizeSegment(policy.loopId)}-phase-d-${finishedAt.replace(/[^0-9]/g, '').slice(0, 14) || 'time'}`,
      mode: 'phase_d_parallel',
      loopId: policy.loopId,
      repository: policy.repository,
      startedAt,
      finishedAt,
      finalState,
      baseBranch,
      baseCommit,
      baseBranchUnchanged,
      workers: state.workers.map(worker => {
        const runtime = workerRuntime.get(worker.taskId);
        return {
          taskId: worker.taskId,
          lane: worker.lane,
          holderId: worker.holderId,
          scopePaths: worker.scopePaths,
          semanticScopes: worker.semanticScopes,
          assignmentRevision: worker.assignmentRevision,
          workerBranch: worker.workerBranch,
          candidateCommit: worker.candidateCommit,
          changedFiles: worker.changedFiles,
          verification: runtime?.verification ?? { status: worker.verificationStatus, satisfiedRequirements: [], checks: [] },
          usage: worker.usage,
          finalTaskStatus: currentTaskStatus(queueDir, worker.taskId)
        };
      }),
      integration: {
        branch: state.integration.branch,
        order: state.integration.order,
        head: state.integration.head,
        status: state.integration.status === 'passed' ? 'passed' : state.integration.status === 'conflict' ? 'conflict' : state.integration.status === 'not_started' ? 'not_started' : 'failed',
        verification: integrationVerification,
        conflictTaskId: state.integration.conflictTaskId
      },
      aggregateUsage: state.aggregateUsage,
      unresolvedItems: state.unresolvedItems
    };
    validateWithSchema(receipt, receiptSchemaPath, 'INVALID_PHASE_D_RECEIPT', 'Phase D receipt');
    const receiptPath = path.join(finalRunDir, `${receipt.receiptId}.json`);
    writeJsonAtomic(receiptPath, receipt);
    return { state, receipt, receiptPath };
  };

  try {
    if (cancelled()) {
      finalState = 'cancelled';
      unresolvedItems.push('cancelled_before_assignment');
      return finalize();
    }
    if (paused()) {
      finalState = 'blocked';
      unresolvedItems.push('pause_requested_before_parallel_assignment');
      return finalize();
    }

    writerLock = acquireRepositoryWriterLock(root, {
      transactionId: `${sanitizeSegment(policy.loopId)}-phase-d`,
      branch: baseBranch,
      baseCommit
    });

    applyAssignmentPlan(queueDir, {
      schemaVersion: 1,
      repository: policy.repository,
      expectedGenerationRevision: state.generationRevision,
      assignments: resolvedPlan.tasks.map(task => ({ lane: task.lane, taskId: task.taskId }))
    }, { now: now() });

    for (const worker of state.workers) {
      const assigned = readJson(path.join(queueDir, 'items', `${worker.taskId}.json`));
      worker.assignmentRevision = assigned.assignmentRevision;
      claimAssignment(queueDir, {
        schemaVersion: 1,
        repository: policy.repository,
        lane: worker.lane,
        expectedGenerationRevision: state.generationRevision,
        expectedAssignmentRevision: worker.assignmentRevision,
        holderId: worker.holderId
      }, { now: now() });
      worker.status = 'claimed';
    }
    updateState('running');

    for (const worker of state.workers) {
      const workerBranch = makeWorkerBranch(policy, worker.taskId);
      const workerRef = branchRef(workerBranch);
      if (refValue(root, workerRef)) throw new Error(`Phase D worker branch already exists: ${workerBranch}`);
      const suffix = `${sanitizeSegment(policy.loopId)}-${sanitizeSegment(worker.taskId)}-d1`;
      const workerDir = worktreePath(root, suffix);
      if (fs.existsSync(workerDir)) throw new Error(`Phase D worker worktree already exists: ${workerDir}`);
      fs.mkdirSync(path.dirname(workerDir), { recursive: true });
      git(root, ['worktree', 'add', '-b', workerBranch, workerDir, baseCommit]);
      worker.workerBranch = workerBranch;
      worker.status = 'working';
      workerRuntime.set(worker.taskId, {
        taskId: worker.taskId,
        worktreeDir: workerDir,
        workerBranch,
        verification: { status: 'not_run', satisfiedRequirements: [], checks: [] }
      });
    }
    updateState('running');

    const permissions = effectivePermissions(policy);
    const results = await Promise.allSettled(state.workers.map(async worker => {
      const runtime = workerRuntime.get(worker.taskId);
      const task = readJson(path.join(queueDir, 'items', `${worker.taskId}.json`));
      const taskPlan = resolvedPlan.tasks.find(candidate => candidate.taskId === worker.taskId);
      const implementationResult = await implement({
        worktreeDir: runtime.worktreeDir,
        repository: policy.repository,
        task,
        taskPlan,
        policy,
        permissions,
        baseBranch,
        baseCommit,
        workerBranch: runtime.workerBranch,
        attempt: 1
      });
      recordUsage(worker.usage, implementationResult, 'implementation');
      worker.changedFiles = collectChangedFiles(runtime.worktreeDir);
      assertWorkerScope(policy, taskPlan, worker.changedFiles);
      if (refValue(root, targetRef) !== baseCommit || !projectionMatches(root, baseCommit)) {
        throw new Error('Base branch changed during Phase D worker implementation.');
      }
      const commitMessage = buildCommitMessage({
        commitMessage: `Loop Phase D: ${worker.taskId}`,
        transactionId: `${sanitizeSegment(policy.loopId)}-${sanitizeSegment(worker.taskId)}-d1`,
        producer: 'automation'
      });
      worker.candidateCommit = createCandidateCommit(runtime.worktreeDir, commitMessage);
      if (!worker.candidateCommit) throw new Error(`Phase D worker ${worker.taskId} produced no candidate commit.`);
      if (refValue(root, branchRef(runtime.workerBranch)) !== worker.candidateCommit) throw new Error(`Phase D worker branch ref mismatch for ${worker.taskId}.`);

      const requiredRequirements = unique([...(policy.verification?.requiredChecks ?? []), ...(task.validationRequirements ?? [])]);
      const rawVerification = await verify({
        worktreeDir: runtime.worktreeDir,
        repository: policy.repository,
        task,
        taskPlan,
        policy,
        permissions,
        baseBranch,
        baseCommit,
        workerBranch: runtime.workerBranch,
        candidateCommit: worker.candidateCommit,
        changedFiles: worker.changedFiles,
        requiredRequirements
      });
      recordUsage(worker.usage, rawVerification, 'verification');
      const verification = normalizeVerification(rawVerification, requiredRequirements);
      runtime.verification = {
        status: verification.status,
        satisfiedRequirements: verification.satisfiedRequirements,
        checks: verification.checks
      };
      worker.verificationStatus = verification.status;
      const headAfterVerification = gitOutput(runtime.worktreeDir, ['rev-parse', 'HEAD']);
      if (headAfterVerification !== worker.candidateCommit || !projectionMatches(runtime.worktreeDir, worker.candidateCommit)) {
        throw new Error(`Verifier mutated worker projection for ${worker.taskId}.`);
      }
      if (verification.status !== 'pass') throw new Error(`Worker verification ${verification.status} for ${worker.taskId}.`);
      worker.status = 'verified';
      return worker.taskId;
    }));

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const worker = state.workers[index];
        worker.status = 'failed';
        unresolvedItems.push(`worker_failed:${worker.taskId}:${result.reason?.code ?? result.reason?.name ?? 'error'}`);
      }
    });
    updateState('running');

    if (results.some(result => result.status === 'rejected')) {
      finalState = 'failed';
      blockOwnedWorkers(queueDir, state, now(), unresolvedItems);
      return finalize();
    }

    let budget = budgetIssue(policy, state.workers, integrationUsage, startedAt, now());
    state.aggregateUsage = budget.usage;
    if (budget.reason) {
      finalState = 'budget_exhausted';
      unresolvedItems.push(`budget:${budget.reason}`);
      blockOwnedWorkers(queueDir, state, now(), unresolvedItems);
      return finalize();
    }
    if (cancelled()) {
      finalState = 'cancelled';
      unresolvedItems.push('cancelled_before_integration');
      blockOwnedWorkers(queueDir, state, now(), unresolvedItems);
      return finalize();
    }

    state.status = 'integrating';
    state.integration.order = [...state.workers].map(worker => worker.taskId).sort();
    state.integration.branch = makeIntegrationBranch(policy);
    state.integration.status = 'applying';
    updateState('integrating');

    const integrationBranch = state.integration.branch;
    if (refValue(root, branchRef(integrationBranch))) throw new Error(`Phase D integration branch already exists: ${integrationBranch}`);
    integrationDir = worktreePath(root, `${sanitizeSegment(policy.loopId)}-integration-d1`);
    if (fs.existsSync(integrationDir)) throw new Error(`Phase D integration worktree already exists: ${integrationDir}`);
    fs.mkdirSync(path.dirname(integrationDir), { recursive: true });
    git(root, ['worktree', 'add', '-b', integrationBranch, integrationDir, baseCommit]);

    for (const taskId of state.integration.order) {
      const worker = state.workers.find(candidate => candidate.taskId === taskId);
      const cherryPick = git(integrationDir, ['cherry-pick', worker.candidateCommit], { allowFailure: true });
      if (cherryPick.status !== 0) {
        git(integrationDir, ['cherry-pick', '--abort'], { allowFailure: true });
        state.integration.status = 'conflict';
        state.integration.conflictTaskId = taskId;
        unresolvedItems.push(`integration_conflict:${taskId}`);
        finalState = 'blocked';
        blockOwnedWorkers(queueDir, state, now(), unresolvedItems);
        return finalize();
      }
    }

    state.integration.head = gitOutput(integrationDir, ['rev-parse', 'HEAD']);
    state.integration.status = 'verifying';
    updateState('integrating');

    const integrationRequirements = unique([...(policy.verification?.requiredChecks ?? []), ...(resolvedPlan.integration.requiredChecks ?? [])]);
    const rawIntegrationVerification = await verifyIntegration({
      worktreeDir: integrationDir,
      repository: policy.repository,
      policy,
      permissions,
      baseBranch,
      baseCommit,
      integrationBranch,
      integrationHead: state.integration.head,
      order: state.integration.order,
      workers: state.workers,
      requiredRequirements: integrationRequirements
    });
    recordUsage(integrationUsage, rawIntegrationVerification, 'verification');
    const normalizedIntegration = normalizeVerification(rawIntegrationVerification, integrationRequirements);
    integrationVerification = {
      status: normalizedIntegration.status,
      satisfiedRequirements: normalizedIntegration.satisfiedRequirements,
      checks: normalizedIntegration.checks
    };
    state.integration.verificationStatus = normalizedIntegration.status;
    const integrationTreeClean = gitOutput(integrationDir, ['rev-parse', 'HEAD']) === state.integration.head && projectionMatches(integrationDir, state.integration.head);
    if (!integrationTreeClean) unresolvedItems.push('integration_verifier_mutated_projection');
    if (refValue(root, targetRef) !== baseCommit || !projectionMatches(root, baseCommit)) unresolvedItems.push('base_branch_changed_during_integration');

    budget = budgetIssue(policy, state.workers, integrationUsage, startedAt, now(), { integrationRan: true });
    state.aggregateUsage = budget.usage;
    if (budget.reason) {
      finalState = 'budget_exhausted';
      unresolvedItems.push(`budget:${budget.reason}`);
      blockOwnedWorkers(queueDir, state, now(), unresolvedItems);
      return finalize();
    }
    if (cancelled()) {
      finalState = 'cancelled';
      unresolvedItems.push('cancelled_before_completion');
      blockOwnedWorkers(queueDir, state, now(), unresolvedItems);
      return finalize();
    }
    if (normalizedIntegration.status !== 'pass' || !integrationTreeClean || unresolvedItems.length > 0) {
      state.integration.status = 'failed';
      finalState = normalizedIntegration.status === 'uncertain' ? 'blocked' : 'failed';
      blockOwnedWorkers(queueDir, state, now(), unresolvedItems);
      return finalize();
    }

    state.integration.status = 'passed';
    updateState('integrating');

    for (const taskId of state.integration.order) {
      const worker = state.workers.find(candidate => candidate.taskId === taskId);
      markReadyForApply(queueDir, {
        schemaVersion: 1,
        repository: policy.repository,
        lane: worker.lane,
        taskId: worker.taskId,
        expectedGenerationRevision: state.generationRevision,
        expectedAssignmentRevision: worker.assignmentRevision,
        holderId: worker.holderId,
        completionVerified: true,
        validationVerified: true
      }, { now: now() });
      applyAdvancePlan(queueDir, {
        schemaVersion: 1,
        repository: policy.repository,
        expectedGenerationRevision: state.generationRevision,
        lane: worker.lane,
        taskId: worker.taskId,
        completionVerified: true,
        validationVerified: true,
        nextTaskId: null
      }, { now: now() });
      worker.status = 'completed';
    }

    finalState = 'passed';
    return finalize();
  } catch (error) {
    unresolvedItems.push(`phase_d_error:${error.code ?? error.name ?? 'error'}`);
    if (state.workers.some(worker => worker.assignmentRevision != null)) {
      blockOwnedWorkers(queueDir, state, now(), unresolvedItems);
    }
    finalState = state.workers.some(worker => worker.assignmentRevision != null) ? 'needs_reconcile' : 'failed';
    return finalize();
  }
}
