import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { openProject, unsafeRoot } from '../store/project.js';
import { append, newId, now, SESSION_VERSION, sessionRef } from '../store/session.js';
import { changes, snapshot } from '../store/shadow.js';
import { childEnv } from '../util/exec.js';
import type { Ctx } from '../util/paths.js';

const IGNORE = /(^|[\\/])(\.git|node_modules|\.venv|venv|__pycache__|\.next|\.turbo|\.cache)([\\/]|$)/;

function quoteForCmd(a: string): string {
  return /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

/**
 * Run any command (an agent CLI, a script) and snapshot the project whenever
 * files settle. Works for agents that have no hooks.
 */
export async function runWrapped(argv: string[], ctx: Ctx, opts: { debounceMs?: number; onSession?: (id: string) => void } = {}): Promise<number> {
  const p = openProject(ctx.cwd, ctx);
  const why = unsafeRoot(p.root, ctx);
  if (why) throw new Error(`refusing to snapshot ${why}; cd into a project first`);
  const id = newId();
  const ref = sessionRef(p, 'run', id);
  opts.onSession?.(id);
  const command = argv.join(' ');
  append(ref, { e: 'start', v: SESSION_VERSION, ts: now(), agent: 'run', session: id, cwd: ctx.cwd, command });
  let last = snapshot(p, `before ${command}`).sha;
  append(ref, { e: 'snapshot', ts: now(), id: newId(), snap: last, message: `Start: ${command}` });

  const checkpoint = () => {
    try {
      const s = snapshot(p, 'change').sha;
      if (s === last) return;
      const files = changes(p, last, s);
      append(ref, { e: 'change', ts: now(), id: newId(), from: last, to: s, files });
      last = s;
    } catch {
      // a file was mid-write; the next change event will catch up
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(checkpoint, opts.debounceMs ?? 1500);
  };
  let watcher: fs.FSWatcher | null = null;
  let poll: NodeJS.Timeout | null = null;
  // recursive watching can fail outright, or later when Linux runs out of
  // inotify watches; either way fall back to checking every few seconds
  const fallBack = () => {
    watcher?.close();
    watcher = null;
    poll ??= setInterval(checkpoint, 5000);
  };
  try {
    watcher = fs.watch(p.root, { recursive: true }, (_ev, file) => {
      if (file && IGNORE.test(String(file))) return;
      schedule();
    });
    watcher.on('error', fallBack);
  } catch {
    fallBack();
  }

  const win = process.platform === 'win32';
  const child = spawn(win ? argv.map(quoteForCmd).join(' ') : argv[0]!, win ? [] : argv.slice(1), {
    stdio: 'inherit',
    cwd: ctx.cwd,
    // cmd.exe would otherwise run a same-named program from the project folder first
    env: childEnv(),
    shell: win,
  });
  const onSig = () => {
    // the child gets Ctrl+C too; we just wait for it to exit
  };
  process.on('SIGINT', onSig);

  const code: number = await new Promise((resolve) => {
    child.on('error', (e) => {
      process.stderr.write(`zerostel: could not start ${argv[0]}: ${e.message}\n`);
      resolve(127);
    });
    child.on('exit', (c, sig) => resolve(c ?? (sig ? 1 : 0)));
  });

  process.off('SIGINT', onSig);
  watcher?.close();
  if (poll) clearInterval(poll);
  if (timer) clearTimeout(timer);
  checkpoint();
  append(ref, { e: 'end', ts: now(), exit: code });
  return code;
}
