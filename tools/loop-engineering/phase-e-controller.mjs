import fs from 'node:fs';
import path from 'node:path';
import { validateJsonSchema } from './json-schema-lite.mjs';
import {
  branchRef,
  git,
  projectionMatches,
  refValue,
  repoRoot
} from '../reliability/git-transaction-core.mjs';

const planSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-e-plan.schema.json');
const stateSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-e-state.schema.json');
const receiptSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-e-receipt.schema.json');
const phaseDReceiptSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-d-receipt.schema.json');
const terminalStates = new Set(['ready_for_human_merge', 'blocked', 'cancelled', 'needs_reconcile']);
const failingCheckStates = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
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

function sanitizeSegment(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'loop';
}

function defaultRunDir(sourceReceiptPath, repository, loopId) {
  const sourceDir = path.dirname(path.resolve(sourceReceiptPath));
  if (path.basename(sourceDir) === sanitizeSegment(loopId)) return sourceDir;
  return path.join(sourceDir, `${repository.replace('/', '--')}-${sanitizeSegment(loopId)}-phase-e`);
}

function normalizeCheckStatus(value) {
  const status = String(value ?? '').toLowerCase();
  if (['success', 'pass', 'passed', 'completed'].includes(status)) return 'success';
  if (['failure', 'fail', 'failed', 'error'].includes(status)) return 'failure';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  if (['timed_out', 'timeout'].includes(status)) return 'timed_out';
  if (['action_required'].includes(status)) return 'action_required';
  return 'pending';
}

function normalizeChecks(observation, requiredChecks) {
  const byName = new Map();
  for (const raw of observation?.checks ?? []) {
    const name = String(raw?.name ?? '').trim();
    if (!name) continue;
    byName.set(name, {
      name,
      status: normalizeCheckStatus(raw.status),
      evidence: raw?.evidence == null ? null : String(raw.evidence)
    });
  }
  return requiredChecks.map(name => byName.get(name) ?? { name, status: 'not_reported', evidence: null });
}

function approvalCount(observation) {
  const latestByReviewer = new Map();
  (observation?.reviews ?? []).forEach((review, index) => {
    const reviewer = String(review?.author ?? review?.login ?? review?.user ?? `anonymous-${index}`);
    latestByReviewer.set(reviewer, String(review?.state ?? '').toLowerCase());
  });
  return [...latestByReviewer.values()].filter(state => state === 'approved').length;
}

function remoteHead(root, remoteName, branch) {
  const result = git(root, ['ls-remote', '--heads', remoteName, `refs/heads/${branch}`], { allowFailure: true });
  if (result.status !== 0) {
    const error = new Error(`Unable to inspect remote branch ${remoteName}/${branch}.`);
    error.code = 'REMOTE_INSPECTION_FAILED';
    throw error;
  }
  const line = result.stdout.trim().split(/\r?\n/).find(Boolean);
  if (!line) return null;
  return line.split(/\s+/)[0] ?? null;
}

function assertBranchName(root, value, label) {
  if (String(value).startsWith('refs/')) {
    const error = new Error(`${label} must use a branch name, not a full ref: ${value}`);
    error.code = 'INVALID_BRANCH_NAME';
    throw error;
  }
  const result = git(root, ['check-ref-format', '--branch', value], { allowFailure: true });
  if (result.status !== 0) {
    const error = new Error(`${label} is not a valid Git branch name: ${value}`);
    error.code = 'INVALID_BRANCH_NAME';
    throw error;
  }
}

function assertPhaseEPolicy(policy) {
  const errors = [];
  if (policy.autonomyLevel !== 'L2_PR') errors.push('autonomyLevel must be L2_PR');
  if (!['isolated_worktree', 'isolated_branch'].includes(policy.scope?.workingBranchPolicy)) errors.push('workingBranchPolicy must remain isolated');
  if (policy.permissions?.repositoryRead !== true) errors.push('repositoryRead permission is required');
  if (policy.permissions?.workingBranchWrite !== true) errors.push('workingBranchWrite permission is required');
  if (policy.permissions?.commit !== true) errors.push('commit permission is required');
  if (policy.permissions?.pushWorkingBranch !== true) errors.push('pushWorkingBranch permission is required');
  if (policy.permissions?.defaultBranchWrite !== false) errors.push('defaultBranchWrite must remain false');
  if (policy.permissions?.merge !== false) errors.push('merge must remain false');
  if (policy.permissions?.deploy !== false) errors.push('deploy must remain false');
  if (policy.permissions?.externalNetwork !== true) errors.push('externalNetwork is required for remote publication');
  if (policy.permissions?.secretAccess !== false) errors.push('secretAccess must remain false');
  if (policy.verification?.protected !== true) errors.push('protected verification is required');
  if (policy.verification?.allowWorkerToModifyVerifier !== false) errors.push('worker verifier mutation must remain disabled');
  if (policy.verification?.minimumLevel === 'V0_SELF') errors.push('V0_SELF cannot authorize Phase E publication');
  if (errors.length > 0) {
    const error = new Error(`Loop policy is not eligible for Phase E: ${errors.join('; ')}`);
    error.code = 'PHASE_E_POLICY_UNSAFE';
    throw error;
  }
}

function assertPhaseEPlan(policy, plan) {
  const errors = [];
  if (plan.remote.branch === plan.pullRequest.baseBranch) errors.push('remote review branch must differ from PR base branch');
  if (plan.pullRequest.draft !== false) errors.push('Phase E v1 requires a non-draft PR');
  if (plan.pullRequest.humanReviewRequired !== true) errors.push('human review gate is required');
  if (!Number.isInteger(plan.pullRequest.minApprovals) || plan.pullRequest.minApprovals < 1) errors.push('minApprovals must be >= 1');
  const missingPolicyChecks = (policy.verification?.requiredChecks ?? []).filter(check => !plan.pullRequest.requiredChecks.includes(check));
  if (missingPolicyChecks.length > 0) errors.push(`PR requiredChecks omit policy checks: ${missingPolicyChecks.join(', ')}`);
  if (errors.length > 0) {
    const error = new Error(`Phase E plan is unsafe: ${errors.join('; ')}`);
    error.code = 'PHASE_E_PLAN_UNSAFE';
    throw error;
  }
}

function assertSourceReceipt(receipt, policy, plan) {
  if (receipt.mode !== 'phase_d_parallel') throw new Error('Phase E currently requires a Phase D source receipt.');
  if (receipt.receiptId !== plan.sourceReceiptId) throw new Error('Phase E plan sourceReceiptId does not match the source receipt.');
  if (receipt.loopId !== policy.loopId || plan.loopId !== policy.loopId) throw new Error('Phase E loop identity mismatch.');
  if (receipt.repository !== policy.repository || plan.repository !== policy.repository) throw new Error('Phase E repository identity mismatch.');
  if (receipt.finalState !== 'passed') throw new Error(`Phase E source receipt must be passed; current=${receipt.finalState}.`);
  if (receipt.baseBranchUnchanged !== true) throw new Error('Phase E requires Phase D baseBranchUnchanged=true.');
  if (receipt.integration?.status !== 'passed' || receipt.integration?.verification?.status !== 'pass') {
    throw new Error('Phase E requires passed Phase D integration verification.');
  }
  if (!receipt.integration?.branch || !receipt.integration?.head) throw new Error('Phase E source receipt is missing integration branch/head evidence.');
  if ((receipt.unresolvedItems ?? []).length > 0) throw new Error('Phase E refuses a source receipt with unresolved items.');
  if (plan.pullRequest.baseBranch !== receipt.baseBranch) throw new Error('Phase E PR baseBranch must match the verified Phase D base branch.');
}

function readControl(runDir, policy) {
  const file = path.join(runDir, 'control.json');
  if (!fs.existsSync(file)) return { requestedAction: 'run' };
  const control = readJson(file);
  if (control.loopId !== policy.loopId || control.repository !== policy.repository) {
    throw new Error('Phase E control identity does not match policy.');
  }
  return control;
}

function normalizePullRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Pull Request callback returned no object.');
  const result = {
    id: raw.id ?? raw.number,
    url: String(raw.url ?? raw.htmlUrl ?? raw.html_url ?? ''),
    state: String(raw.state ?? 'unknown'),
    headSha: String(raw.headSha ?? raw.head_sha ?? ''),
    baseBranch: String(raw.baseBranch ?? raw.base_branch ?? '')
  };
  if (result.id == null || !result.url || !result.headSha || !result.baseBranch) throw new Error('Pull Request callback returned incomplete identity evidence.');
  return result;
}

function initialState(policy, plan, receipt, startedAt) {
  return {
    schemaVersion: 1,
    mode: 'phase_e_remote_pr',
    loopId: policy.loopId,
    repository: policy.repository,
    status: 'publishing',
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    sourceReceiptId: receipt.receiptId,
    baseBranch: receipt.baseBranch,
    baseCommit: receipt.baseCommit,
    integrationBranch: receipt.integration.branch,
    integrationHead: receipt.integration.head,
    remoteName: plan.remote.name,
    remoteBranch: plan.remote.branch,
    publishedHead: null,
    pullRequest: null,
    checks: [],
    approvalCount: 0,
    unresolvedItems: []
  };
}

function effectivePermissions(policy) {
  return {
    requestedByPolicy: { ...policy.permissions },
    effectiveForPhaseE: {
      repositoryRead: true,
      workingBranchWrite: false,
      commit: false,
      pushWorkingBranch: true,
      defaultBranchWrite: false,
      merge: false,
      deploy: false,
      externalNetwork: true,
      secretAccess: false
    },
    guardedOverride: true
  };
}

function persistState(runDir, state) {
  validateWithSchema(state, stateSchemaPath, 'INVALID_PHASE_E_STATE', 'Phase E state');
  writeJsonAtomic(path.join(runDir, 'phase-e-state.json'), state);
}

function buildReceipt(state, finishedAt) {
  return {
    schemaVersion: 1,
    receiptId: `phase-e-${sanitizeSegment(state.loopId)}-${Date.parse(finishedAt) || Date.now()}`,
    mode: 'phase_e_remote_pr',
    loopId: state.loopId,
    repository: state.repository,
    startedAt: state.startedAt,
    finishedAt,
    finalState: state.status,
    sourceReceiptId: state.sourceReceiptId,
    baseBranch: state.baseBranch,
    baseCommit: state.baseCommit,
    integrationBranch: state.integrationBranch,
    integrationHead: state.integrationHead,
    remote: {
      name: state.remoteName,
      branch: state.remoteBranch,
      publishedHead: state.publishedHead
    },
    pullRequest: state.pullRequest,
    checks: state.checks,
    approvalCount: state.approvalCount,
    mergePerformed: false,
    deployPerformed: false,
    unresolvedItems: state.unresolvedItems
  };
}

function saveReceipt(runDir, state, now) {
  const finishedAt = now();
  const receipt = buildReceipt(state, finishedAt);
  validateWithSchema(receipt, receiptSchemaPath, 'INVALID_PHASE_E_RECEIPT', 'Phase E receipt');
  const receiptPath = path.join(runDir, `${receipt.receiptId}.json`);
  writeJsonAtomic(receiptPath, receipt);
  return { receipt, receiptPath };
}

function updateState(runDir, state, status, now, { terminal = false } = {}) {
  state.status = status;
  state.updatedAt = now();
  state.completedAt = terminal ? state.updatedAt : null;
  persistState(runDir, state);
}

function reconcileLocalSource(root, state) {
  const baseRef = branchRef(state.baseBranch);
  const integrationRef = branchRef(state.integrationBranch);
  if (refValue(root, baseRef) !== state.baseCommit || !projectionMatches(root, state.baseCommit)) {
    return 'local_base_changed_since_phase_d';
  }
  if (refValue(root, integrationRef) !== state.integrationHead) return 'local_integration_branch_changed';
  return null;
}

function finalize(runDir, state, status, now, unresolved = null) {
  if (unresolved) state.unresolvedItems = [...new Set([...(state.unresolvedItems ?? []), unresolved])];
  updateState(runDir, state, status, now, { terminal: terminalStates.has(status) });
  const { receipt, receiptPath } = saveReceipt(runDir, state, now);
  return { state, receipt, receiptPath };
}

export async function runPhaseERemotePr({
  policyPath,
  schemaPath,
  plan,
  planPath = null,
  sourceReceiptPath,
  repoRoot: targetRepoRoot,
  runDir = null,
  openPullRequest,
  observePullRequest,
  now = () => new Date().toISOString()
}) {
  if (typeof openPullRequest !== 'function') throw new Error('openPullRequest callback is required.');
  if (typeof observePullRequest !== 'function') throw new Error('observePullRequest callback is required.');

  const policy = readJson(path.resolve(policyPath));
  const policySchema = readJson(path.resolve(schemaPath));
  const policyValidation = validateJsonSchema(policy, policySchema);
  if (!policyValidation.valid) {
    const error = new Error(`Loop policy validation failed with ${policyValidation.errors.length} error(s).`);
    error.code = 'INVALID_LOOP_POLICY';
    error.validationErrors = policyValidation.errors;
    throw error;
  }
  assertPhaseEPolicy(policy);

  const resolvedPlan = plan ?? readJson(path.resolve(planPath));
  validateWithSchema(resolvedPlan, planSchemaPath, 'INVALID_PHASE_E_PLAN', 'Phase E plan');
  assertPhaseEPlan(policy, resolvedPlan);
  const sourceReceipt = readJson(path.resolve(sourceReceiptPath));
  validateWithSchema(sourceReceipt, phaseDReceiptSchemaPath, 'INVALID_PHASE_D_RECEIPT', 'Phase D source receipt');
  assertSourceReceipt(sourceReceipt, policy, resolvedPlan);

  const root = repoRoot(targetRepoRoot);
  assertBranchName(root, sourceReceipt.integration.branch, 'Phase E integration branch');
  assertBranchName(root, resolvedPlan.remote.branch, 'Phase E remote branch');
  assertBranchName(root, resolvedPlan.pullRequest.baseBranch, 'Phase E PR base branch');

  const finalRunDir = path.resolve(runDir ?? defaultRunDir(sourceReceiptPath, policy.repository, policy.loopId));
  fs.mkdirSync(finalRunDir, { recursive: true });
  const stateFile = path.join(finalRunDir, 'phase-e-state.json');
  const startedAt = now();
  let state;

  if (fs.existsSync(stateFile)) {
    state = readJson(stateFile);
    validateWithSchema(state, stateSchemaPath, 'INVALID_PHASE_E_STATE', 'Phase E state');
    if (state.loopId !== policy.loopId || state.repository !== policy.repository || state.sourceReceiptId !== sourceReceipt.receiptId) {
      throw new Error('Existing Phase E state identity does not match the requested run.');
    }
    if (terminalStates.has(state.status)) return { state, receipt: null, receiptPath: null };
  } else {
    state = initialState(policy, resolvedPlan, sourceReceipt, startedAt);
    persistState(finalRunDir, state);
  }

  if (readControl(finalRunDir, policy).requestedAction === 'cancel') {
    return finalize(finalRunDir, state, 'cancelled', now, state.publishedHead ? 'cancelled_remote_artifacts_preserved' : 'cancelled_before_publication');
  }

  const localIssue = reconcileLocalSource(root, state);
  if (localIssue) return finalize(finalRunDir, state, 'needs_reconcile', now, localIssue);

  let remoteBase;
  try {
    remoteBase = remoteHead(root, state.remoteName, state.baseBranch);
  } catch (error) {
    return finalize(finalRunDir, state, 'blocked', now, `remote_base_inspection_failed:${error.code ?? error.name ?? 'error'}`);
  }
  if (!remoteBase) return finalize(finalRunDir, state, 'blocked', now, 'remote_base_branch_missing');
  if (remoteBase !== state.baseCommit) return finalize(finalRunDir, state, 'needs_reconcile', now, 'remote_base_changed_since_phase_d');

  let publishedHead;
  try {
    publishedHead = remoteHead(root, state.remoteName, state.remoteBranch);
  } catch (error) {
    return finalize(finalRunDir, state, 'blocked', now, `remote_branch_inspection_failed:${error.code ?? error.name ?? 'error'}`);
  }

  if (publishedHead && publishedHead !== state.integrationHead) {
    return finalize(finalRunDir, state, 'needs_reconcile', now, 'remote_branch_points_to_different_commit');
  }

  if (!publishedHead) {
    const push = git(root, [
      'push',
      state.remoteName,
      `${branchRef(state.integrationBranch)}:refs/heads/${state.remoteBranch}`
    ], { allowFailure: true });
    if (push.status !== 0) return finalize(finalRunDir, state, 'blocked', now, 'remote_push_failed');
    try {
      publishedHead = remoteHead(root, state.remoteName, state.remoteBranch);
    } catch (error) {
      return finalize(finalRunDir, state, 'blocked', now, `remote_branch_post_push_inspection_failed:${error.code ?? error.name ?? 'error'}`);
    }
    if (publishedHead !== state.integrationHead) return finalize(finalRunDir, state, 'needs_reconcile', now, 'remote_branch_head_mismatch_after_push');
  }

  state.publishedHead = publishedHead;
  updateState(finalRunDir, state, 'publishing', now);

  const permissions = effectivePermissions(policy);
  if (!state.pullRequest) {
    let rawPr;
    try {
      rawPr = await openPullRequest({
        repository: policy.repository,
        headBranch: state.remoteBranch,
        headSha: state.integrationHead,
        baseBranch: state.baseBranch,
        title: resolvedPlan.pullRequest.title,
        body: resolvedPlan.pullRequest.body,
        draft: resolvedPlan.pullRequest.draft,
        policy,
        permissions
      });
    } catch (error) {
      return finalize(finalRunDir, state, 'blocked', now, `pull_request_open_failed:${error.code ?? error.name ?? 'error'}`);
    }
    state.pullRequest = normalizePullRequest(rawPr);
    if (state.pullRequest.headSha !== state.integrationHead || state.pullRequest.baseBranch !== state.baseBranch) {
      return finalize(finalRunDir, state, 'needs_reconcile', now, 'pull_request_identity_mismatch');
    }
    updateState(finalRunDir, state, 'awaiting_checks', now);
  }

  let observation;
  try {
    observation = await observePullRequest({
      repository: policy.repository,
      pullRequest: state.pullRequest,
      requiredChecks: resolvedPlan.pullRequest.requiredChecks,
      minApprovals: resolvedPlan.pullRequest.minApprovals,
      policy,
      permissions
    });
  } catch (error) {
    return finalize(finalRunDir, state, 'blocked', now, `pull_request_observation_failed:${error.code ?? error.name ?? 'error'}`);
  }

  const observedHead = String(observation?.headSha ?? observation?.head_sha ?? state.pullRequest.headSha);
  const observedBase = String(observation?.baseBranch ?? observation?.base_branch ?? state.pullRequest.baseBranch);
  const observedState = String(observation?.state ?? state.pullRequest.state).toLowerCase();
  if (observedHead !== state.integrationHead || observedBase !== state.baseBranch) {
    return finalize(finalRunDir, state, 'needs_reconcile', now, 'pull_request_changed_after_publication');
  }
  if (['closed', 'merged'].includes(observedState)) {
    return finalize(finalRunDir, state, 'needs_reconcile', now, `pull_request_unexpected_state:${observedState}`);
  }

  state.pullRequest = {
    ...state.pullRequest,
    state: String(observation?.state ?? state.pullRequest.state),
    headSha: observedHead,
    baseBranch: observedBase
  };
  state.checks = normalizeChecks(observation, resolvedPlan.pullRequest.requiredChecks);
  state.approvalCount = approvalCount(observation);

  let remoteBaseBeforeGate;
  let remoteHeadBeforeGate;
  try {
    remoteBaseBeforeGate = remoteHead(root, state.remoteName, state.baseBranch);
    remoteHeadBeforeGate = remoteHead(root, state.remoteName, state.remoteBranch);
  } catch (error) {
    return finalize(finalRunDir, state, 'blocked', now, `remote_review_gate_inspection_failed:${error.code ?? error.name ?? 'error'}`);
  }
  if (remoteBaseBeforeGate !== state.baseCommit) return finalize(finalRunDir, state, 'needs_reconcile', now, 'remote_base_changed_before_review_gate');
  if (remoteHeadBeforeGate !== state.integrationHead) return finalize(finalRunDir, state, 'needs_reconcile', now, 'remote_branch_changed_before_review_gate');
  const localIssueBeforeGate = reconcileLocalSource(root, state);
  if (localIssueBeforeGate) return finalize(finalRunDir, state, 'needs_reconcile', now, localIssueBeforeGate);

  if (state.checks.some(check => failingCheckStates.has(check.status))) {
    return finalize(finalRunDir, state, 'blocked', now, 'required_check_failed');
  }
  if (state.checks.some(check => check.status !== 'success')) {
    return finalize(finalRunDir, state, 'awaiting_checks', now);
  }
  if (state.approvalCount < resolvedPlan.pullRequest.minApprovals) {
    return finalize(finalRunDir, state, 'awaiting_human_review', now);
  }

  return finalize(finalRunDir, state, 'ready_for_human_merge', now);
}
