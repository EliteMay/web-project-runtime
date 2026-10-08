import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from './process-tree-stop.mjs';

// A deliberately opt-in, provider-neutral bridge. This does NOT provide an
// OS sandbox, network restriction, credential isolation or trusted metering.
// Run only an operator-approved executable under a separate restricted OS user
// or sandbox. Do not expose this factory to an untrusted task or model.
export function createLocalAgentImplement({
  executable,
  args = [],
  timeoutMs = 90_000,
  maxOutputBytes = 65_536,
  maxInputBytes = 32_768
} = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw new Error('Local agent executable must be an operator-selected absolute path.');
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new Error('Local agent arguments must be fixed strings.');
  }
  if (![timeoutMs, maxOutputBytes, maxInputBytes].every(x => Number.isSafeInteger(x) && x > 0)) {
    throw new Error('Local agent budgets must be positive safe integers.');
  }
  const executablePath = fs.realpathSync.native(executable);
  if (!fs.statSync(executablePath).isFile()) throw new Error('Local agent executable must be a file.');

  return async function implement({ worktreeDir, task, policy, attempt, strategy = 'initial-implementation' }) {
    const root = fs.realpathSync.native(worktreeDir);
    const relativeExecutable = path.relative(root, executablePath);
    if (relativeExecutable === '' || (!relativeExecutable.startsWith('..' + path.sep) &&
        relativeExecutable !== '..' && !path.isAbsolute(relativeExecutable))) {
      throw new Error('Local agent executable cannot reside in the worker-editable tree.');
    }
    if (!policy || policy.permissions?.secretAccess !== false ||
        policy.permissions?.defaultBranchWrite !== false ||
        policy.permissions?.merge !== false || policy.permissions?.deploy !== false) {
      throw new Error('Local agent requires a restricted worktree-only policy.');
    }
    const input = JSON.stringify({
      schemaVersion: 1,
      task: {
        taskId: task.taskId,
        title: task.title,
        scope: task.scope,
        completionCriteria: task.completionCriteria
      },
      strategy,
      attempt,
      allowedPaths: policy.scope?.allowedPaths ?? [],
      protectedPaths: policy.scope?.protectedPaths ?? []
    });
    if (Buffer.byteLength(input, 'utf8') > maxInputBytes) {
      throw new Error('LOCAL_AGENT_INPUT_LIMIT');
    }

    // No inherited API keys, tokens, proxy credentials, or arbitrary ambient env.
    // The executable must be configured outside this runtime and must not infer
    // any permission from the fact it was launched successfully.
    const env = process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot } : {};
    await new Promise((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      let stopReason = null;
      let termination = Promise.resolve();
      const child = spawn(executablePath, args, {
        cwd: root, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX processes need a private group for group-level termination.
        detached: process.platform !== 'win32'
      });
      const requestStop = reason => {
        if (settled || stopReason) return;
        stopReason = reason;
        termination = terminateProcessTree(child);
      };
      const timer = setTimeout(() => requestStop('LOCAL_AGENT_TIMEOUT'), timeoutMs);
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const countOutput = chunk => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) requestStop('LOCAL_AGENT_OUTPUT_LIMIT');
      };
      child.stdout.on('data', countOutput);
      child.stderr.on('data', countOutput);
      child.stdin.on('error', () => {}); // Child may terminate before reading input.
      child.on('error', () => finish(new Error('LOCAL_AGENT_START_FAILED')));
      child.on('close', async code => {
        try {
          await termination;
          if (stopReason) return finish(new Error(stopReason));
          if (code !== 0) return finish(new Error('LOCAL_AGENT_NONZERO_EXIT'));
          finish(null);
        } catch {
          // An unverified cleanup is more important than the original timeout.
          finish(new Error('LOCAL_AGENT_TREE_KILL_UNVERIFIED'));
        }
      });
      child.stdin.end(input);
    });

    // Never trust the worker's stdout as proof of success or as cost metering.
    // Phase B separately enforces allowed-path changes + protected verification.
    // Finite model / API budgets require trusted external usage evidence.
    return {};
  };
}
