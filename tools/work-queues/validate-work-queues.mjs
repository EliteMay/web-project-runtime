import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? 'work-queues';
const errors = [];
const activeAssignmentStatuses = new Set([
  'assigned',
  'claimed',
  'working',
  'blocked',
  'ready_for_apply',
  'needs_reconcile'
]);
const terminalStatuses = new Set(['completed', 'resolved', 'superseded', 'rejected']);
const allStatuses = new Set([
  'needs_planning', 'needs_review', 'queued', 'assigned', 'claimed', 'working',
  'blocked', 'ready_for_apply', 'completed', 'resolved', 'needs_reconcile',
  'superseded', 'rejected'
]);
const laneStates = new Set(['idle', 'assigned', 'working', 'blocked', 'ready_for_apply', 'waiting']);
const roles = new Set(['preparation', 'integration', 'coordinator']);
const revisionTypes = new Set(['blobSha', 'commitSha']);
const sha40 = /^[0-9a-f]{40}$/;
const repoPattern = /^[^/\s]+\/[^/\s]+$/;
const taskIdPattern = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const lanePattern = /^[A-Z][A-Z0-9_-]*$/;

function err(message) {
  errors.push(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    err(`${file}: invalid JSON (${error.message})`);
    return null;
  }
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || value.length === 0) {
    err(`${label}: expected non-empty string`);
    return false;
  }
  if (pattern && !pattern.test(value)) {
    err(`${label}: invalid format`);
    return false;
  }
  return true;
}

function validateSourceRequirements(source, label) {
  if (!isObject(source)) {
    err(`${label}: expected object`);
    return;
  }
  requireString(source.path, `${label}.path`);
  if (!revisionTypes.has(source.revisionType)) err(`${label}.revisionType: invalid value`);
  requireString(source.revision, `${label}.revision`, sha40);
}

function validateControl(control, file) {
  if (!isObject(control)) {
    err(`${file}: expected object`);
    return false;
  }
  if (control.schemaVersion !== 1) err(`${file}.schemaVersion: expected 1`);
  requireString(control.repository, `${file}.repository`, repoPattern);
  if (!isObject(control.requirements)) {
    err(`${file}.requirements: expected object`);
  } else {
    validateSourceRequirements(control.requirements, `${file}.requirements`);
    if (!isIsoDate(control.requirements.readyAt)) err(`${file}.requirements.readyAt: invalid date-time`);
  }
  if (!Number.isInteger(control.generationRevision) || control.generationRevision < 1) {
    err(`${file}.generationRevision: expected integer >= 1`);
  }
  if (!['pending', 'synced', 'failed', 'needs_reconcile'].includes(control.syncState)) {
    err(`${file}.syncState: invalid value`);
  }
  if (!(control.activeRunId === null || typeof control.activeRunId === 'string')) {
    err(`${file}.activeRunId: expected string|null`);
  }
  if (!Array.isArray(control.workerLanes) || control.workerLanes.length === 0) {
    err(`${file}.workerLanes: expected non-empty array`);
  } else {
    const seen = new Set();
    for (const lane of control.workerLanes) {
      if (typeof lane !== 'string' || !lanePattern.test(lane)) err(`${file}.workerLanes: invalid lane ${String(lane)}`);
      if (seen.has(lane)) err(`${file}.workerLanes: duplicate lane ${lane}`);
      seen.add(lane);
    }
  }
  if (!isIsoDate(control.updatedAt)) err(`${file}.updatedAt: invalid date-time`);
  if (control.syncState === 'failed' && !(typeof control.lastError === 'string' && control.lastError.length > 0)) {
    err(`${file}.lastError: required when syncState=failed`);
  }
  if (control.syncState === 'synced' && control.lastError !== undefined && control.lastError !== null) {
    err(`${file}.lastError: must be null/omitted when syncState=synced`);
  }
  return true;
}

function validateItem(item, file, control) {
  if (!isObject(item)) {
    err(`${file}: expected object`);
    return;
  }
  if (item.schemaVersion !== 1) err(`${file}.schemaVersion: expected 1`);
  requireString(item.taskId, `${file}.taskId`, taskIdPattern);
  if (path.basename(file) !== `${item.taskId}.json`) err(`${file}: filename must match taskId`);
  if (item.repository !== control.repository) err(`${file}.repository: must match control repository`);
  validateSourceRequirements(item.sourceRequirements, `${file}.sourceRequirements`);
  if (!Number.isInteger(item.generationRevision) || item.generationRevision < 1 || item.generationRevision > control.generationRevision) {
    err(`${file}.generationRevision: invalid or newer than control`);
  }
  requireString(item.title, `${file}.title`);
  requireString(item.scope, `${file}.scope`);
  if (!Array.isArray(item.dependencies)) err(`${file}.dependencies: expected array`);
  if (!Array.isArray(item.completionCriteria) || item.completionCriteria.length === 0 || item.completionCriteria.some(v => typeof v !== 'string' || !v)) {
    err(`${file}.completionCriteria: expected non-empty string array`);
  }
  if (item.validationRequirements !== undefined && (!Array.isArray(item.validationRequirements) || item.validationRequirements.some(v => typeof v !== 'string' || !v))) {
    err(`${file}.validationRequirements: expected string array`);
  }
  if (!allStatuses.has(item.status)) err(`${file}.status: invalid value`);
  if (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 100) err(`${file}.priority: expected integer 0..100`);
  if (!roles.has(item.role)) err(`${file}.role: invalid value`);
  if (!(item.assignedLane === null || (typeof item.assignedLane === 'string' && lanePattern.test(item.assignedLane)))) {
    err(`${file}.assignedLane: expected lane|null`);
  }
  if (item.assignedLane && !control.workerLanes.includes(item.assignedLane) && item.role === 'preparation') {
    err(`${file}.assignedLane: lane not declared by control`);
  }
  if (!Number.isInteger(item.assignmentRevision) || item.assignmentRevision < 1) err(`${file}.assignmentRevision: expected integer >= 1`);
  if (typeof item.safeParallel !== 'boolean') err(`${file}.safeParallel: expected boolean`);
  if (!isIsoDate(item.createdAt)) err(`${file}.createdAt: invalid date-time`);
  if (!isIsoDate(item.updatedAt)) err(`${file}.updatedAt: invalid date-time`);
  if (item.completedAt !== undefined && item.completedAt !== null && !isIsoDate(item.completedAt)) err(`${file}.completedAt: invalid date-time`);
  if ((item.status === 'queued' || item.status === 'needs_planning' || item.status === 'needs_review') && item.assignedLane !== null) {
    err(`${file}: ${item.status} item must not have assignedLane`);
  }
  if (terminalStatuses.has(item.status) && item.completedAt === null) {
    err(`${file}.completedAt: terminal item requires completedAt`);
  }

  const current = control.requirements;
  const source = item.sourceRequirements;
  const sourceMatches = isObject(source) && isObject(current) &&
    source.path === current.path && source.revisionType === current.revisionType && source.revision === current.revision;
  if (!terminalStatuses.has(item.status) && item.status !== 'needs_reconcile' && !sourceMatches) {
    err(`${file}: active item sourceRequirements does not match current control requirements; use needs_reconcile`);
  }
}

function validateLane(lane, file, expectedLane, control, items) {
  if (!isObject(lane)) {
    err(`${file}: expected object`);
    return;
  }
  if (lane.schemaVersion !== 1) err(`${file}.schemaVersion: expected 1`);
  if (lane.repository !== control.repository) err(`${file}.repository: must match control repository`);
  if (lane.lane !== expectedLane) err(`${file}.lane: expected ${expectedLane}`);
  if (!laneStates.has(lane.state)) err(`${file}.state: invalid value`);
  if (!(lane.currentTaskId === null || (typeof lane.currentTaskId === 'string' && taskIdPattern.test(lane.currentTaskId)))) {
    err(`${file}.currentTaskId: expected taskId|null`);
  }
  if (!Number.isInteger(lane.assignmentRevision) || lane.assignmentRevision < 1) err(`${file}.assignmentRevision: expected integer >= 1`);
  if (!isIsoDate(lane.updatedAt)) err(`${file}.updatedAt: invalid date-time`);

  if ((lane.state === 'idle' || lane.state === 'waiting') && lane.currentTaskId !== null) {
    err(`${file}: ${lane.state} lane must not have currentTaskId`);
  }
  if (!['idle', 'waiting'].includes(lane.state) && lane.currentTaskId === null) {
    err(`${file}: ${lane.state} lane requires currentTaskId`);
  }
  if (lane.currentTaskId !== null) {
    const item = items.get(lane.currentTaskId);
    if (!item) {
      err(`${file}: currentTaskId ${lane.currentTaskId} does not exist`);
    } else {
      if (item.assignedLane !== expectedLane) err(`${file}: referenced item assignedLane mismatch`);
      if (!activeAssignmentStatuses.has(item.status)) err(`${file}: referenced item is not in active assignment state`);
      if (item.assignmentRevision !== lane.assignmentRevision) err(`${file}: assignmentRevision mismatch with item`);
    }
  }
}

function detectDependencyCycles(items, queueLabel) {
  const visiting = new Set();
  const visited = new Set();

  function visit(taskId, trail) {
    if (visiting.has(taskId)) {
      err(`${queueLabel}: dependency cycle ${[...trail, taskId].join(' -> ')}`);
      return;
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const item = items.get(taskId);
    if (item && Array.isArray(item.dependencies)) {
      for (const dep of item.dependencies) visit(dep, [...trail, taskId]);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const taskId of items.keys()) visit(taskId, []);
}

if (!fs.existsSync(root)) {
  console.log(`No work queue root at ${root}; nothing to validate.`);
  process.exit(0);
}

const queueDirs = fs.readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'));

let queueCount = 0;
let itemCount = 0;

for (const entry of queueDirs) {
  const queueDir = path.join(root, entry.name);
  const controlFile = path.join(queueDir, 'control.json');
  if (!fs.existsSync(controlFile)) {
    err(`${queueDir}: missing control.json`);
    continue;
  }
  const control = readJson(controlFile);
  if (!control || !validateControl(control, controlFile)) continue;
  queueCount += 1;

  if (typeof control.repository === 'string') {
    const expectedDir = control.repository.replace('/', '--');
    if (entry.name !== expectedDir) err(`${queueDir}: directory must be ${expectedDir}`);
  }

  const items = new Map();
  const itemsDir = path.join(queueDir, 'items');
  if (fs.existsSync(itemsDir)) {
    for (const itemEntry of fs.readdirSync(itemsDir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json'))) {
      const file = path.join(itemsDir, itemEntry.name);
      const item = readJson(file);
      if (!item) continue;
      validateItem(item, file, control);
      if (items.has(item.taskId)) err(`${queueDir}: duplicate taskId ${item.taskId}`);
      items.set(item.taskId, item);
      itemCount += 1;
    }
  }

  for (const item of items.values()) {
    if (!Array.isArray(item.dependencies)) continue;
    const seenDeps = new Set();
    for (const dep of item.dependencies) {
      if (dep === item.taskId) err(`${queueDir}/${item.taskId}: task cannot depend on itself`);
      if (seenDeps.has(dep)) err(`${queueDir}/${item.taskId}: duplicate dependency ${dep}`);
      seenDeps.add(dep);
      if (!items.has(dep)) err(`${queueDir}/${item.taskId}: dependency ${dep} does not exist`);
    }
  }
  detectDependencyCycles(items, queueDir);

  const lanesDir = path.join(queueDir, 'lanes');
  const currentTaskIds = new Set();
  for (const laneName of control.workerLanes ?? []) {
    const file = path.join(lanesDir, `${laneName}.json`);
    if (!fs.existsSync(file)) {
      err(`${queueDir}: missing lane file ${laneName}.json`);
      continue;
    }
    const lane = readJson(file);
    if (!lane) continue;
    validateLane(lane, file, laneName, control, items);
    if (lane.currentTaskId) {
      if (currentTaskIds.has(lane.currentTaskId)) err(`${queueDir}: task ${lane.currentTaskId} assigned to multiple lanes`);
      currentTaskIds.add(lane.currentTaskId);
    }
  }

  for (const item of items.values()) {
    if (activeAssignmentStatuses.has(item.status) && item.assignedLane) {
      const laneFile = path.join(lanesDir, `${item.assignedLane}.json`);
      if (fs.existsSync(laneFile)) {
        const lane = readJson(laneFile);
        if (lane && lane.currentTaskId !== item.taskId) err(`${queueDir}/${item.taskId}: assignedLane does not point back to task`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Work queue validation failed with ${errors.length} error(s):`);
  for (const message of errors) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Validated ${queueCount} work queue(s), ${itemCount} item(s).`);
