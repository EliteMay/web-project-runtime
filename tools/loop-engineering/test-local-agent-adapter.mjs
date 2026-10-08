import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentImplement } from './local-agent-adapter.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-adapter-'));
const worktreeDir = path.join(temp, 'worktree');
fs.mkdirSync(worktreeDir);
const context = {
  worktreeDir,
  task: {
    taskId: 'task-alpha',
    title: 'Write a bounded fixture',
    scope: 'src/hello.txt',
    completionCriteria: ['result exists']
  },
  attempt: 1,
  strategy: 'initial-implementation',
  policy: {
    permissions: {
      secretAccess: false,
      defaultBranchWrite: false,
      merge: false,
      deploy: false
    },
    scope: { allowedPaths: ['src/**'], protectedPaths: ['tests/acceptance/**'] }
  }
};
const node = process.execPath;
const runner = (code, extras = {}) => createLocalAgentImplement({
  executable: node, args: ['-e', code], timeoutMs: 4_000,
  testOnlyAllowUnconfined: true, ...extras
});

try {
  assert.throws(() => createLocalAgentImplement({ executable: 'node' }), /absolute path/);
  assert.throws(() => createLocalAgentImplement({ executable: node, timeoutMs: 0 }), /positive/);
  assert.throws(() => createLocalAgentImplement({ executable: node }), /LOCAL_AGENT_OS_SANDBOX_REQUIRED/);

  // Simulate a real external coding worker using stdin rather than a callback
  // that directly writes files inside the loop controller.
  const script = `
    let message = '';
    process.stdin.on('data', part => message += part);
    process.stdin.on('end', () => {
      const request = JSON.parse(message);
      if (request.task.taskId !== 'task-alpha' || process.env.LOCAL_AGENT_TEST_SECRET) process.exit(3);
      require('node:fs').mkdirSync('src', { recursive: true });
      require('node:fs').writeFileSync('src/hello.txt', request.strategy);
    });
  `;
  process.env.LOCAL_AGENT_TEST_SECRET = 'do-not-forward';
  const response = await runner(script)(context);
  assert.deepEqual(response, {}); // No fabricated token or cost measurement.
  assert.equal(fs.readFileSync(path.join(worktreeDir, 'src', 'hello.txt'), 'utf8'), context.strategy);
  delete process.env.LOCAL_AGENT_TEST_SECRET;

  await assert.rejects(runner('process.exit(7)')(context), /LOCAL_AGENT_NONZERO_EXIT/);
  await assert.rejects(
    runner('process.stdout.write("x".repeat(2048))', { maxOutputBytes: 128 })(context),
    // A short-lived worker can disappear before Windows taskkill verifies cleanup.
    // The adapter must fail closed rather than silently report successful termination.
    /LOCAL_AGENT_(OUTPUT_LIMIT|TREE_KILL_UNVERIFIED)/
  );
  await assert.rejects(
    runner('setTimeout(() => {}, 3000)', { timeoutMs: 30 })(context),
    /LOCAL_AGENT_TIMEOUT/
  );
  await assert.rejects(
    runner(script, { maxInputBytes: 5 })(context),
    /LOCAL_AGENT_INPUT_LIMIT/
  );
  await assert.rejects(runner(script)({
    ...context, policy: { ...context.policy, permissions: { ...context.policy.permissions, merge: true } }
  }), /restricted worktree-only/);

  const workerControlledExecutable = path.join(worktreeDir, 'unsafe-runner.js');
  fs.writeFileSync(workerControlledExecutable, 'process.exit(0)');
  await assert.rejects(
    createLocalAgentImplement({ executable: workerControlledExecutable,
      testOnlyAllowUnconfined: true })(context),
    /worker-editable tree/
  );
} finally {
  delete process.env.LOCAL_AGENT_TEST_SECRET;
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('Loop Engineering local agent adapter tests passed.');
