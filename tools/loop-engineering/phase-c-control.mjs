import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from './json-schema-lite.mjs';

const controlSchemaPath = path.resolve(import.meta.dirname, '../../schemas/loop-engineering/phase-c-control.schema.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

export function requestPhaseCControl({
  runDir,
  loopId,
  repository,
  action,
  reason = null,
  now = new Date().toISOString()
}) {
  if (!runDir) throw new Error('runDir is required.');
  const stateFile = path.join(path.resolve(runDir), 'state.json');
  if (fs.existsSync(stateFile)) {
    const state = readJson(stateFile);
    if (state.loopId !== loopId || state.repository !== repository) {
      throw new Error('Control target does not match the existing Phase C state.');
    }
  }

  const control = {
    schemaVersion: 1,
    loopId,
    repository,
    requestedAction: action,
    requestedAt: now,
    reason: reason == null ? null : String(reason)
  };
  const schema = readJson(controlSchemaPath);
  const validation = validateJsonSchema(control, schema);
  if (!validation.valid) {
    const error = new Error(`Phase C control validation failed with ${validation.errors.length} error(s).`);
    error.code = 'INVALID_PHASE_C_CONTROL';
    error.validationErrors = validation.errors;
    throw error;
  }
  const file = path.join(path.resolve(runDir), 'control.json');
  writeJsonAtomic(file, control);
  return { control, controlPath: file };
}

function runCli() {
  const [runDir, loopId, repository, action, ...reasonParts] = process.argv.slice(2);
  if (!runDir || !loopId || !repository || !action) {
    console.error('Usage: node tools/loop-engineering/phase-c-control.mjs <run-dir> <loop-id> <owner/repo> <run|pause|cancel> [reason]');
    process.exit(2);
  }
  try {
    const result = requestPhaseCControl({
      runDir,
      loopId,
      repository,
      action,
      reason: reasonParts.length > 0 ? reasonParts.join(' ') : null
    });
    console.log(`${result.control.requestedAction} requested for ${result.control.loopId}.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) runCli();
