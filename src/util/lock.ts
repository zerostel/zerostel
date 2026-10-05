import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

// A lock whose owner is still running is never taken over, however old: a
// prune or a big rewind can hold one for minutes, and breaking in would put
// two writers on one snapshot store. Past this, the pid has most likely been
// reused by an unrelated program.
const OWNER_MAX_MS = 30 * 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // there but not ours to signal still means there
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a lock file was left behind: its owner has exited, or it is too old to trust. */
function abandoned(text: string, ageMs: number, staleMs: number): boolean {
  const [pid, host] = text.split(' ');
  const n = Number(pid);
  // only a pid from this machine says anything (a container sharing the folder has its own)
  if (!Number.isInteger(n) || n <= 0 || host !== os.hostname()) return ageMs > staleMs;
  if (n === process.pid) return false;
  return !alive(n) || ageMs > OWNER_MAX_MS;
}

/**
 * Cross-process lock using an exclusive lock file. Agents often run tools in
 * parallel, and each hook is its own process, so snapshots have to queue.
 * The file names its owner, so one left by a killed process is cleared at
 * once instead of blocking every hook until it times out.
 */
export function withLock<T>(file: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const timeout = opts.timeoutMs ?? 20_000;
  const stale = opts.staleMs ?? 60_000;
  const start = Date.now();
  const token = `${process.pid} ${os.hostname()} ${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | null = null;
  let denied = 0;
  while (fd === null) {
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw e;
      let st: fs.Stats | null = null;
      let text = '';
      try {
        st = fs.statSync(file);
        text = fs.readFileSync(file, 'utf8');
      } catch {
        // gone, or being deleted
      }
      // Windows reports a lock file that is being deleted as EPERM or EACCES,
      // which clears in moments; with no file there at all, the folder can't be written
      if (code !== 'EEXIST' && !st && ++denied > 20) throw new Error(`can't create ${file} (${code}): is the folder writable?`);
      const left = !!st && abandoned(text, Date.now() - st.mtimeMs, stale);
      if (left) {
        try {
          // only if it is still the same file: another waiter may have cleared it and taken the lock already
          const again = fs.statSync(file);
          if (again.mtimeMs === st!.mtimeMs && fs.readFileSync(file, 'utf8') === text) fs.rmSync(file, { force: true });
        } catch {
          // someone else removed it first
        }
      }
      if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${file}`);
      sleepSync(left ? 5 : 25 + Math.random() * 50);
    }
  }
  try {
    fs.writeSync(fd, token);
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      // leave it if it isn't ours any more
      if (fs.readFileSync(file, 'utf8') === token) fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
  }
}
