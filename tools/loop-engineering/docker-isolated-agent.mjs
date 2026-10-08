import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Linux-only and opt-in. A trusted Docker daemon MUST be local; the worker
// does not get its socket, credentials, host env, host PID or host network.
// An explicit, locally present immutable image ID is required. No pulls.
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const DOCKER_SOCKET = 'unix:///var/run/docker.sock';
const NONSECRET_ENV = { DOCKER_CONFIG: '/tmp/loop-docker-empty-config' };

function fixedDockerPath(executable, worktree) {
  if (!path.isAbsolute(executable)) throw new Error('LOOP_DOCKER_ABSOLUTE_PATH_REQUIRED');
  const real = fs.realpathSync.native(executable);
  if (!fs.statSync(real).isFile()) throw new Error('LOOP_DOCKER_NOT_A_FILE');
  const rel = path.relative(worktree, real);
  if (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) {
    throw new Error('LOOP_DOCKER_BINARY_WORKER_CONTROLLED');
  }
  return real;
}

function commandExit(binary, args, timeoutMs = 5000) {
  const result = spawnSync(binary, ['--host', DOCKER_SOCKET, ...args], {
    encoding: 'utf8',
    env: NONSECRET_ENV,
    timeout: timeoutMs,
    maxBuffer: 8192
  });
  return result;
}

function ensureLocalDaemon(binary, imageId) {
  const daemon = commandExit(binary, ['info', '--format', '{{.OSType}}']);
  if (daemon.status !== 0 || daemon.stdout.trim() !== 'linux') {
    throw new Error('LOOP_DOCKER_LOCAL_LINUX_DAEMON_REQUIRED');
  }
  const actual = commandExit(binary, ['image', 'inspect', '--format', '{{.Id}}', imageId]);
  if (actual.status !== 0 || actual.stdout.trim() !== imageId) {
    throw new Error('LOOP_DOCKER_IMAGE_NOT_PINNED_LOCAL');
  }
}

export function buildDockerWorkerArgs({
  root, imageId, name, entrypoint, args, uid, gid,
  maxMemory = '256m', pidsLimit = 32
}) {
  if (!path.isAbsolute(root) || !IMAGE_ID.test(imageId) ||
      !/^loop-sandbox-[a-f0-9-]{36}$/.test(name) ||
      typeof entrypoint !== 'string' || !entrypoint.startsWith('/') ||
      !Array.isArray(args) || args.some(a => typeof a !== 'string') ||
      !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0 ||
      !['128m', '256m', '512m'].includes(maxMemory) ||
      !Number.isInteger(pidsLimit) || pidsLimit < 4 || pidsLimit > 128) {
    throw new Error('LOOP_DOCKER_INVALID_OPERATOR_CONFIG');
  }
  return [
    '--host', DOCKER_SOCKET, 'run', '--rm', '--pull=never', '--interactive',
    '--name', name,
    '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
    '--pids-limit=' + pidsLimit, '--memory=' + maxMemory, '--memory-swap=' + maxMemory,
    '--cpus=1', '--user=' + uid + ':' + gid,
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m',
    '--mount=type=bind,src=' + root + ',dst=/workspace',
    '--workdir=/workspace', '--env=HOME=/tmp', '--env=TMPDIR=/tmp',
    '--entrypoint', entrypoint, imageId, ...args
  ];
}

function cleanupContainer(binary, name) {
  // Removal is not verified merely because inspect fails: the daemon
  // itself may be unavailable, so check its availability separately.
  commandExit(binary, ['kill', name], 5000);
  commandExit(binary, ['rm', '--force', name], 5000);
  const daemon = commandExit(binary, ['info', '--format', '{{.OSType}}'], 5000);
  if (daemon.status !== 0 || daemon.stdout.trim() !== 'linux') return false;

  const list = commandExit(binary, [
    'ps', '--all', '--format', '{{.Names}}', '--filter', 'name=' + name
  ], 5000);
  if (list.status !== 0 || list.error) return false;

  const inspect = commandExit(binary, [
    'container', 'inspect', '--format', '{{.Id}}', name
  ], 5000);
  if (inspect.error || inspect.status === 0) return false;
  return !list.stdout.split(/\r?\n/).includes(name);
}

export function createDockerIsolatedImplement({
  dockerExecutable, imageId, entrypoint, args = [],
  timeoutMs = 60_000, maxOutputBytes = 65536,
  maxMemory = '256m', pidsLimit = 32
} = {}) {
  if (process.platform !== 'linux') throw new Error('LOOP_DOCKER_LINUX_ONLY');
  if (!IMAGE_ID.test(imageId) || typeof entrypoint !== 'string' || !entrypoint.startsWith('/') ||
      !Array.isArray(args) || args.some(x => typeof x !== 'string') ||
      ![timeoutMs, maxOutputBytes].every(x => Number.isSafeInteger(x) && x > 0)) {
    throw new Error('LOOP_DOCKER_INVALID_OPERATOR_CONFIG');
  }
  if (typeof process.getuid !== 'function' || process.getuid() === 0 ||
      typeof process.getgid !== 'function' || process.getgid() === 0) {
    throw new Error('LOOP_DOCKER_NONROOT_OPERATOR_REQUIRED');
  }
  // These are operator-selected, constant inputs, never worker-provided.
  const docker = fixedDockerPath(dockerExecutable, process.cwd());
  ensureLocalDaemon(docker, imageId);

  return async function implement({worktreeDir, task, policy, attempt, strategy = 'initial-implementation'}) {
    const root = fs.realpathSync.native(worktreeDir);
    if (policy?.autonomyLevel !== 'L1_WORKTREE' ||
        policy.permissions?.externalNetwork !== false ||
        policy.permissions?.secretAccess !== false ||
        policy.permissions?.defaultBranchWrite !== false ||
        policy.permissions?.merge !== false ||
        policy.permissions?.deploy !== false ||
        policy.scope?.workingBranchPolicy !== 'isolated_worktree') {
      throw new Error('LOOP_DOCKER_UNSAFE_POLICY');
    }
    if (!task || typeof task.taskId !== 'string') throw new Error('LOOP_DOCKER_TASK_REQUIRED');
    const input = JSON.stringify({
      schemaVersion: 1,
      attempt, strategy,
      task: {taskId: task.taskId, title: task.title,
        scope: task.scope, completionCriteria: task.completionCriteria},
      allowedPaths: policy.scope.allowedPaths,
      protectedPaths: policy.scope.protectedPaths
    });
    if (Buffer.byteLength(input) > 32768) throw new Error('LOOP_DOCKER_INPUT_LIMIT');
    // Avoid mounting a path controlled by a symlink in the parent chain.
    if (path.resolve(worktreeDir) !== root) throw new Error('LOOP_DOCKER_WORKTREE_SYMLINK_DENIED');
    const name = 'loop-sandbox-' + crypto.randomUUID();
    const argv = buildDockerWorkerArgs({
      root, name, imageId, entrypoint, args,
      uid: process.getuid(), gid: process.getgid(), maxMemory, pidsLimit
    });

    await new Promise((resolve, reject) => {
      let complete = false, reason = null, bytes = 0;
      let child;
      const done = error => {
        if (complete) return;
        complete = true;
        clearTimeout(timeout);
        clearTimeout(watchdog);
        if (error) reject(error);
        else resolve();
      };
      const stop = why => {
        if (reason) return;
        reason = why;
        // Destroy the container, not only the Docker CLI process. The daemon
        // owns the process lifetime, including its descendants.
        const clean = cleanupContainer(docker, name);
        if (!clean) {
          child?.kill('SIGKILL');
          done(new Error('LOOP_DOCKER_CLEANUP_UNVERIFIED'));
        } else {
          child?.kill('SIGKILL');
          done(new Error(why));
        }
      };
      child = spawn(docker, argv, {
        cwd: root, env: NONSECRET_ENV,
        stdio: ['pipe', 'pipe', 'pipe'], shell: false
      });
      const timeout = setTimeout(() => stop('LOOP_DOCKER_TIMEOUT'), timeoutMs);
      const watchdog = setTimeout(() => stop('LOOP_DOCKER_WATCHDOG'), timeoutMs + 7000);
      const onData = chunk => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) stop('LOOP_DOCKER_OUTPUT_LIMIT');
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.stdin.on('error', () => {});
      child.on('error', () => stop('LOOP_DOCKER_START_FAILED'));
      child.on('close', code => {
        if (complete) return;
        const clean = cleanupContainer(docker, name);
        if (!clean) return done(new Error('LOOP_DOCKER_CLEANUP_UNVERIFIED'));
        if (reason) return done(new Error(reason));
        if (code !== 0) return done(new Error('LOOP_DOCKER_WORKER_FAILED'));
        done(null);
      });
      child.stdin.end(input);
    });
    return {}; // No invented AI tokens or cost: the independent budget gate applies.
  };
}
