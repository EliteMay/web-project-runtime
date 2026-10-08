import path from 'node:path';
import { spawn } from 'node:child_process';

// Best-effort process-tree containment. POSIX group signalling and Windows
// taskkill /T are NOT OS sandboxes, and cannot stop deliberately detached or
// orphaned descendants in every scenario. A real unattended coding agent
// requires an independently enforced cgroup/Job Object/container supervisor.
export async function terminateProcessTree(child, { cleanupTimeoutMs = 6_000 } = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error('LOCAL_AGENT_TREE_KILL_UNVERIFIED');
  }
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new Error('LOCAL_AGENT_TREE_KILL_UNVERIFIED');
  }

  if (process.platform !== 'win32') {
    try {
      // Spawned with detached:true so pid is the dedicated process-group id.
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
      throw new Error('LOCAL_AGENT_TREE_KILL_UNVERIFIED');
    }
    // We know the signal was delivered to the process group, not that every
    // possible descendant was contained by it.
    return;
  }

  // Use the system copy, never a PATH-controlled taskkill or a shell command.
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    child.kill('SIGKILL');
    throw new Error('LOCAL_AGENT_TREE_KILL_UNVERIFIED');
  }
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  await new Promise((resolve, reject) => {
    let done = false;
    const cleaner = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, shell: false,
      env: { SystemRoot: systemRoot },
      stdio: 'ignore'
    });
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ok) resolve();
      else {
        child.kill('SIGKILL');
        reject(new Error('LOCAL_AGENT_TREE_KILL_UNVERIFIED'));
      }
    };
    const timer = setTimeout(() => {
      cleaner.kill();
      finish(false);
    }, cleanupTimeoutMs);
    cleaner.on('error', () => finish(false));
    cleaner.on('close', code => finish(code === 0));
  });
}
