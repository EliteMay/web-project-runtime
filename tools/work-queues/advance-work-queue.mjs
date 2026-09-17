import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const activeStatuses = new Set([
  'assigned',
  'claimed',
  'working',
  'blocked',
  'ready_for_apply',
  'needs_reconcile'
]);
const dependencySatisfiedStatuses = new Set(['completed', 'resolved']);
const repoPattern = /^[^/\s]+\/[^/\s]+$/;
const taskIdPattern = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const lanePattern = /^[A-Z][A-Z0-9_-]*$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sameSource(a, b) {
  return a?.path === b?.path && a?.revisionType === b?.revisionType && a?.revision === b?.revision;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Advance plan must be an object.');
  if (plan.schemaVersion !== 1) throw new Error('plan.schemaVersion must be 1.');
  if (typeof plan.repository !== 'string' || !repoPattern.test(plan.repository)) throw new Error('plan.repository must be owner/repo.');
  if (!Number.isInteger(plan.expectedGenerationRevision) || plan.expectedGenerationRevision < 1) {
    throw new Error('plan.expectedGenerationRevision must be an integer >= 1.');
  }
  if (typeof plan.lane !== 'string' || !lanePattern.test(plan.lane)) throw new Error('plan.lane is invalid.');
  if (typeof plan.taskId !== 'string' || !taskIdPattern.test(plan.taskId)) throw new Error('plan.taskId is invalid.');
  if (plan.completionVerified !== true) throw new Error('plan.completionVerified must be true.');
  if (plan.validationVerified !== true) throw new Error('plan.validationVerified must be true.');
  if (!(plan.nextTaskId === null || (typeof plan.nextTaskId === 'string' && taskIdPattern.test(plan.nextTaskId)))) {
    throw new Error('plan.nextTaskId must be a taskId or null.');
  }
  if (plan.nextTaskId === plan.taskId) throw new Error('plan.nextTaskId must not equal plan.taskId.');
}

function loadQueue(queueDir) {
  const controlFile = path.join(queueDir, 'control.json');
  if (!fs.existsSync(controlFile)) throw new Error(`Missing queue control: ${controlFile}`);
  const control = readJson(controlFile);

  const itemsDir = path.join(queueDir, 'items');
  if (!fs.existsSync(itemsDir)) throw new Error(`Missing queue items directory: ${itemsDir}`);
  const items = new Map();
  for (const name of fs.readdirSync(itemsDir).filter(name => name.endsWith('.json'))) {
    const file = path.join(itemsDir, name);
    const item = readJson(file);
    if (item?.taskId) items.set(item.taskId, { file, item });
  }

  return { controlFile, control, items };
}

function validateQueueRoot(queueDir) {
  const queueRoot = path.dirname(path.resolve(queueDir));
  const validator = path.resolve('tools/work-queues/validate-work-queues.mjs');
  return spawnSync(process.execPath, [validator, queueRoot], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

function idempotentState(queueDir, items, plan) {
  const current = items.get(plan.taskId)?.item;
  if (!current || current.status !== 'completed') return false;

  const laneFile = path.join(queueDir, 'lanes', `${plan.lane}.json`);
  if (!fs.existsSync(laneFile)) return false;
  const lane = readJson(laneFile);

  if (plan.nextTaskId === null) {
    return lane.lane === plan.lane && lane.state === 'waiting' && lane.currentTaskId === null;
  }

  const next = items.get(plan.nextTaskId)?.item;
  return lane.lane === plan.lane &&
    lane.currentTaskId === plan.nextTaskId &&
    lane.state === 'assigned' &&
    next &&
    next.status === 'assigned' &&
    next.assignedLane === plan.lane &&
    next.assignmentRevision === lane.assignmentRevision;
}

function analyzeAdvance(queueDir, queue, plan) {
  const { control, items } = queue;
  validatePlan(plan);

  if (control.repository !== plan.repository) throw new Error('Advance plan repository does not match queue control.');
  if (control.syncState !== 'synced') throw new Error(`Queue syncState must be synced before advance; current=${control.syncState}.`);
  if (control.generationRevision !== plan.expectedGenerationRevision) {
    throw new Error(`Stale advance plan: expected generation ${plan.expectedGenerationRevision}, current=${control.generationRevision}.`);
  }
  if (!Array.isArray(control.workerLanes) || !control.workerLanes.includes(plan.lane)) {
    throw new Error(`Lane ${plan.lane} is not declared by this queue.`);
  }

  if (idempotentState(queueDir, items, plan)) return { alreadyApplied: true };

  const currentRecord = items.get(plan.taskId);
  if (!currentRecord) throw new Error(`Current task ${plan.taskId} does not exist.`);
  const current = currentRecord.item;
  const laneFile = path.join(queueDir, 'lanes', `${plan.lane}.json`);
  if (!fs.existsSync(laneFile)) throw new Error(`Missing lane file: ${laneFile}`);
  const lane = readJson(laneFile);

  if (current.status !== 'ready_for_apply') {
    throw new Error(`Current task ${plan.taskId} must be ready_for_apply before completion; current=${current.status}.`);
  }
  if (current.assignedLane !== plan.lane) throw new Error(`Current task ${plan.taskId} is not assigned to lane ${plan.lane}.`);
  if (lane.currentTaskId !== plan.taskId) throw new Error(`Lane ${plan.lane} does not point at current task ${plan.taskId}.`);
  if (lane.state !== 'ready_for_apply') throw new Error(`Lane ${plan.lane} must be ready_for_apply before completion; current=${lane.state}.`);
  if (lane.assignmentRevision !== current.assignmentRevision) throw new Error('Current task/lane assignmentRevision mismatch.');
  if (!sameSource(current.sourceRequirements, control.requirements)) {
    throw new Error(`Current task ${plan.taskId} does not match the current requirements revision.`);
  }

  let nextRecord = null;
  if (plan.nextTaskId !== null) {
    nextRecord = items.get(plan.nextTaskId);
    if (!nextRecord) throw new Error(`Next task ${plan.nextTaskId} does not exist.`);
    const next = nextRecord.item;
    if (next.status !== 'queued') throw new Error(`Next task ${plan.nextTaskId} is not queued; current=${next.status}.`);
    if (next.assignedLane !== null) throw new Error(`Next task ${plan.nextTaskId} already has assignedLane=${next.assignedLane}.`);
    if (next.role !== 'preparation') throw new Error(`Next task ${plan.nextTaskId} role=${next.role} cannot be assigned to a preparation lane.`);
    if (!sameSource(next.sourceRequirements, control.requirements)) {
      throw new Error(`Next task ${plan.nextTaskId} does not match the current requirements revision.`);
    }

    for (const dependencyId of next.dependencies ?? []) {
      if (dependencyId === plan.taskId) continue;
      const dependency = items.get(dependencyId)?.item;
      if (!dependency) throw new Error(`Next task ${plan.nextTaskId} dependency ${dependencyId} does not exist.`);
      if (!dependencySatisfiedStatuses.has(dependency.status)) {
        throw new Error(`Next task ${plan.nextTaskId} dependency ${dependencyId} is not resolved; current=${dependency.status}.`);
      }
    }

    const otherActiveItems = [...items.values()]
      .map(record => record.item)
      .filter(item => item.taskId !== plan.taskId && item.taskId !== plan.nextTaskId && activeStatuses.has(item.status));

    const activeUnsafe = otherActiveItems.find(item => item.safeParallel !== true);
    if (activeUnsafe) {
      throw new Error(`Cannot advance to a new assignment while unsafe active task ${activeUnsafe.taskId} is still active.`);
    }
    if (next.safeParallel !== true && otherActiveItems.length > 0) {
      throw new Error(`Unsafe next task ${plan.nextTaskId} requires no other active assignments.`);
    }
  }

  return {
    alreadyApplied: false,
    currentRecord,
    laneFile,
    lane,
    nextRecord
  };
}

export function applyAdvancePlan(queueDir, plan, { dryRun = false, now = new Date().toISOString() } = {}) {
  const queue = loadQueue(queueDir);
  const analysis = analyzeAdvance(queueDir, queue, plan);
  if (analysis.alreadyApplied) return { changed: false, alreadyApplied: true };
  if (dryRun) return { changed: false, alreadyApplied: false };

  const backups = new Map();
  const remember = file => {
    if (!backups.has(file)) backups.set(file, fs.readFileSync(file, 'utf8'));
  };

  remember(queue.controlFile);
  remember(analysis.currentRecord.file);
  remember(analysis.laneFile);
  if (analysis.nextRecord) remember(analysis.nextRecord.file);

  try {
    writeJson(analysis.currentRecord.file, {
      ...analysis.currentRecord.item,
      status: 'completed',
      updatedAt: now,
      completedAt: now
    });

    if (analysis.nextRecord) {
      const nextRevision = Math.max(
        analysis.nextRecord.item.assignmentRevision ?? 1,
        analysis.lane.assignmentRevision ?? 1
      ) + 1;

      writeJson(analysis.nextRecord.file, {
        ...analysis.nextRecord.item,
        status: 'assigned',
        assignedLane: plan.lane,
        assignmentRevision: nextRevision,
        updatedAt: now,
        completedAt: null
      });

      writeJson(analysis.laneFile, {
        ...analysis.lane,
        state: 'assigned',
        currentTaskId: plan.nextTaskId,
        assignmentRevision: nextRevision,
        updatedAt: now
      });
    } else {
      writeJson(analysis.laneFile, {
        ...analysis.lane,
        state: 'waiting',
        currentTaskId: null,
        updatedAt: now
      });
    }

    writeJson(queue.controlFile, {
      ...queue.control,
      updatedAt: now
    });

    const validation = validateQueueRoot(queueDir);
    if (validation.status !== 0) {
      throw new Error(`Queue validation failed after advance.\n${validation.stdout ?? ''}${validation.stderr ?? ''}`);
    }
  } catch (error) {
    for (const [file, content] of backups) fs.writeFileSync(file, content, 'utf8');
    throw error;
  }

  return { changed: true, alreadyApplied: false };
}

function runCli() {
  const queueDir = process.argv[2];
  const planFile = process.argv[3];
  const dryRun = process.argv.includes('--dry-run');
  if (!queueDir || !planFile) {
    console.error('Usage: node tools/work-queues/advance-work-queue.mjs <queue-dir> <advance-plan.json> [--dry-run]');
    process.exit(2);
  }

  try {
    const plan = readJson(planFile);
    const result = applyAdvancePlan(queueDir, plan, { dryRun });
    if (result.alreadyApplied) {
      console.log('Advance plan is already applied; no changes needed.');
      return;
    }
    if (dryRun) {
      console.log('Advance plan is valid; no files changed.');
      return;
    }
    console.log(plan.nextTaskId ? `Completed ${plan.taskId} and assigned ${plan.nextTaskId} to ${plan.lane}.` : `Completed ${plan.taskId}; ${plan.lane} is waiting for the next assignment.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) runCli();
