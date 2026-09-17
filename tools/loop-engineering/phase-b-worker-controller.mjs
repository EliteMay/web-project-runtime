import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runDryRunController } from './dry-run-controller.mjs';
import { validateJsonSchema } from './json-schema-lite.mjs';
import { applyAssignmentPlan } from '../work-queues/assign-work-queue.mjs';
import { claimAssignment } from '../work-queues/claim-work-queue.mjs';
import { markReadyForApply } from '../work-queues/mark-work-queue-ready.mjs';
import { applyAdvancePlan } from '../work-queues/advance-work-queue.mjs';
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

const receiptSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-b-receipt.schema.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function unique(values) {
  return [...new Set(values)];
}

function sameSource(a, b) {
  return a?.path === b?.path && a?.revisionType === b?.revisionType && a?.revision === b?.revision;
}

function sanitizeSegment(value) {
  const sanitized = String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'loop';
}

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
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

function assertScope(policy, changedFiles) {
  const allowed = policy.scope?.allowedPaths ?? [];
  const protectedPaths = policy.scope?.protectedPaths ?? [];
  if (changedFiles.length === 0) throw new Error('Worker produced no repository change.');
  for (const file of changedFiles) {
    if (matchesAny(file, protectedPaths)) throw new Error(`Worker changed protected path: ${file}`);
    if (allowed.length === 0 || !matchesAny(file, allowed)) throw new Error(`Worker changed path outside allowed scope: ${file}`);
  }
}

function loadQueueState(queueDir, laneName, taskId) {
  const control = readJson(path.join(queueDir, 'control.json'));
  const lane = readJson(path.join(queueDir, 'lanes', `${laneName}.json`));
  const item = readJson(path.join(queueDir, 'items', `${taskId}.json`));
  return { control, lane, item };
}

function assertPhaseBPolicy(policy) {
  const errors = [];
  if ((policy.autonomyLevel ?? 'L1_WORKTREE') !== 'L1_WORKTREE') errors.push('autonomyLevel must be L1_WORKTREE for Phase B');
  if (policy.scope?.workingBranchPolicy !== 'isolated_worktree') errors.push('scope.workingBranchPolicy must be isolated_worktree');
  if (policy.permissions?.repositoryRead !== true) errors.push('repositoryRead permission is required');
  if (policy.permissions?.workingBranchWrite !== true) errors.push('workingBranchWrite permission is required');
  if (policy.permissions?.commit !== true) errors.push('commit permission is required');
  if (policy.permissions?.defaultBranchWrite !== false) errors.push('defaultBranchWrite must remain false');
  if (policy.permissions?.merge !== false) errors.push('merge must remain false');
  if (policy.permissions?.deploy !== false) errors.push('deploy must remain false');
  if (policy.permissions?.secretAccess !== false) errors.push('secretAccess must remain false');
  if (policy.verification?.protected !== true) errors.push('protected verification is required');
  if (policy.verification?.allowWorkerToModifyVerifier !== false) errors.push('worker verifier mutation must remain disabled');
  if (policy.verification?.minimumLevel === 'V0_SELF') errors.push('V0_SELF cannot be the Phase B completion oracle');
  if (policy.budget?.maxParallelWorkers !== 1) errors.push('Phase B is sequential-first and requires maxParallelWorkers=1');
  if (errors.length > 0) {
    const error = new Error(`Loop policy is not eligible for Phase B: ${errors.join('; ')}`);
    error.code = 'PHASE_B_POLICY_UNSAFE';
    throw error;
  }
}

function effectivePermissions(policy) {
  return {
    requestedByPolicy: { ...policy.permissions },
    effectiveForPhaseB: {
      repositoryRead: policy.permissions.repositoryRead === true,
      workingBranchWrite: policy.permissions.workingBranchWrite === true,
      commit: policy.permissions.commit === true,
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

function normalizeVerification(result, requiredRequirements) {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const status = ['pass', 'fail', 'uncertain'].includes(value.status) ? value.status : 'uncertain';
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
  return {
    status: status === 'pass' && checksPass && missing.length === 0 ? 'pass' : status === 'pass' ? 'fail' : status,
    checks,
    satisfiedRequirements,
    missingRequirements: missing
  };
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

function defaultReceiptDir(queueDir, repository, loopId) {
  const queueRoot = path.dirname(path.resolve(queueDir));
  const dataRoot = path.dirname(queueRoot);
  return path.join(dataRoot, 'loop-runs', repository.replace('/', '--'), sanitizeSegment(loopId));
}

function makeReceiptId(loopId, taskId, attempt, startedAt) {
  const stamp = startedAt.replace(/[^0-9]/g, '').slice(0, 14) || 'time';
  return `${sanitizeSegment(loopId)}-${sanitizeSegment(taskId)}-a${attempt}-${stamp}`;
}

function worktreePath(repoDir, receiptId) {
  const root = repoRoot(repoDir);
  const key = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'loop-engineering-workers', key, receiptId);
}

function removeCleanWorktree(repoDir, workerDir) {
  if (!workerDir || !fs.existsSync(workerDir)) return true;
  const head = gitOutput(workerDir, ['rev-parse', 'HEAD']);
  if (!projectionMatches(workerDir, head)) return false;
  return git(repoDir, ['worktree', 'remove', workerDir], { allowFailure: true }).status === 0;
}

function readFinalTaskStatus(queueDir, taskId) {
  try {
    return readJson(path.join(queueDir, 'items', `${taskId}.json`)).status ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function persistReceipt(receiptDir, receipt) {
  const schema = readJson(receiptSchemaPath);
  const validation = validateJsonSchema(receipt, schema);
  if (!validation.valid) {
    const error = new Error(`Phase B receipt validation failed with ${validation.errors.length} error(s).`);
    error.code = 'INVALID_PHASE_B_RECEIPT';
    error.validationErrors = validation.errors;
    throw error;
  }
  const file = path.join(receiptDir, `${receipt.receiptId}.json`);
  if (fs.existsSync(file)) throw new Error(`Phase B receipt already exists: ${file}`);
  writeJson(file, receipt);
  return file;
}

function assertResumeEvidence(phaseA, policy) {
  const blockers = [];
  const repository = phaseA.repository ?? {};
  const queue = phaseA.queue ?? {};
  const requirements = queue.requirementsEvidence ?? {};
  if (!repository.exists || !repository.isGitRepository) blockers.push('repository_unavailable');
  if (repository.identityState !== 'matched') blockers.push(`repository_identity_${repository.identityState ?? 'unknown'}`);
  if (repository.dirty !== false) blockers.push('primary_repository_not_clean');
  if ((repository.requiredSources ?? []).some(source => !source.safePath || !source.exists)) blockers.push('required_source_unavailable');
  if (queue.repository !== policy.repository) blockers.push('queue_repository_mismatch');
  if (queue.syncState !== 'synced') blockers.push('queue_not_synced');
  if (queue.activeRunId !== null) blockers.push('queue_active_run_present');
  if (requirements.revisionState !== 'matched') blockers.push(`requirements_revision_${requirements.revisionState ?? 'unknown'}`);
  if (requirements.workingTreeDirty !== false) blockers.push('requirements_worktree_dirty_or_unknown');
  if (blockers.length > 0) {
    const error = new Error(`Phase B continuation is not safe: ${blockers.join(', ')}`);
    error.code = 'PHASE_B_RESUME_NOT_SAFE';
    error.blockers = blockers;
    error.phaseAEvidence = phaseA;
    throw error;
  }
}

function resolveResumeTask(queueDir, policy, taskId, laneName, holderId) {
  const state = loadQueueState(queueDir, laneName, taskId);
  const { control, lane, item } = state;
  if (control.repository !== policy.repository || lane.repository !== policy.repository || item.repository !== policy.repository) {
    throw new Error('Phase B continuation repository does not match queue state.');
  }
  if (control.syncState !== 'synced') throw new Error(`Phase B continuation requires synced queue; current=${control.syncState}.`);
  if (item.taskId !== taskId || item.assignedLane !== laneName || lane.currentTaskId !== taskId) {
    throw new Error('Phase B continuation lane/task assignment mismatch.');
  }
  if (!sameSource(item.sourceRequirements, control.requirements)) throw new Error('Phase B continuation task no longer matches current Requirements revision.');
  if (item.status === 'assigned') {
    if (lane.state !== 'assigned') throw new Error(`Phase B continuation assigned task has lane state=${lane.state}.`);
    if (item.claimHolderId) throw new Error('Phase B continuation assigned task unexpectedly has a claim holder.');
  } else if (item.status === 'working') {
    if (!['working', 'assigned'].includes(lane.state)) throw new Error(`Phase B continuation working task has lane state=${lane.state}.`);
    if (item.claimHolderId !== holderId) throw new Error('Phase B continuation claim is owned by another holder.');
  } else {
    throw new Error(`Phase B continuation requires assigned or working task; current=${item.status}.`);
  }
  return state;
}

export async function runPhaseBWorker({
  policyPath,
  schemaPath,
  queueDir,
  repoRoot: targetRepoRoot,
  taskId,
  lane = null,
  holderId,
  attempt = 1,
  receiptDir = null,
  resumeExistingClaim = false,
  checkpoint = null,
  implement,
  verify,
  now = () => new Date().toISOString()
}) {
  if (typeof implement !== 'function') throw new Error('implement callback is required.');
  if (typeof verify !== 'function') throw new Error('verify callback is required.');
  if (checkpoint !== null && typeof checkpoint !== 'function') throw new Error('checkpoint must be a function when provided.');
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be an integer >= 1.');
  if (typeof taskId !== 'string' || taskId.length < 3) throw new Error('taskId is required.');
  if (typeof holderId !== 'string' || holderId.length < 8) throw new Error('holderId must be at least 8 characters.');

  const startedAt = now();
  const policy = readJson(path.resolve(policyPath));
  assertPhaseBPolicy(policy);
  const phaseA = runDryRunController({ policyPath, schemaPath, queueDir, repoRoot: targetRepoRoot, now: startedAt });

  let selected;
  let laneName;
  let generationRevision;
  if (resumeExistingClaim) {
    if (!lane) throw new Error('lane is required when resumeExistingClaim=true.');
    assertResumeEvidence(phaseA, policy);
    const resumeState = resolveResumeTask(queueDir, policy, taskId, lane, holderId);
    selected = resumeState.item;
    laneName = lane;
    generationRevision = resumeState.control.generationRevision;
  } else {
    selected = phaseA.decision?.selectedTask ?? null;
    if (phaseA.decision?.state !== 'ready' || !selected) {
      const error = new Error(`Phase A did not produce a ready task; state=${phaseA.decision?.state ?? 'unknown'}.`);
      error.code = 'PHASE_B_NOT_READY';
      error.phaseAEvidence = phaseA;
      throw error;
    }
    if (selected.taskId !== taskId) throw new Error(`Requested task ${taskId} is not the current Phase A candidate ${selected.taskId}.`);
    if (phaseA.repository?.dirty !== false) throw new Error('Phase B requires a clean primary target repository projection.');
    laneName = lane ?? phaseA.queue.availableLanes?.[0] ?? null;
    if (!laneName || !phaseA.queue.availableLanes.includes(laneName)) throw new Error(`Lane ${String(laneName)} is not currently assignable.`);
    generationRevision = phaseA.queue.generationRevision;
  }

  if (selected.taskId !== taskId) throw new Error(`Phase B task mismatch: requested=${taskId}, selected=${selected.taskId}.`);

  const baseBranch = phaseA.repository.branch;
  const baseCommit = phaseA.repository.head;
  if (!baseBranch || !baseCommit) throw new Error('Phase B requires an attached base branch and current base commit.');
  const targetRef = branchRef(baseBranch);
  const root = repoRoot(targetRepoRoot);
  if (currentSymbolicHead(root) !== targetRef || refValue(root, targetRef) !== baseCommit || !projectionMatches(root, baseCommit)) {
    throw new Error('Target repository changed after Phase A inspection or is not safely attached to its base branch.');
  }

  const receiptId = makeReceiptId(policy.loopId, taskId, attempt, startedAt);
  const workerBranch = `loop/${sanitizeSegment(policy.loopId)}/${sanitizeSegment(taskId)}-a${attempt}`;
  const workerRef = branchRef(workerBranch);
  const workerDir = worktreePath(root, receiptId);
  const finalReceiptDir = receiptDir ? path.resolve(receiptDir) : defaultReceiptDir(queueDir, policy.repository, policy.loopId);
  const requiredRequirements = unique([
    ...(policy.verification?.requiredChecks ?? []),
    ...(selected.validationRequirements ?? [])
  ]);
  const permissions = effectivePermissions(policy);

  let assignmentRevision = null;
  let candidateCommit = null;
  let changedFiles = [];
  let verification = {
    status: 'not_run',
    protected: true,
    workerTreeCleanAfterVerification: null,
    satisfiedRequirements: [],
    checks: []
  };
  const usage = emptyUsage();
  const unresolvedItems = [];
  let finalState = 'failed';
  let operationalError = null;
  let worktreeCreated = false;
  let writerLock = null;

  const runCheckpoint = async (stage, extra = {}) => {
    if (!checkpoint) return;
    await checkpoint({
      stage,
      repository: policy.repository,
      task: selected,
      lane: laneName,
      holderId,
      attempt,
      baseBranch,
      baseCommit,
      workerBranch,
      candidateCommit,
      ...extra
    });
  };

  try {
    await runCheckpoint('before_assignment');

    writerLock = acquireRepositoryWriterLock(root, {
      transactionId: receiptId,
      branch: baseBranch,
      baseCommit
    });

    applyAssignmentPlan(queueDir, {
      schemaVersion: 1,
      repository: policy.repository,
      expectedGenerationRevision: generationRevision,
      assignments: [{ lane: laneName, taskId }]
    }, { now: now() });

    const queueState = loadQueueState(queueDir, laneName, taskId);
    assignmentRevision = queueState.item.assignmentRevision;

    claimAssignment(queueDir, {
      schemaVersion: 1,
      repository: policy.repository,
      lane: laneName,
      expectedGenerationRevision: generationRevision,
      expectedAssignmentRevision: assignmentRevision,
      holderId
    }, { now: now() });

    await runCheckpoint('after_claim', { assignmentRevision });

    if (refValue(root, workerRef)) throw new Error(`Worker branch already exists: ${workerBranch}`);
    if (fs.existsSync(workerDir)) throw new Error(`Worker worktree path already exists: ${workerDir}`);
    fs.mkdirSync(path.dirname(workerDir), { recursive: true });
    git(root, ['worktree', 'add', '-b', workerBranch, workerDir, baseCommit]);
    worktreeCreated = true;
    writerLock.update({ worktreeDir: workerDir });

    const implementationResult = await implement({
      worktreeDir: workerDir,
      repository: policy.repository,
      task: selected,
      policy,
      permissions,
      baseBranch,
      baseCommit,
      workerBranch,
      attempt
    });
    recordUsage(usage, implementationResult, 'implementation');

    changedFiles = collectChangedFiles(workerDir);
    assertScope(policy, changedFiles);
    if (refValue(root, targetRef) !== baseCommit || !projectionMatches(root, baseCommit)) {
      throw new Error('Base branch changed during worker implementation.');
    }

    const commitMessage = buildCommitMessage({
      commitMessage: `Loop Phase B: ${taskId}`,
      transactionId: receiptId,
      producer: 'automation'
    });
    candidateCommit = createCandidateCommit(workerDir, commitMessage);
    if (!candidateCommit) throw new Error('Worker produced no committable change.');
    if (refValue(root, workerRef) !== candidateCommit) throw new Error('Worker branch does not point at the candidate commit.');
    writerLock.update({ candidateCommit });

    await runCheckpoint('before_verification', { changedFiles });

    const rawVerification = await verify({
      worktreeDir: workerDir,
      repository: policy.repository,
      task: selected,
      policy,
      permissions,
      baseBranch,
      baseCommit,
      workerBranch,
      candidateCommit,
      changedFiles,
      requiredRequirements
    });
    recordUsage(usage, rawVerification, 'verification');
    const normalizedVerification = normalizeVerification(rawVerification, requiredRequirements);
    const headAfterVerification = gitOutput(workerDir, ['rev-parse', 'HEAD']);
    const workerTreeCleanAfterVerification = headAfterVerification === candidateCommit && projectionMatches(workerDir, candidateCommit);
    verification = {
      status: normalizedVerification.status,
      protected: true,
      workerTreeCleanAfterVerification,
      satisfiedRequirements: normalizedVerification.satisfiedRequirements,
      checks: normalizedVerification.checks
    };

    if (normalizedVerification.missingRequirements.length > 0) {
      unresolvedItems.push(`missing_verification_requirements:${normalizedVerification.missingRequirements.join('|')}`);
    }
    if (!workerTreeCleanAfterVerification) unresolvedItems.push('verifier_mutated_worker_projection');
    if (refValue(root, targetRef) !== baseCommit || !projectionMatches(root, baseCommit)) unresolvedItems.push('base_branch_changed_during_verification');

    if (verification.status !== 'pass' || !workerTreeCleanAfterVerification || unresolvedItems.length > 0) {
      finalState = verification.status === 'uncertain' ? 'blocked' : 'failed';
      return finalize();
    }

    await runCheckpoint('before_completion', { assignmentRevision, verification });

    markReadyForApply(queueDir, {
      schemaVersion: 1,
      repository: policy.repository,
      lane: laneName,
      taskId,
      expectedGenerationRevision: generationRevision,
      expectedAssignmentRevision: assignmentRevision,
      holderId,
      completionVerified: true,
      validationVerified: true
    }, { now: now() });

    applyAdvancePlan(queueDir, {
      schemaVersion: 1,
      repository: policy.repository,
      expectedGenerationRevision: generationRevision,
      lane: laneName,
      taskId,
      completionVerified: true,
      validationVerified: true,
      nextTaskId: null
    }, { now: now() });

    finalState = 'passed';
    return finalize();
  } catch (error) {
    operationalError = error;
    unresolvedItems.push(`phase_b_error:${error.code ?? error.name ?? 'error'}`);
    finalState = 'failed';
    return finalize();
  }

  function finalize() {
    let cleanupOk = true;
    if (worktreeCreated) {
      try {
        cleanupOk = removeCleanWorktree(root, workerDir);
      } catch {
        cleanupOk = false;
      }
      if (!cleanupOk) unresolvedItems.push('worker_worktree_requires_recovery');
    }

    const baseBranchUnchanged = refValue(root, targetRef) === baseCommit && projectionMatches(root, baseCommit);
    if (!baseBranchUnchanged && !unresolvedItems.includes('base_branch_changed_during_verification')) {
      unresolvedItems.push('base_branch_changed');
      finalState = 'failed';
    }

    try {
      writerLock?.release();
    } catch {
      unresolvedItems.push('repository_writer_lock_release_failed');
      finalState = 'failed';
    }

    const finishedAt = now();
    const receipt = {
      schemaVersion: 1,
      receiptId,
      mode: 'phase_b_isolated_worker',
      loopId: policy.loopId,
      repository: policy.repository,
      taskId,
      lane: laneName,
      holderId,
      startedAt,
      finishedAt,
      finalState,
      queue: {
        generationRevision,
        assignmentRevision,
        finalTaskStatus: readFinalTaskStatus(queueDir, taskId)
      },
      repositoryEvidence: {
        baseBranch,
        baseCommit,
        workerBranch,
        candidateCommit,
        baseBranchUnchanged,
        changedFiles
      },
      verification,
      usage,
      unresolvedItems: unique(unresolvedItems)
    };

    const receiptPath = persistReceipt(finalReceiptDir, receipt);
    return {
      receipt,
      receiptPath,
      operationalError: operationalError ? {
        name: operationalError.name ?? 'Error',
        code: operationalError.code ?? null,
        message: operationalError.message ?? String(operationalError)
      } : null,
      workerWorktreeRetained: worktreeCreated && fs.existsSync(workerDir) && !cleanupOk
    };
  }
}
