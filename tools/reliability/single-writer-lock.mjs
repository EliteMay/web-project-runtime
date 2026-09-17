import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

function runGit(repoDir, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }
  return result;
}

function resolveGitCommonDir(repoDir) {
  const root = runGit(repoDir, ['rev-parse', '--show-toplevel']).stdout.trim();
  const raw = runGit(repoDir, ['rev-parse', '--git-common-dir']).stdout.trim();
  return path.resolve(root, raw);
}

function processAppearsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function staleArchivePath(lockPath) {
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return `${lockPath}.stale-${suffix}`;
}

export class RepositoryWriterLockError extends Error {
  constructor(message, { lockPath, existing = null } = {}) {
    super(message);
    this.name = 'RepositoryWriterLockError';
    this.code = 'repository-writer-locked';
    this.lockPath = lockPath;
    this.existing = existing;
  }
}

export function getRepositoryWriterLockPath(repoDir) {
  return path.join(resolveGitCommonDir(repoDir), 'development-reliability.transaction.lock');
}

export function acquireRepositoryWriterLock(repoDir, {
  transactionId,
  branch = 'main',
  baseCommit = null,
} = {}) {
  if (typeof transactionId !== 'string' || transactionId.trim() === '') {
    throw new Error('transactionId is required to acquire the repository writer lock.');
  }

  const lockPath = getRepositoryWriterLockPath(repoDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const holderId = crypto.randomUUID();
      const record = {
        schemaVersion: 1,
        holderId,
        transactionId,
        branch,
        baseCommit,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.closeSync(fd);

      let released = false;
      return {
        lockPath,
        holderId,
        record,
        update(patch = {}) {
          if (released) throw new Error('Cannot update a released repository writer lock.');
          const current = readLock(lockPath);
          if (!current || current.holderId !== holderId) {
            throw new RepositoryWriterLockError('Repository writer lock ownership changed unexpectedly.', { lockPath, existing: current });
          }
          const next = { ...current, ...patch, holderId };
          fs.writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
          return next;
        },
        release() {
          if (released) return false;
          const current = readLock(lockPath);
          if (current?.holderId === holderId) fs.rmSync(lockPath, { force: true });
          released = true;
          return true;
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLock(lockPath);
      if (existing && processAppearsAlive(existing.pid)) {
        throw new RepositoryWriterLockError('Another local repository writer appears to be active.', { lockPath, existing });
      }
      if (attempt > 0) {
        throw new RepositoryWriterLockError('Could not replace a stale repository writer lock safely.', { lockPath, existing });
      }
      const archive = staleArchivePath(lockPath);
      try {
        fs.renameSync(lockPath, archive);
      } catch (renameError) {
        if (renameError?.code === 'ENOENT') continue;
        throw new RepositoryWriterLockError('Stale repository writer lock could not be archived safely.', { lockPath, existing });
      }
    }
  }

  throw new RepositoryWriterLockError('Repository writer lock could not be acquired.', { lockPath });
}
