import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoPattern = /^[^/\s]+\/[^/\s]+$/;
const lanePattern = /^[A-Z][A-Z0-9_-]*$/;
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
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Claim plan must be an object.');
  if (plan.schemaVersion !== 1) throw new Error('plan.schemaVersion must be 1.');
  if (typeof plan.repository !== 'string' || !repoPattern.test(plan.repository)) throw new Error('plan.repository must be owner/repo.');
  if (typeof plan.lane !== 'string' || !lanePattern.test(plan.lane)) throw new Error('plan.lane is invalid.');
  if (!Number.isInteger(plan.expectedGenerationRevision) || plan.expectedGenerationRevision < 1) throw new Error('plan.expectedGenerationRevision must be >= 1.');
  if (!Number.isInteger(plan.expectedAssignmentRevision) || plan.expectedAssignmentRevision < 1) throw new Error('plan.expectedAssignmentRevision must be >= 1.');
  if (typeof plan.holderId !== 'string' || !holderPattern.test(plan.holderId)) throw new Error('plan.holderId is invalid.');
}

function load(queueDir, laneName) {
  const controlFile = path.join(queueDir, 'control.json');
  const laneFile = path.join(queueDir, 'lanes', `${laneName}.json`);
  if (!fs.existsSync(controlFile)) throw new Error(`Missing queue control: ${controlFile}`);
  if (!fs.existsSync(laneFile)) throw new Error(`Missing lane: ${laneFile}`);
  const control = readJson(controlFile);
  const lane = readJson(laneFile);
  if (!lane.currentTaskId) throw new Error(`Lane ${laneName} has no current assignment.`);
  const itemFile = path.join(queueDir, 'items', `${lane.currentTaskId}.json`);
  if (!fs.existsSync(itemFile)) throw new Error(`Current task does not exist: ${lane.currentTaskId}`);
  const item = readJson(itemFile);
  return { controlFile, laneFile, itemFile, control, lane, item };
}

function validateQueueRoot(queueDir) {
  const queueRoot = path.dirname(path.resolve(queueDir));
  const validator = path.resolve('tools/work-queues/validate-work-queues.mjs');
  return spawnSync(process.execPath, [validator, queueRoot], { cwd: process.cwd(), encoding: 'utf8' });
}

export function claimAssignment(queueDir, plan, { dryRun = false, now = new Date().toISOString() } = {}) {
  validatePlan(plan);
  const state = load(queueDir, plan.lane);
  const { control, lane, item } = state;

  if (control.repository !== plan.repository || lane.repository !== plan.repository || item.repository !== plan.repository) {
    throw new Error('Claim plan repository does not match queue state.');
  }
  if (control.syncState !== 'synced') throw new Error(`Queue syncState must be synced before claim; current=${control.syncState}.`);
  if (control.generationRevision !== plan.expectedGenerationRevision) throw new Error('Stale claim plan: generation revision changed.');
  if (lane.assignmentRevision !== plan.expectedAssignmentRevision || item.assignmentRevision !== plan.expectedAssignmentRevision) {
    throw new Error('Stale claim plan: assignment revision changed.');
  }
  if (item.assignedLane !== plan.lane || lane.currentTaskId !== item.taskId) throw new Error('Lane/task assignment mismatch.');
  if (!sameSource(item.sourceRequirements, control.requirements)) throw new Error('Current assignment no longer matches current Requirements revision.');

  const claimedBySameHolder = item.claimHolderId === plan.holderId && item.claimedAt && ['working', 'blocked', 'ready_for_apply'].includes(item.status);
  if (claimedBySameHolder) {
    const needsLaneRepair = lane.state === 'assigned';
    if (dryRun || !needsLaneRepair) return { changed: false, repaired: false, taskId: item.taskId };
    const backup = fs.readFileSync(state.laneFile, 'utf8');
    try {
      writeJson(state.laneFile, { ...lane, state: 'working', updatedAt: now });
      const validation = validateQueueRoot(queueDir);
      if (validation.status !== 0) throw new Error(`Queue validation failed after claim recovery.\n${validation.stdout ?? ''}${validation.stderr ?? ''}`);
    } catch (error) {
      fs.writeFileSync(state.laneFile, backup, 'utf8');
      throw error;
    }
    return { changed: true, repaired: true, taskId: item.taskId };
  }

  if (item.claimHolderId && item.claimHolderId !== plan.holderId) throw new Error('Current assignment is already claimed by another holder.');
  if (item.status !== 'assigned') throw new Error(`Current task is not claimable; status=${item.status}.`);
  if (lane.state !== 'assigned') throw new Error(`Lane is not claimable; state=${lane.state}.`);

  if (dryRun) return { changed: false, repaired: false, taskId: item.taskId };

  const backups = new Map([
    [state.itemFile, fs.readFileSync(state.itemFile, 'utf8')],
    [state.laneFile, fs.readFileSync(state.laneFile, 'utf8')]
  ]);

  try {
    writeJson(state.itemFile, {
      ...item,
      status: 'working',
      claimHolderId: plan.holderId,
      claimedAt: now,
      updatedAt: now
    });
    writeJson(state.laneFile, { ...lane, state: 'working', updatedAt: now });
    const validation = validateQueueRoot(queueDir);
    if (validation.status !== 0) throw new Error(`Queue validation failed after claim.\n${validation.stdout ?? ''}${validation.stderr ?? ''}`);
  } catch (error) {
    for (const [file, content] of backups) fs.writeFileSync(file, content, 'utf8');
    throw error;
  }

  return { changed: true, repaired: false, taskId: item.taskId };
}

function runCli() {
  const queueDir = process.argv[2];
  const planFile = process.argv[3];
  const dryRun = process.argv.includes('--dry-run');
  if (!queueDir || !planFile) {
    console.error('Usage: node tools/work-queues/claim-work-queue.mjs <queue-dir> <claim-plan.json> [--dry-run]');
    process.exit(2);
  }
  try {
    const result = claimAssignment(queueDir, readJson(planFile), { dryRun });
    if (dryRun) console.log(`Claim is valid for ${result.taskId}; no files changed.`);
    else if (!result.changed) console.log(`Assignment ${result.taskId} is already claimed by this holder.`);
    else if (result.repaired) console.log(`Recovered lane state for ${result.taskId}.`);
    else console.log(`Claimed ${result.taskId} successfully.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) runCli();
