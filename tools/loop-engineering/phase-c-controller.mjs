import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runDryRunController } from './dry-run-controller.mjs';
import { runPhaseBWorker } from './phase-b-worker-controller.mjs';
import { validateJsonSchema } from './json-schema-lite.mjs';
import { blockWorkQueueTask } from '../work-queues/block-work-queue.mjs';
import { branchRef, projectionMatches, refValue, repoRoot } from '../reliability/git-transaction-core.mjs';

const stateSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-c-state.schema.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function policyFingerprint(policyPath) {
  return sha256(fs.readFileSync(path.resolve(policyPath)));
}

function defaultRunDir(queueDir, repository, loopId) {
  const queueRoot = path.dirname(path.resolve(queueDir));
  const dataRoot = path.dirname(queueRoot);
  return path.join(dataRoot, 'loop-runs', repository.replace('/', '--'), String(loopId).toLowerCase());
}

function validateState(state) {
  const schema = readJson(stateSchemaPath);
  const validation = validateJsonSchema(state, schema);
  if (!validation.valid) {
    const error = new Error(`Phase C state validation failed with ${validation.errors.length} error(s).`);
    error.code = 'INVALID_PHASE_C_STATE';
    error.validationErrors = validation.errors;
    throw error;
  }
}

function loadQueueState(queueDir, lane, taskId) {
  return {
    control: readJson(path.join(queueDir, 'control.json')),
    lane: readJson(path.join(queueDir, 'lanes', `${lane}.json`)),
    item: readJson(path.join(queueDir, 'items', `${taskId}.json`))
  };
}

function loadControl(runDir, loopId, repository) {
  const file = path.join(runDir, 'control.json');
  if (!fs.existsSync(file)) return { requestedAction: 'run', requestedAt: null, reason: null };
  const control = readJson(file);
  if (control.loopId !== loopId || control.repository !== repository) {
    const error = new Error('Phase C control identity does not match current run.');
    error.code = 'PHASE_C_CONTROL_MISMATCH';
    throw error;
  }
  return control;
}

function normalizeFailureParts(receipt) {
  const checks = (receipt.verification?.checks ?? [])
    .filter(check => check.status !== 'pass')
    .map(check => `${String(check.name).toLowerCase()}:${check.status}`)
    .sort();
  const unresolved = (receipt.unresolvedItems ?? [])
    .map(value => String(value)
      .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
      .replace(/\b\d{4}-\d{2}-\d{2}t[^\s]+/gi, '<time>')
      .replace(/\b\d+\b/g, '<n>')
      .toLowerCase())
    .sort();
  return {
    finalState: receipt.finalState,
    verificationStatus: receipt.verification?.status ?? 'not_run',
    failingChecks: checks,
    unresolved
  };
}

function failureSignature(receipt) {
  if (receipt.finalState === 'passed') return null;
  return sha256(JSON.stringify(normalizeFailureParts(receipt)));
}

function wallClockMinutes(startedAt, currentAt) {
  const start = Date.parse(startedAt);
  const current = Date.parse(currentAt);
  if (!Number.isFinite(start) || !Number.isFinite(current) || current < start) return 0;
  return (current - start) / 60000;
}

function computeBudgetUsage(state, now) {
  return {
    iterations: state.attempts.length,
    modelTokens: state.attempts.reduce((sum, attempt) => sum + (attempt.usage?.modelTokens ?? 0), 0),
    externalCost: state.attempts.reduce((sum, attempt) => sum + (attempt.usage?.externalCost ?? 0), 0),
    wallClockMinutes: wallClockMinutes(state.startedAt, now)
  };
}

function budgetStatus(policy, state, now) {
  const usage = computeBudgetUsage(state, now);
  const budget = policy.budget ?? {};
  if (usage.iterations >= budget.maxIterations) return { exhausted: true, reason: 'max_iterations', usage };
  if (budget.maxWallClockMinutes != null && usage.wallClockMinutes >= budget.maxWallClockMinutes) {
    return { exhausted: true, reason: 'max_wall_clock', usage };
  }
  if (budget.maxModelTokens != null && usage.modelTokens >= budget.maxModelTokens) {
    return { exhausted: true, reason: 'max_model_tokens', usage };
  }
  if (budget.maxExternalCost != null && usage.externalCost >= budget.maxExternalCost) {
    return { exhausted: true, reason: 'max_external_cost', usage };
  }
  return { exhausted: false, reason: null, usage };
}

function finiteBudgetUsageIsObservable(policy, receipt) {
  const missing = [];
  if (policy.budget?.maxModelTokens != null) {
    if (receipt.usage?.implementationReported !== true || receipt.usage?.verificationReported !== true) missing.push('model_token_usage_unreported');
  }
  if (policy.budget?.maxExternalCost != null) {
    if (receipt.usage?.implementationReported !== true || receipt.usage?.verificationReported !== true) missing.push('external_cost_usage_unreported');
  }
  return missing;
}

function terminal(status) {
  return ['passed', 'failed', 'stuck', 'blocked', 'budget_exhausted', 'cancelled', 'needs_reconcile'].includes(status);
}

function statePath(runDir) {
  return path.join(runDir, 'state.json');
}

function persistState(runDir, state) {
  validateState(state);
  writeJsonAtomic(statePath(runDir), state);
  return state;
}

function activeWorkerBranchExists(root, state) {
  const nextAttempt = state.attempts.length + 1;
  const branch = `loop/${String(state.loopId).toLowerCase()}/${String(state.taskId).toLowerCase()}-a${nextAttempt}`;
  return Boolean(refValue(root, branchRef(branch)));
}

function reconcileExistingState({ state, policy, policyHash, queueDir, targetRepoRoot, runDir, now }) {
  const unresolved = [];
  if (state.policyFingerprint !== policyHash) unresolved.push('policy_revision_changed');
  if (state.loopId !== policy.loopId || state.repository !== policy.repository) unresolved.push('run_identity_changed');

  const root = repoRoot(targetRepoRoot);
  const baseRef = branchRef(state.repositoryBaseline.baseBranch);
  if (refValue(root, baseRef) !== state.repositoryBaseline.baseCommit || !projectionMatches(root, state.repositoryBaseline.baseCommit)) {
    unresolved.push('repository_baseline_changed_or_dirty');
  }

  let queue;
  try {
    queue = loadQueueState(queueDir, state.lane, state.taskId);
    if (queue.control.repository !== state.repository) unresolved.push('queue_repository_changed');
    if (queue.control.generationRevision !== state.queue.generationRevision) unresolved.push('queue_generation_changed');
    if (queue.control.requirements?.revision !== state.queue.requirementsRevision) unresolved.push('queue_requirements_changed');

    const assignmentEstablished = state.queue.assignmentRevision != null || state.attempts.length > 0;
    if (assignmentEstablished) {
      if (queue.lane.currentTaskId !== state.taskId && queue.item.status !== 'completed') unresolved.push('lane_task_changed');
      if (queue.item.assignedLane !== state.lane && queue.item.status !== 'completed') unresolved.push('item_lane_changed');
      if (queue.item.claimHolderId && queue.item.claimHolderId !== state.holderId) unresolved.push('claim_holder_changed');
      if (state.queue.assignmentRevision != null && queue.item.assignmentRevision !== state.queue.assignmentRevision && queue.item.status !== 'completed') {
        unresolved.push('assignment_revision_changed');
      }
    } else {
      const initialQueueStillAvailable = queue.item.status === 'queued' &&
        queue.item.assignedLane === null &&
        queue.lane.currentTaskId === null &&
        ['idle', 'waiting'].includes(queue.lane.state);
      if (!initialQueueStillAvailable) unresolved.push('initial_queue_assignment_changed');
    }
  } catch {
    unresolved.push('queue_state_unavailable');
  }

  if (activeWorkerBranchExists(root, state)) unresolved.push('unsettled_worker_branch_without_recorded_receipt');

  if (queue?.item?.status === 'completed' && state.status !== 'passed') {
    const passedAttempt = [...state.attempts].reverse().find(attempt => attempt.finalState === 'passed');
    if (passedAttempt) {
      state.status = 'passed';
      state.completedAt = now;
      state.updatedAt = now;
      state.budgetUsage = computeBudgetUsage(state, now);
      return { state: persistState(runDir, state), reconciled: true, unresolved: [] };
    }
    unresolved.push('queue_completed_without_pass_receipt');
  }

  if (unresolved.length > 0) {
    state.status = 'needs_reconcile';
    state.updatedAt = now;
    state.completedAt = now;
    state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), ...unresolved])];
    state.budgetUsage = computeBudgetUsage(state, now);
    persistState(runDir, state);
    return { state, reconciled: false, unresolved };
  }

  state.budgetUsage = computeBudgetUsage(state, now);
  state.updatedAt = now;
  persistState(runDir, state);
  return { state, reconciled: true, unresolved: [] };
}

function initializeState({ policy, policyHash, phaseA, taskId, lane, holderId, now }) {
  const selected = phaseA.decision?.selectedTask ?? null;
  if (phaseA.decision?.state !== 'ready' || !selected) {
    const error = new Error(`Phase C cannot start because Phase A state is ${phaseA.decision?.state ?? 'unknown'}.`);
    error.code = 'PHASE_C_NOT_READY';
    error.phaseAEvidence = phaseA;
    throw error;
  }
  if (selected.taskId !== taskId) throw new Error(`Phase C requested task ${taskId} is not the current candidate ${selected.taskId}.`);
  const laneName = lane ?? phaseA.queue.availableLanes?.[0];
  if (!laneName || !phaseA.queue.availableLanes.includes(laneName)) throw new Error(`Phase C lane ${String(laneName)} is not assignable.`);

  return {
    schemaVersion: 1,
    mode: 'phase_c_loop',
    loopId: policy.loopId,
    repository: policy.repository,
    taskId,
    lane: laneName,
    holderId,
    policyFingerprint: policyHash,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    repositoryBaseline: {
      baseBranch: phaseA.repository.branch,
      baseCommit: phaseA.repository.head
    },
    queue: {
      generationRevision: phaseA.queue.generationRevision,
      assignmentRevision: null,
      requirementsRevision: phaseA.queue.requirements?.revision
    },
    iterationCount: 0,
    sameFailureCount: 0,
    lastFailureSignature: null,
    currentStrategy: 'initial-implementation',
    budgetUsage: { iterations: 0, modelTokens: 0, externalCost: 0, wallClockMinutes: 0 },
    attempts: [],
    unresolvedItems: []
  };
}

function blockQueueIfOwned(queueDir, state, now) {
  if (state.queue.assignmentRevision == null) return;
  try {
    blockWorkQueueTask(queueDir, {
      schemaVersion: 1,
      repository: state.repository,
      lane: state.lane,
      taskId: state.taskId,
      expectedGenerationRevision: state.queue.generationRevision,
      expectedAssignmentRevision: state.queue.assignmentRevision,
      holderId: state.holderId
    }, { now });
  } catch (error) {
    state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), `queue_block_transition_failed:${error.code ?? error.name ?? 'error'}`])];
  }
}

function requestedControlStatus(control) {
  if (control.requestedAction === 'pause') return 'paused';
  if (control.requestedAction === 'cancel') return 'cancelled';
  return null;
}

export async function runPhaseCLoop({
  policyPath,
  schemaPath,
  queueDir,
  repoRoot: targetRepoRoot,
  taskId,
  lane = null,
  holderId,
  runDir = null,
  selectStrategy = null,
  implement,
  verify,
  now = () => new Date().toISOString()
}) {
  if (typeof implement !== 'function') throw new Error('implement callback is required.');
  if (typeof verify !== 'function') throw new Error('verify callback is required.');
  if (selectStrategy !== null && typeof selectStrategy !== 'function') throw new Error('selectStrategy must be a function when provided.');
  if (typeof holderId !== 'string' || holderId.length < 8) throw new Error('holderId must be at least 8 characters.');

  const policy = readJson(path.resolve(policyPath));
  const policyHash = policyFingerprint(policyPath);
  const finalRunDir = path.resolve(runDir ?? defaultRunDir(queueDir, policy.repository, policy.loopId));
  fs.mkdirSync(finalRunDir, { recursive: true });
  const currentStateFile = statePath(finalRunDir);
  let state;

  if (fs.existsSync(currentStateFile)) {
    state = readJson(currentStateFile);
    validateState(state);
    const result = reconcileExistingState({ state, policy, policyHash, queueDir, targetRepoRoot, runDir: finalRunDir, now: now() });
    state = result.state;
    if (!result.reconciled || terminal(state.status)) return { state, runDir: finalRunDir };
  } else {
    const phaseA = runDryRunController({ policyPath, schemaPath, queueDir, repoRoot: targetRepoRoot, now: now() });
    state = initializeState({ policy, policyHash, phaseA, taskId, lane, holderId, now: now() });
    persistState(finalRunDir, state);
  }

  const control = loadControl(finalRunDir, state.loopId, state.repository);
  const requested = requestedControlStatus(control);
  if (requested === 'paused') {
    state.status = 'paused';
    state.updatedAt = now();
    state.budgetUsage = computeBudgetUsage(state, state.updatedAt);
    persistState(finalRunDir, state);
    return { state, runDir: finalRunDir };
  }
  if (requested === 'cancelled') {
    state.status = 'cancelled';
    state.completedAt = now();
    state.updatedAt = state.completedAt;
    state.budgetUsage = computeBudgetUsage(state, state.updatedAt);
    blockQueueIfOwned(queueDir, state, state.updatedAt);
    persistState(finalRunDir, state);
    return { state, runDir: finalRunDir };
  }
  if (state.status === 'paused' && control.requestedAction === 'run') {
    state.status = 'running';
    state.completedAt = null;
    state.updatedAt = now();
    persistState(finalRunDir, state);
  }

  while (state.status === 'running') {
    const beforeAttempt = budgetStatus(policy, state, now());
    state.budgetUsage = beforeAttempt.usage;
    if (beforeAttempt.exhausted) {
      state.status = 'budget_exhausted';
      state.completedAt = now();
      state.updatedAt = state.completedAt;
      state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), `budget:${beforeAttempt.reason}`])];
      blockQueueIfOwned(queueDir, state, state.updatedAt);
      persistState(finalRunDir, state);
      break;
    }

    const attempt = state.attempts.length + 1;
    const strategy = selectStrategy
      ? await selectStrategy({ state: structuredClone(state), attempt, previousAttempt: state.attempts.at(-1) ?? null })
      : attempt === 1 ? 'initial-implementation' : `retry-strategy-${attempt}`;
    if (typeof strategy !== 'string' || strategy.length === 0 || strategy.length > 120) throw new Error('selectStrategy must return a non-empty strategy string <= 120 chars.');
    if (attempt > 1 && policy.progress?.requireMeaningfulDelta === true && strategy === state.currentStrategy) {
      state.status = 'stuck';
      state.completedAt = now();
      state.updatedAt = state.completedAt;
      state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), 'retry_strategy_did_not_change'])];
      blockQueueIfOwned(queueDir, state, state.updatedAt);
      persistState(finalRunDir, state);
      break;
    }
    state.currentStrategy = strategy;
    state.updatedAt = now();
    persistState(finalRunDir, state);

    let checkpointControl = null;
    const result = await runPhaseBWorker({
      policyPath,
      schemaPath,
      queueDir,
      repoRoot: targetRepoRoot,
      taskId: state.taskId,
      lane: state.lane,
      holderId: state.holderId,
      attempt,
      receiptDir: finalRunDir,
      resumeExistingClaim: attempt > 1 || state.queue.assignmentRevision != null,
      now,
      checkpoint: async () => {
        const current = loadControl(finalRunDir, state.loopId, state.repository);
        if (current.requestedAction === 'pause' || current.requestedAction === 'cancel') {
          checkpointControl = current.requestedAction;
          const error = new Error(`Phase C control requested ${current.requestedAction}.`);
          error.code = current.requestedAction === 'pause' ? 'PHASE_C_PAUSED' : 'PHASE_C_CANCELLED';
          throw error;
        }
      },
      implement: async context => implement({ ...context, strategy }),
      verify: async context => verify({ ...context, strategy })
    });

    const receipt = result.receipt;
    state.queue.assignmentRevision = receipt.queue.assignmentRevision;
    const signature = failureSignature(receipt);
    const previous = state.attempts.at(-1) ?? null;
    const meaningfulProgress = receipt.finalState === 'passed' || previous == null || signature !== previous.failureSignature;
    const sameFailureCount = signature && signature === state.lastFailureSignature && !meaningfulProgress
      ? state.sameFailureCount + 1
      : signature ? 1 : 0;

    const attemptRecord = {
      attempt,
      receiptFile: path.basename(result.receiptPath),
      finalState: receipt.finalState,
      verificationStatus: receipt.verification?.status ?? 'not_run',
      failureSignature: signature,
      meaningfulProgress,
      strategy,
      candidateCommit: receipt.repositoryEvidence?.candidateCommit ?? null,
      usage: receipt.usage ?? { modelTokens: 0, externalCost: 0, implementationReported: false, verificationReported: false },
      unresolvedItems: receipt.unresolvedItems ?? []
    };
    state.attempts.push(attemptRecord);
    state.iterationCount = state.attempts.length;
    state.lastFailureSignature = signature;
    state.sameFailureCount = sameFailureCount;
    state.budgetUsage = computeBudgetUsage(state, now());
    state.updatedAt = now();

    const missingUsage = finiteBudgetUsageIsObservable(policy, receipt);
    if (missingUsage.length > 0) {
      state.status = 'blocked';
      state.completedAt = state.updatedAt;
      state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), ...missingUsage])];
      blockQueueIfOwned(queueDir, state, state.updatedAt);
      persistState(finalRunDir, state);
      break;
    }

    if (receipt.finalState === 'passed') {
      state.status = 'passed';
      state.completedAt = state.updatedAt;
      persistState(finalRunDir, state);
      break;
    }

    if (checkpointControl === 'pause') {
      state.status = 'paused';
      persistState(finalRunDir, state);
      break;
    }
    if (checkpointControl === 'cancel') {
      state.status = 'cancelled';
      state.completedAt = state.updatedAt;
      blockQueueIfOwned(queueDir, state, state.updatedAt);
      persistState(finalRunDir, state);
      break;
    }

    if (receipt.verification?.status === 'uncertain') {
      state.status = 'blocked';
      state.completedAt = state.updatedAt;
      state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), 'verifier_uncertain'])];
      blockQueueIfOwned(queueDir, state, state.updatedAt);
      persistState(finalRunDir, state);
      break;
    }

    if (policy.progress?.detectSameFailure === true && state.sameFailureCount >= policy.budget.maxSameFailure) {
      state.status = 'stuck';
      state.completedAt = state.updatedAt;
      state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), 'max_same_failure_reached'])];
      blockQueueIfOwned(queueDir, state, state.updatedAt);
      persistState(finalRunDir, state);
      break;
    }

    const afterAttempt = budgetStatus(policy, state, now());
    state.budgetUsage = afterAttempt.usage;
    if (afterAttempt.exhausted) {
      state.status = 'budget_exhausted';
      state.completedAt = now();
      state.updatedAt = state.completedAt;
      state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), `budget:${afterAttempt.reason}`])];
      blockQueueIfOwned(queueDir, state, state.updatedAt);
      persistState(finalRunDir, state);
      break;
    }

    persistState(finalRunDir, state);
  }

  return { state, runDir: finalRunDir };
}
