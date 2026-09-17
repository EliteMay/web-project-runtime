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
const laneAssignableStates = new Set(['idle', 'waiting']);
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

function loadQueue(queueDir) {
  const controlFile = path.join(queueDir, 'control.json');
  if (!fs.existsSync(controlFile)) throw new Error(`Missing queue control: ${controlFile}`);
  const control = readJson(controlFile);

  const items = new Map();
  const itemsDir = path.join(queueDir, 'items');
  if (fs.existsSync(itemsDir)) {
    for (const name of fs.readdirSync(itemsDir).filter(name => name.endsWith('.json'))) {
      const file = path.join(itemsDir, name);
      const item = readJson(file);
      if (item?.taskId) items.set(item.taskId, { file, item });
    }
  }

  const lanes = new Map();
  const lanesDir = path.join(queueDir, 'lanes');
  for (const laneName of control.workerLanes ?? []) {
    const file = path.join(lanesDir, `${laneName}.json`);
    if (!fs.existsSync(file)) throw new Error(`Missing lane file: ${file}`);
    lanes.set(laneName, { file, lane: readJson(file) });
  }

  return { controlFile, control, items, lanes };
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Assignment plan must be an object.');
  if (plan.schemaVersion !== 1) throw new Error('plan.schemaVersion must be 1.');
  if (typeof plan.repository !== 'string' || !repoPattern.test(plan.repository)) throw new Error('plan.repository must be owner/repo.');
  if (!Number.isInteger(plan.expectedGenerationRevision) || plan.expectedGenerationRevision < 1) {
    throw new Error('plan.expectedGenerationRevision must be an integer >= 1.');
  }
  if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) throw new Error('plan.assignments must be non-empty.');

  const seenLanes = new Set();
  const seenTasks = new Set();
  for (const assignment of plan.assignments) {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) throw new Error('Every assignment must be an object.');
    if (typeof assignment.lane !== 'string' || !lanePattern.test(assignment.lane)) throw new Error(`Invalid lane: ${String(assignment.lane)}`);
    if (typeof assignment.taskId !== 'string' || !taskIdPattern.test(assignment.taskId)) throw new Error(`Invalid taskId: ${String(assignment.taskId)}`);
    if (seenLanes.has(assignment.lane)) throw new Error(`Lane ${assignment.lane} appears more than once in one assignment plan.`);
    if (seenTasks.has(assignment.taskId)) throw new Error(`Task ${assignment.taskId} appears more than once in one assignment plan.`);
    seenLanes.add(assignment.lane);
    seenTasks.add(assignment.taskId);
  }
}

function analyzeAssignments(queue, plan) {
  const { control, items, lanes } = queue;
  validatePlan(plan);

  if (control.repository !== plan.repository) throw new Error('Assignment plan repository does not match queue control.');
  if (control.syncState !== 'synced') throw new Error(`Queue syncState must be synced before assignment; current=${control.syncState}.`);
  if (control.generationRevision !== plan.expectedGenerationRevision) {
    throw new Error(`Stale assignment plan: expected generation ${plan.expectedGenerationRevision}, current=${control.generationRevision}.`);
  }

  const pending = [];
  const alreadyApplied = [];

  for (const assignment of plan.assignments) {
    const itemRecord = items.get(assignment.taskId);
    const laneRecord = lanes.get(assignment.lane);
    if (!itemRecord) throw new Error(`Task ${assignment.taskId} does not exist.`);
    if (!laneRecord) throw new Error(`Lane ${assignment.lane} is not declared by this queue.`);

    const item = itemRecord.item;
    const lane = laneRecord.lane;
    const isAlreadyApplied = activeStatuses.has(item.status) &&
      item.assignedLane === assignment.lane &&
      lane.currentTaskId === assignment.taskId &&
      lane.assignmentRevision === item.assignmentRevision;

    if (isAlreadyApplied) {
      alreadyApplied.push(assignment);
      continue;
    }

    if (item.status !== 'queued') throw new Error(`Task ${assignment.taskId} is not queued; current=${item.status}.`);
    if (item.assignedLane !== null) throw new Error(`Task ${assignment.taskId} already has assignedLane=${item.assignedLane}.`);
    if (item.role !== 'preparation') throw new Error(`Task ${assignment.taskId} role=${item.role} cannot be assigned to a preparation lane.`);
    if (!sameSource(item.sourceRequirements, control.requirements)) {
      throw new Error(`Task ${assignment.taskId} does not match the current requirements revision.`);
    }
    if (!laneAssignableStates.has(lane.state) || lane.currentTaskId !== null) {
      throw new Error(`Lane ${assignment.lane} is not available; state=${lane.state}, currentTaskId=${lane.currentTaskId}.`);
    }

    for (const dependencyId of item.dependencies ?? []) {
      const dependency = items.get(dependencyId)?.item;
      if (!dependency) throw new Error(`Task ${assignment.taskId} dependency ${dependencyId} does not exist.`);
      if (!dependencySatisfiedStatuses.has(dependency.status)) {
        throw new Error(`Task ${assignment.taskId} dependency ${dependencyId} is not resolved; current=${dependency.status}.`);
      }
    }

    pending.push({ assignment, itemRecord, laneRecord });
  }

  const pendingTaskIds = new Set(pending.map(entry => entry.assignment.taskId));
  const existingActiveItems = [...items.values()]
    .map(record => record.item)
    .filter(item => activeStatuses.has(item.status) && !pendingTaskIds.has(item.taskId));

  if (pending.length > 0) {
    const activeUnsafe = existingActiveItems.find(item => item.safeParallel === false);
    if (activeUnsafe) {
      throw new Error(`Cannot add assignment while unsafe active task ${activeUnsafe.taskId} is still active.`);
    }

    if (pending.length > 1) {
      const unsafe = pending.find(entry => entry.itemRecord.item.safeParallel !== true);
      if (unsafe) {
        throw new Error(`Multi-lane assignment requires every new task to declare safeParallel=true; ${unsafe.assignment.taskId} does not.`);
      }
    }

    const singleUnsafe = pending.length === 1 && pending[0].itemRecord.item.safeParallel === false;
    if (singleUnsafe && existingActiveItems.length > 0) {
      throw new Error(`Unsafe task ${pending[0].assignment.taskId} requires no other active assignments.`);
    }
  }

  return { pending, alreadyApplied };
}

function validateQueueRoot(queueDir) {
  const queueRoot = path.dirname(path.resolve(queueDir));
  const validator = path.resolve('tools/work-queues/validate-work-queues.mjs');
  const result = spawnSync(process.execPath, [validator, queueRoot], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  return result;
}

export function applyAssignmentPlan(queueDir, plan, { dryRun = false, now = new Date().toISOString() } = {}) {
  const queue = loadQueue(queueDir);
  const analysis = analyzeAssignments(queue, plan);

  if (dryRun || analysis.pending.length === 0) {
    return {
      changed: false,
      pending: analysis.pending.map(entry => entry.assignment),
      alreadyApplied: analysis.alreadyApplied
    };
  }

  const backups = new Map();
  const remember = file => {
    if (!backups.has(file)) backups.set(file, fs.readFileSync(file, 'utf8'));
  };

  remember(queue.controlFile);
  for (const entry of analysis.pending) {
    remember(entry.itemRecord.file);
    remember(entry.laneRecord.file);
  }

  try {
    for (const entry of analysis.pending) {
      const { assignment, itemRecord, laneRecord } = entry;
      const nextRevision = Math.max(itemRecord.item.assignmentRevision ?? 1, laneRecord.lane.assignmentRevision ?? 1) + 1;

      writeJson(itemRecord.file, {
        ...itemRecord.item,
        status: 'assigned',
        assignedLane: assignment.lane,
        assignmentRevision: nextRevision,
        updatedAt: now,
        completedAt: null
      });

      writeJson(laneRecord.file, {
        ...laneRecord.lane,
        state: 'assigned',
        currentTaskId: assignment.taskId,
        assignmentRevision: nextRevision,
        updatedAt: now
      });
    }

    writeJson(queue.controlFile, {
      ...queue.control,
      updatedAt: now
    });

    const validation = validateQueueRoot(queueDir);
    if (validation.status !== 0) {
      throw new Error(`Queue validation failed after assignment.\n${validation.stdout ?? ''}${validation.stderr ?? ''}`);
    }
  } catch (error) {
    for (const [file, content] of backups) fs.writeFileSync(file, content, 'utf8');
    throw error;
  }

  return {
    changed: true,
    pending: analysis.pending.map(entry => entry.assignment),
    alreadyApplied: analysis.alreadyApplied
  };
}

function runCli() {
  const queueDir = process.argv[2];
  const planFile = process.argv[3];
  const dryRun = process.argv.includes('--dry-run');
  if (!queueDir || !planFile) {
    console.error('Usage: node tools/work-queues/assign-work-queue.mjs <queue-dir> <assignment-plan.json> [--dry-run]');
    process.exit(2);
  }

  try {
    const plan = readJson(planFile);
    const result = applyAssignmentPlan(queueDir, plan, { dryRun });
    if (result.pending.length === 0 && result.alreadyApplied.length > 0) {
      console.log(`Assignment already applied for ${result.alreadyApplied.length} task(s); no changes needed.`);
      return;
    }
    if (dryRun) {
      console.log(`Assignment plan is valid for ${result.pending.length} new task(s); no files changed.`);
      return;
    }
    console.log(`Assigned ${result.pending.length} task(s) safely.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) runCli();
