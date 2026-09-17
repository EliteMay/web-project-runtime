import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoPattern = /^[^/\s]+\/[^/\s]+$/;
const lanePattern = /^[A-Z][A-Z0-9_-]*$/;
const taskIdPattern = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const holderPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

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
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Block plan must be an object.');
  if (plan.schemaVersion !== 1) throw new Error('plan.schemaVersion must be 1.');
  if (typeof plan.repository !== 'string' || !repoPattern.test(plan.repository)) throw new Error('plan.repository must be owner/repo.');
  if (typeof plan.lane !== 'string' || !lanePattern.test(plan.lane)) throw new Error('plan.lane is invalid.');
  if (typeof plan.taskId !== 'string' || !taskIdPattern.test(plan.taskId)) throw new Error('plan.taskId is invalid.');
  if (!Number.isInteger(plan.expectedGenerationRevision) || plan.expectedGenerationRevision < 1) throw new Error('plan.expectedGenerationRevision must be >= 1.');
  if (!Number.isInteger(plan.expectedAssignmentRevision) || plan.expectedAssignmentRevision < 1) throw new Error('plan.expectedAssignmentRevision must be >= 1.');
  if (typeof plan.holderId !== 'string' || !holderPattern.test(plan.holderId)) throw new Error('plan.holderId is invalid.');
}

function load(queueDir, laneName, taskId) {
  const controlFile = path.join(queueDir, 'control.json');
  const laneFile = path.join(queueDir, 'lanes', `${laneName}.json`);
  const itemFile = path.join(queueDir, 'items', `${taskId}.json`);
  for (const file of [controlFile, laneFile, itemFile]) {
    if (!fs.existsSync(file)) throw new Error(`Missing queue record: ${file}`);
  }
  return {
    controlFile,
    laneFile,
    itemFile,
    control: readJson(controlFile),
    lane: readJson(laneFile),
    item: readJson(itemFile)
  };
}

function validateQueueRoot(queueDir) {
  const queueRoot = path.dirname(path.resolve(queueDir));
  const validator = path.resolve('tools/work-queues/validate-work-queues.mjs');
  return spawnSync(process.execPath, [validator, queueRoot], { cwd: process.cwd(), encoding: 'utf8' });
}

export function blockWorkQueueTask(queueDir, plan, { dryRun = false, now = new Date().toISOString() } = {}) {
  validatePlan(plan);
  const state = load(queueDir, plan.lane, plan.taskId);
  const { control, lane, item } = state;

  if (control.repository !== plan.repository || lane.repository !== plan.repository || item.repository !== plan.repository) {
    throw new Error('Block plan repository does not match queue state.');
  }
  if (control.syncState !== 'synced') throw new Error(`Queue syncState must be synced before block transition; current=${control.syncState}.`);
  if (control.generationRevision !== plan.expectedGenerationRevision) throw new Error('Stale block plan: generation revision changed.');
  if (lane.assignmentRevision !== plan.expectedAssignmentRevision || item.assignmentRevision !== plan.expectedAssignmentRevision) {
    throw new Error('Stale block plan: assignment revision changed.');
  }
  if (item.assignedLane !== plan.lane || lane.currentTaskId !== item.taskId || item.taskId !== plan.taskId) {
    throw new Error('Lane/task assignment mismatch.');
  }
  if (!sameSource(item.sourceRequirements, control.requirements)) throw new Error('Current assignment no longer matches current Requirements revision.');
  if (item.claimHolderId !== plan.holderId) throw new Error('Block transition holder does not own the current claim.');

  if (item.status === 'blocked' && lane.state === 'blocked') {
    return { changed: false, taskId: item.taskId };
  }
  if (item.status !== 'working') throw new Error(`Current task is not block-transitionable; status=${item.status}.`);
  if (lane.state !== 'working') throw new Error(`Current lane is not block-transitionable; state=${lane.state}.`);

  if (dryRun) return { changed: false, taskId: item.taskId };

  const backups = new Map([
    [state.itemFile, fs.readFileSync(state.itemFile, 'utf8')],
    [state.laneFile, fs.readFileSync(state.laneFile, 'utf8')]
  ]);

  try {
    writeJson(state.itemFile, { ...item, status: 'blocked', updatedAt: now });
    writeJson(state.laneFile, { ...lane, state: 'blocked', updatedAt: now });
    const validation = validateQueueRoot(queueDir);
    if (validation.status !== 0) {
      throw new Error(`Queue validation failed after blocked transition.\n${validation.stdout ?? ''}${validation.stderr ?? ''}`);
    }
  } catch (error) {
    for (const [file, content] of backups) fs.writeFileSync(file, content, 'utf8');
    throw error;
  }

  return { changed: true, taskId: item.taskId };
}

function runCli() {
  const queueDir = process.argv[2];
  const planFile = process.argv[3];
  const dryRun = process.argv.includes('--dry-run');
  if (!queueDir || !planFile) {
    console.error('Usage: node tools/work-queues/block-work-queue.mjs <queue-dir> <block-plan.json> [--dry-run]');
    process.exit(2);
  }
  try {
    const result = blockWorkQueueTask(queueDir, readJson(planFile), { dryRun });
    if (dryRun) console.log(`Blocked transition is valid for ${result.taskId}; no files changed.`);
    else if (!result.changed) console.log(`${result.taskId} is already blocked.`);
    else console.log(`Marked ${result.taskId} blocked.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) runCli();
