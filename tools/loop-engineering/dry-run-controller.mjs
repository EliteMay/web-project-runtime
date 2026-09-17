import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from './json-schema-lite.mjs';

const ACTIVE_TASK_STATES = new Set(['assigned', 'claimed', 'working', 'blocked', 'ready_for_apply', 'needs_reconcile']);
const DEPENDENCY_SATISFIED_STATES = new Set(['completed', 'resolved']);
const TERMINAL_TASK_STATES = new Set(['completed', 'resolved', 'superseded', 'rejected']);
const ASSIGNABLE_LANE_STATES = new Set(['idle', 'waiting']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeRelative(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

function runGit(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status
  };
}

function normalizeGitRemote(remote) {
  if (!remote) return null;
  const trimmed = remote.trim().replace(/\.git$/, '');
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,
    /^git:\/\/github\.com\/([^/]+)\/([^/]+)$/i
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

function inspectRepository(repoRoot, policy) {
  const root = path.resolve(repoRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      root,
      exists: false,
      isGitRepository: false,
      identityState: 'unknown',
      expectedRepository: policy.repository,
      observedRepository: null,
      branch: null,
      head: null,
      dirty: null,
      requiredSources: []
    };
  }

  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  const isGitRepository = inside.ok && inside.stdout === 'true';
  const branch = isGitRepository ? runGit(root, ['branch', '--show-current']) : { ok: false, stdout: '' };
  const head = isGitRepository ? runGit(root, ['rev-parse', 'HEAD']) : { ok: false, stdout: '' };
  const status = isGitRepository ? runGit(root, ['status', '--porcelain']) : { ok: false, stdout: '' };
  const remote = isGitRepository ? runGit(root, ['config', '--get', 'remote.origin.url']) : { ok: false, stdout: '' };
  const observedRepository = remote.ok ? normalizeGitRemote(remote.stdout) : null;
  const identityState = observedRepository === null
    ? 'unknown'
    : observedRepository === policy.repository ? 'matched' : 'mismatch';

  const requiredSources = (policy.scope.requiredSources ?? []).map(source => {
    const resolved = safeRelative(root, source);
    return {
      path: source,
      safePath: Boolean(resolved),
      exists: Boolean(resolved && fs.existsSync(resolved))
    };
  });

  return {
    root,
    exists: true,
    isGitRepository,
    identityState,
    expectedRepository: policy.repository,
    observedRepository,
    branch: branch.ok && branch.stdout ? branch.stdout : null,
    head: head.ok && head.stdout ? head.stdout : null,
    dirty: status.ok ? status.stdout.length > 0 : null,
    requiredSources
  };
}

function sameSource(a, b) {
  return a?.path === b?.path && a?.revisionType === b?.revisionType && a?.revision === b?.revision;
}

function inspectQueueRequirements(repoRoot, requirements) {
  const root = path.resolve(repoRoot);
  const requirementsPath = requirements?.path ?? null;
  const revisionType = requirements?.revisionType ?? null;
  const expectedRevision = requirements?.revision ?? null;
  const resolved = requirementsPath ? safeRelative(root, requirementsPath) : null;
  const exists = Boolean(resolved && fs.existsSync(resolved));

  const base = {
    path: requirementsPath,
    revisionType,
    expectedRevision,
    observedRevision: null,
    safePath: Boolean(resolved),
    exists,
    workingTreeDirty: null,
    revisionState: 'unverified'
  };

  if (!requirementsPath || !resolved) {
    return { ...base, revisionState: requirementsPath ? 'unsafe_path' : 'unverified' };
  }
  if (!exists) return { ...base, revisionState: 'missing' };

  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') return base;

  const dirty = runGit(root, ['status', '--porcelain', '--', requirementsPath]);
  const workingTreeDirty = dirty.ok ? dirty.stdout.length > 0 : null;

  if (revisionType !== 'blobSha') {
    return { ...base, workingTreeDirty, revisionState: 'unsupported_revision_type' };
  }
  if (typeof expectedRevision !== 'string' || expectedRevision.length === 0) {
    return { ...base, workingTreeDirty, revisionState: 'unverified' };
  }

  const observed = runGit(root, ['rev-parse', `HEAD:${requirementsPath}`]);
  if (!observed.ok || !observed.stdout) {
    return { ...base, workingTreeDirty, revisionState: 'unverified' };
  }

  return {
    ...base,
    observedRevision: observed.stdout,
    workingTreeDirty,
    revisionState: observed.stdout === expectedRevision ? 'matched' : 'mismatch'
  };
}

function loadQueue(queueDir) {
  const root = path.resolve(queueDir);
  const controlFile = path.join(root, 'control.json');
  if (!fs.existsSync(controlFile)) throw new Error(`Missing queue control: ${controlFile}`);
  const control = readJson(controlFile);

  const items = [];
  const itemsDir = path.join(root, 'items');
  if (fs.existsSync(itemsDir)) {
    for (const name of fs.readdirSync(itemsDir).filter(name => name.endsWith('.json')).sort()) {
      items.push(readJson(path.join(itemsDir, name)));
    }
  }

  const lanes = [];
  const lanesDir = path.join(root, 'lanes');
  for (const laneName of control.workerLanes ?? []) {
    const laneFile = path.join(lanesDir, `${laneName}.json`);
    if (!fs.existsSync(laneFile)) throw new Error(`Missing lane file: ${laneFile}`);
    lanes.push(readJson(laneFile));
  }

  return { root, control, items, lanes };
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item?.[key] ?? 'unknown';
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function analyzeQueue(queue, policy) {
  const { control, items, lanes } = queue;
  const itemById = new Map(items.filter(item => item?.taskId).map(item => [item.taskId, item]));
  const activeItems = items.filter(item => ACTIVE_TASK_STATES.has(item.status));
  const availableLanes = lanes.filter(lane => ASSIGNABLE_LANE_STATES.has(lane.state) && lane.currentTaskId === null);

  const candidates = items.filter(item => {
    if (item.status !== 'queued' || item.assignedLane !== null) return false;
    if (item.role !== 'preparation') return false;
    if (!sameSource(item.sourceRequirements, control.requirements)) return false;
    for (const dependencyId of item.dependencies ?? []) {
      const dependency = itemById.get(dependencyId);
      if (!dependency || !DEPENDENCY_SATISFIED_STATES.has(dependency.status)) return false;
    }
    return true;
  }).sort((a, b) => {
    const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
    return priorityDelta !== 0 ? priorityDelta : String(a.taskId).localeCompare(String(b.taskId));
  });

  const sequentialBlocked = policy.budget.maxParallelWorkers === 1 && activeItems.length > 0;
  const mechanicallyEligible = control.syncState === 'synced' &&
    control.activeRunId === null &&
    !sequentialBlocked &&
    availableLanes.length > 0
      ? candidates
      : [];

  return {
    repository: control.repository ?? null,
    requirements: control.requirements ?? null,
    generationRevision: control.generationRevision ?? null,
    syncState: control.syncState ?? 'unknown',
    activeRunId: control.activeRunId ?? null,
    itemCounts: countBy(items, 'status'),
    laneCounts: countBy(lanes, 'state'),
    activeTasks: activeItems.map(item => ({ taskId: item.taskId, status: item.status, assignedLane: item.assignedLane ?? null })),
    availableLanes: availableLanes.map(lane => lane.lane),
    candidates: mechanicallyEligible.map(item => ({
      taskId: item.taskId,
      title: item.title ?? null,
      priority: item.priority ?? 0,
      role: item.role ?? null,
      safeParallel: item.safeParallel === true,
      dependencies: item.dependencies ?? [],
      validationRequirements: item.validationRequirements ?? []
    })),
    allTasksTerminal: items.length > 0 && items.every(item => TERMINAL_TASK_STATES.has(item.status)),
    hasQueuedTasks: items.some(item => item.status === 'queued'),
    sequentialBlocked
  };
}

function resolveVerifier(policy, selectedTask) {
  return {
    minimumLevel: policy.verification.minimumLevel,
    protected: policy.verification.protected === true,
    evidenceRequired: policy.verification.evidenceRequired !== false,
    allowWorkerToModifyVerifier: policy.verification.allowWorkerToModifyVerifier === true,
    policyChecks: [...policy.verification.requiredChecks],
    taskValidationRequirements: selectedTask?.validationRequirements ?? [],
    finalAuthorityBoundary: policy.verification.protected === true && policy.verification.allowWorkerToModifyVerifier !== true
      ? 'protected'
      : 'not_protected'
  };
}

function deriveDecision({ policy, repository, queue }) {
  const blockers = [];
  const requirementsEvidence = queue.requirementsEvidence;

  if (policy.permissions.repositoryRead !== true) blockers.push('repository_read_permission_denied');
  if (!repository.exists || !repository.isGitRepository) blockers.push('repository_unavailable');
  if (repository.identityState === 'unknown') blockers.push('repository_identity_unverified');
  if (repository.identityState === 'mismatch') blockers.push('repository_identity_mismatch');
  if (repository.requiredSources.some(source => !source.safePath)) blockers.push('unsafe_required_source_path');
  if (repository.requiredSources.some(source => source.safePath && !source.exists)) blockers.push('required_source_missing');
  if (queue.repository !== policy.repository) blockers.push('queue_repository_mismatch');
  if (!requirementsEvidence?.safePath) blockers.push('queue_requirements_path_unsafe');
  if (requirementsEvidence?.safePath && !requirementsEvidence.exists) blockers.push('queue_requirements_missing');
  if (requirementsEvidence?.revisionState === 'unsupported_revision_type') blockers.push('queue_requirements_revision_unsupported');
  if (requirementsEvidence?.revisionState === 'unverified') blockers.push('queue_requirements_revision_unverified');
  if (requirementsEvidence?.revisionState === 'mismatch') blockers.push('queue_requirements_revision_mismatch');
  if (requirementsEvidence?.workingTreeDirty === true) blockers.push('queue_requirements_worktree_dirty');
  if (queue.syncState !== 'synced') blockers.push('queue_not_synced');
  if (queue.activeRunId !== null) blockers.push('queue_active_run_present');
  if (queue.sequentialBlocked) blockers.push('active_task_present_in_sequential_mode');
  if (queue.availableLanes.length === 0) blockers.push('no_assignable_lane');

  const selectedTask = blockers.length === 0 ? queue.candidates[0] ?? null : null;

  if (blockers.length > 0) {
    return {
      state: 'blocked',
      terminalStateCandidate: 'blocked',
      nextAction: 'reconcile_blockers',
      blockers,
      selectedTask: null,
      assignmentAuthority: false,
      note: 'Dry-run output is advisory and does not assign, claim, mutate, merge, or deploy.'
    };
  }

  if (selectedTask) {
    return {
      state: 'ready',
      terminalStateCandidate: null,
      nextAction: 'simulate_assignment_review',
      blockers: [],
      selectedTask,
      assignmentAuthority: false,
      note: 'Mechanical eligibility is not semantic assignment authority; coordinator review remains required.'
    };
  }

  if (queue.allTasksTerminal) {
    return {
      state: 'verifying',
      terminalStateCandidate: null,
      nextAction: 'resolve_completion_verifier',
      blockers: [],
      selectedTask: null,
      assignmentAuthority: false,
      note: 'Queue exhaustion alone is not proof that the Loop goal passed.'
    };
  }

  return {
    state: 'waiting',
    terminalStateCandidate: null,
    nextAction: queue.hasQueuedTasks ? 'wait_for_dependencies_or_reconcile' : 'no_queue_work',
    blockers: [],
    selectedTask: null,
    assignmentAuthority: false,
    note: 'No mechanically eligible task is currently available.'
  };
}

function effectiveReadOnlyPermissions(policy) {
  return {
    requestedByPolicy: { ...policy.permissions },
    effectiveForPhaseA: {
      repositoryRead: policy.permissions.repositoryRead === true,
      workingBranchWrite: false,
      commit: false,
      pushWorkingBranch: false,
      defaultBranchWrite: false,
      merge: false,
      deploy: false,
      externalNetwork: false,
      secretAccess: false
    },
    readOnlyOverride: true
  };
}

export function runDryRunController({ policyPath, schemaPath, queueDir, repoRoot, now = new Date().toISOString() }) {
  const policy = readJson(path.resolve(policyPath));
  const schema = readJson(path.resolve(schemaPath));
  const validation = validateJsonSchema(policy, schema);
  if (!validation.valid) {
    const error = new Error(`Loop policy validation failed with ${validation.errors.length} error(s).`);
    error.code = 'INVALID_LOOP_POLICY';
    error.validationErrors = validation.errors;
    throw error;
  }

  const repository = inspectRepository(repoRoot, policy);
  const queueRecord = loadQueue(queueDir);
  const queue = analyzeQueue(queueRecord, policy);
  queue.requirementsEvidence = inspectQueueRequirements(repoRoot, queue.requirements);
  const decision = deriveDecision({ policy, repository, queue });
  const verifier = resolveVerifier(policy, decision.selectedTask);

  return {
    schemaVersion: 1,
    authority: 'derived-loop-dry-run-only',
    mode: 'read_only_dry_run',
    generatedAt: now,
    policy: {
      policyVersion: policy.policyVersion,
      loopId: policy.loopId,
      repository: policy.repository,
      autonomyLevel: policy.autonomyLevel ?? 'L1_WORKTREE',
      trigger: policy.trigger,
      budget: policy.budget,
      stop: policy.stop
    },
    permissions: effectiveReadOnlyPermissions(policy),
    repository,
    queue,
    verifier,
    decision
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) throw new Error(`Unexpected argument: ${current}`);
    const key = current.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function resolveSchemaPath(args) {
  if (args.schema) return args.schema;
  const guideRoot = args['guide-root'] ?? process.env.WEB_PROJECT_GUIDE_ROOT;
  if (!guideRoot) {
    throw new Error('Provide --schema or --guide-root (or WEB_PROJECT_GUIDE_ROOT) so the Current Guide schema remains the policy authority.');
  }
  return path.join(guideRoot, 'maintenance', 'loop-policy.schema.json');
}

function usage() {
  return [
    'Usage:',
    '  node tools/loop-engineering/dry-run-controller.mjs \\',
    '    --policy <loop-policy.json> \\',
    '    --guide-root <web-project-guide-root> \\',
    '    --queue <work-queues/Owner--repo> \\',
    '    --repo-root <target-repository-root>',
    '',
    'Alternative: pass --schema <loop-policy.schema.json> instead of --guide-root.',
    'Phase A is read-only: it never assigns, claims, writes, commits, merges, deploys, or persists Loop state.'
  ].join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.includes('--help')) {
      console.log(usage());
      process.exit(0);
    }
    const args = parseArgs(process.argv.slice(2));
    for (const required of ['policy', 'queue', 'repo-root']) {
      if (!args[required]) throw new Error(`Missing required --${required}.\n\n${usage()}`);
    }
    const result = runDryRunController({
      policyPath: args.policy,
      schemaPath: resolveSchemaPath(args),
      queueDir: args.queue,
      repoRoot: args['repo-root']
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const payload = {
      ok: false,
      code: error.code ?? 'LOOP_DRY_RUN_ERROR',
      message: error.message,
      validationErrors: error.validationErrors ?? undefined
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  }
}
