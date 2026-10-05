import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// On Windows, starting a program by bare name (`git`, `cmd`, `explorer.exe`)
// looks in the current directory before PATH, both in cmd.exe and in Node's
// own spawn. Zerostel runs inside projects it doesn't trust, so a `git.exe`
// or `claude.cmd` dropped into a repo would run instead of the real one.
// Every program Zerostel starts goes through here: absolute PATH entries
// only, never the current directory.

const cache = new Map<string, string | null>();

function isProgram(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    // like the shell, skip files on PATH that can't be run
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of `name` from absolute PATH entries, or null. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, cwd = process.cwd()): string | null {
  const key = `${platform}\0${name}\0${env.PATH ?? ''}\0${cwd}`;
  if (cache.has(key)) return cache.get(key)!;
  // on Windows "\dir" counts as absolute to Node but depends on the current drive
  const full = (d: string) => (platform === 'win32' ? /^([A-Za-z]:[\\/]|\\\\)/.test(d) : path.isAbsolute(d));
  // `npx` and `npm run` put the project's node_modules/.bin first on PATH, and
  // any folder inside the current project is the project's to fill: skip both.
  // (Unless we're in the home folder or a drive root, where everything is "inside".)
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const here = path.resolve(cwd);
  const broad = here === path.parse(here).root || fold(here) === fold(path.resolve(os.homedir()));
  const inside = (d: string) => {
    const rel = path.relative(fold(here), fold(path.resolve(d)));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const dirs = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((d) => d && full(d) && !/[\\/]node_modules([\\/]|$)/i.test(d) && (broad || !inside(d)));
  const exts = platform === 'win32' && !path.extname(name) ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  let found: string | null = null;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isProgram(candidate, platform)) {
        found = candidate;
        break outer;
      }
    }
  }
  cache.set(key, found);
  return found;
}

/** Environment for child processes: on Windows, no current-directory lookup either. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return process.platform === 'win32' ? { ...env, NoDefaultCurrentDirectoryInExePath: '1' } : env;
}

/** cmd.exe by absolute path. */
export function comspec(): string {
  const fromEnv = process.env.ComSpec;
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
}

/**
 * A directory that is safe to run helper programs from: never the project,
 * and on Linux and macOS not the shared /tmp either (anyone can write there).
 */
export function neutralCwd(): string {
  return process.platform === 'win32' ? os.tmpdir() : os.homedir();
}

export function isBatch(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

/**
 * Run a program found on PATH (never in the current folder) from a neutral
 * folder. Batch shims, common for npm-installed tools on Windows, go through
 * cmd.exe by absolute path; their arguments must be plain words.
 */
export function runTool(cmd: string, args: string[], timeoutMs = 10_000): { status: number | null; stdout: string; stderr: string } | null {
  const exe = findExecutable(cmd);
  if (!exe) return null;
  // no %: cmd expands %NAME% wherever it appears
  if (isBatch(exe) && args.some((a) => !/^[\w@+=:,./-]+$/.test(a))) return null;
  const opts = { encoding: 'utf8' as const, timeout: timeoutMs, windowsHide: true, cwd: neutralCwd(), env: childEnv(), maxBuffer: 32 * 1024 * 1024 };
  const r = isBatch(exe)
    ? spawnSync(comspec(), ['/d', '/s', '/c', `""${exe}" ${args.join(' ')}"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(exe, args, opts);
  if (r.error) return null;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
