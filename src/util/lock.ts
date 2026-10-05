import fs from 'node:fs';
import path from 'node:path';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/**
 * Cross-process lock using an exclusive lock file. Agents often run tools in
 * parallel, and each hook is its own process, so snapshots have to queue.
 */
export function withLock<T>(file: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const timeout = opts.timeoutMs ?? 20_000;
  const stale = opts.staleMs ?? 60_000;
  const start = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
    } catch (e) {
      // Windows reports a lock file that is being deleted as EPERM or EACCES: just busy
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw e;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > stale) fs.rmSync(file, { force: true });
      } catch {
        // someone else removed it first
      }
      if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${file}`);
      sleepSync(25 + Math.random() * 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // removed by someone who thought it was stale; nothing left to do
    }
  }
}
