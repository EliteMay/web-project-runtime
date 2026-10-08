import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalAgentImplement } from './local-agent-adapter.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-tree-termination-'));
const marker = path.join(root, 'grandchild-pulse.txt');
const context = {
  worktreeDir: root,
  task: { taskId: 'task-alpha', title: 'Deliberate process hang',
    scope: 'src/fixture', completionCriteria: ['stop descendants'] },
  attempt: 1,
  policy: { permissions: { secretAccess: false, defaultBranchWrite: false,
    merge: false, deploy: false }, scope: {
    allowedPaths: ['src/**'], protectedPaths: ['tests/**']
  } }
};

// This is a real process-tree test, not a mocked kill function. The child of
// the worker pulses a marker every 50 ms, then the worker deliberately hangs.
const pulseCode = `
  const fs = require('node:fs');
  fs.writeFileSync(${JSON.stringify(marker)}, 'begin');
  setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 50);
`;
const parentCode = `
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['-e', ${JSON.stringify(pulseCode)}], {
    stdio: 'ignore', windowsHide: true
  });
  setInterval(() => {}, 1000);
`;

try {
  const agent = createLocalAgentImplement({
    executable: process.execPath, args: ['-e', parentCode],
    timeoutMs: 1400, maxOutputBytes: 8192
  });
  await assert.rejects(agent(context), /LOCAL_AGENT_TIMEOUT/);
  assert.equal(fs.existsSync(marker), true, 'grandchild must have run before timeout');
  // A surviving grandchild would continue to change the marker file.
  await delay(200);
  const first = fs.readFileSync(marker, 'utf8');
  await delay(350);
  const second = fs.readFileSync(marker, 'utf8');
  assert.equal(second, first, 'grandchild kept running after its parent timed out');
  console.log('Loop Engineering process-tree timeout test passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
