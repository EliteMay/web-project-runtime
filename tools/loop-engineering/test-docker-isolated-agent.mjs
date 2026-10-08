import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDockerIsolatedImplement, buildDockerWorkerArgs } from './docker-isolated-agent.mjs';

const imageId = 'sha256:' + 'a'.repeat(64);
const fixtureName = 'loop-sandbox-' + 'a'.repeat(8) + '-' + 'b'.repeat(4) + '-4ccc-8ddd-' + 'e'.repeat(12);
const args = buildDockerWorkerArgs({
  root: '/tmp/disposable-project', imageId, name: fixtureName, entrypoint: '/bin/sh',
  args: ['-c', 'echo fixture'], uid: 1000, gid: 1000
});
for (const flag of [
  '--network=none', '--read-only', '--cap-drop=ALL',
  '--security-opt=no-new-privileges=true', '--pids-limit=32',
  '--memory=256m', '--memory-swap=256m', '--pull=never',
  '--mount=type=bind,src=/tmp/disposable-project,dst=/workspace,rw'
]) assert.ok(args.includes(flag), 'missing container boundary: ' + flag);
assert.ok(!args.some(x => x.includes('/var/run/docker.sock') && x.startsWith('--mount')));
assert.ok(!args.includes('--privileged'));
assert.ok(!args.includes('--pid=host'));
assert.ok(!args.includes('--network=host'));

assert.throws(() => buildDockerWorkerArgs({
  root: '/tmp', imageId: 'alpine:latest', name: fixtureName,
  entrypoint: '/bin/sh', args: [], uid: 1000, gid: 1000
}), /INVALID_OPERATOR_CONFIG/);

if (process.platform !== 'linux') {
  assert.throws(() => createDockerIsolatedImplement({}), /LINUX_ONLY/);
  console.log('Loop Engineering Docker policy unit tests passed (non-Linux).');
} else {
  assert.throws(() => createDockerIsolatedImplement({
    dockerExecutable: '/bin/false', imageId: 'alpine:latest', entrypoint: '/bin/sh'
  }), /INVALID_OPERATOR_CONFIG/);
  const realDocker = process.env.LOOP_TEST_DOCKER_PATH;
  const realImage = process.env.LOOP_TEST_DOCKER_IMAGE_ID;
  if (!realDocker || !realImage) {
    console.log('Loop Engineering Docker policy unit tests passed (integration NOT_RUN).');
  } else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-docker-integration-'));
    const outside = path.join(path.dirname(root), path.basename(root) + '-protected.txt');
    const policy = {
      autonomyLevel: 'L1_WORKTREE',
      permissions: { externalNetwork: false, secretAccess: false, defaultBranchWrite: false,
        merge: false, deploy: false },
      scope: { workingBranchPolicy: 'isolated_worktree', allowedPaths: ['result.txt'],
        protectedPaths: ['tests/**'] }
    };
    const context = { worktreeDir: root,
      task: {taskId: 'task-alpha', title: 'sandbox integration',
        scope: 'write result', completionCriteria: ['result exists']},
      attempt: 1, policy
    };
    try {
      fs.writeFileSync(outside, 'do-not-change\n');
      const script = [
        'cat >/workspace/result.txt || exit 10',
        'if echo escaped >/etc/loop-pilot-leak 2>/dev/null; then exit 11; fi',
        'if test -e /host-should-not-exist; then exit 12; fi',
        "if grep -q 'eth0:' /proc/net/dev; then exit 13; fi",
        'echo CONFINED >>/workspace/result.txt'
      ].join('\n');
      const execute = createDockerIsolatedImplement({
        dockerExecutable: realDocker, imageId: realImage,
        entrypoint: '/bin/sh', args: ['-c', script], timeoutMs: 9_000
      });
      await execute(context);
      const actual = fs.readFileSync(path.join(root, 'result.txt'), 'utf8');
      assert.ok(actual.includes('"taskId":"task-alpha"'));
      assert.ok(actual.includes('CONFINED'));
      assert.equal(fs.readFileSync(outside, 'utf8'), 'do-not-change\n');

      await assert.rejects(execute({
        ...context, policy: {...policy, permissions: {...policy.permissions, externalNetwork: true}}
      }), /UNSAFE_POLICY/);

      const marker = path.join(root, 'heartbeat.txt');
      const runaway = createDockerIsolatedImplement({
        dockerExecutable: realDocker, imageId: realImage,
        entrypoint: '/bin/sh', args: ['-c',
          'while true; do date +%s%N > /workspace/heartbeat.txt; sleep 0.1; done'],
        timeoutMs: 2300
      });
      await assert.rejects(runaway(context), /LOOP_DOCKER_TIMEOUT/);
      assert.equal(fs.existsSync(marker), true);
      const earlier = fs.readFileSync(marker, 'utf8');
      await new Promise(resolve => setTimeout(resolve, 450));
      const later = fs.readFileSync(marker, 'utf8');
      assert.equal(later, earlier, 'container daemon kept writing after its timeout');

      console.log('Loop Engineering Linux real Docker sandbox S14 test passed.');
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
      fs.rmSync(outside, {force: true});
    }
  }
}
