import cp from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// On Windows, Node's libuv aborts the whole process (an assertion in its
// UTF-8 to UTF-16 conversion) when a file-system path, a program argument, a
// working folder or an environment value holds U+10FFFF. An abort can't be
// caught: a tool call naming such a path, or a file named that way in a
// repository, would stop a hook dead, and with it every guardrail for that
// call. So on Windows the file-system and process functions refuse such a
// string with an ordinary error, which their callers already handle.

export const UNPASSABLE = String.fromCodePoint(0x10ffff);
const UNPASSABLE_UTF8 = Buffer.from(UNPASSABLE, 'utf8');

export function holdsUnpassable(v: unknown): boolean {
  if (typeof v === 'string') return v.includes(UNPASSABLE);
  if (v instanceof URL) return decodeURIComponent(v.href).includes(UNPASSABLE);
  if (Buffer.isBuffer(v)) return v.includes(UNPASSABLE_UTF8);
  return false;
}

function refusal(name: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`${name}: a path or argument holds U+10FFFF, which Node can't pass to Windows`);
  e.code = 'EINVAL';
  return e;
}

type AnyFn = ((...args: unknown[]) => unknown) & Record<string | symbol, unknown>;
const GUARDED = Symbol.for('zerostel.winPaths');

// file functions whose second argument is a path too; for the rest only the first is
const TWO_PATHS = new Set(['rename', 'copyFile', 'cp', 'link', 'symlink']);
// functions that take a file descriptor and data, not a path
const NO_PATH = /^(f[a-z]|(read|readv|write|writev)(Sync)?$|close)/;

// each function is wrapped once: properties can point back at their own function (a promisified function's promisify.custom is itself)
const wrappedOf = new WeakMap<AnyFn, AnyFn>();

/** `fn`, refusing calls that pass such a string where `check` looks; its properties (realpathSync.native, promisify.custom) come along, guarded too. */
function guarded(fn: AnyFn, label: string, check: (args: unknown[]) => boolean, async: 'throw' | 'callback' | 'reject'): AnyFn {
  if (fn[GUARDED]) return fn;
  const known = wrappedOf.get(fn);
  if (known) return known;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (check(args)) {
      // a path Windows can't be asked about doesn't exist, as far as the caller can tell
      if (label.endsWith('.existsSync')) return false;
      const e = refusal(label);
      if (async === 'reject') return Promise.reject(e);
      const cb = args[args.length - 1];
      if (async === 'callback' && typeof cb === 'function') {
        process.nextTick(() => (cb as AnyFn)(e));
        return undefined;
      }
      throw e;
    }
    return fn.apply(this, args);
  } as AnyFn;
  wrappedOf.set(fn, wrapped);
  for (const key of Reflect.ownKeys(fn)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const v = fn[key];
    wrapped[key] = typeof v === 'function' ? guarded(v as AnyFn, `${label}.${String(key)}`, check, async === 'reject' ? 'reject' : 'throw') : v;
  }
  Object.defineProperty(wrapped, GUARDED, { value: true });
  Object.defineProperty(wrapped, 'name', { value: fn.name });
  return wrapped;
}

function guardFs(mod: Record<string, unknown>, label: string, promises: boolean): void {
  for (const name of Object.keys(mod)) {
    const fn = mod[name];
    if (typeof fn !== 'function' || /^[A-Z]/.test(name) || NO_PATH.test(name)) continue;
    const base = name.replace(/Sync$/, '');
    const check = (args: unknown[]) => holdsUnpassable(args[0]) || (TWO_PATHS.has(base) && holdsUnpassable(args[1]));
    mod[name] = guarded(fn as AnyFn, `${label}.${name}`, check, promises ? 'reject' : name.endsWith('Sync') ? 'throw' : 'callback');
  }
}

function guardProcesses(mod: Record<string, unknown>): void {
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    const check = (args: unknown[]) => {
      const list = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
      const opts = [args[1], args[2]].find((a) => a && typeof a === 'object' && !Array.isArray(a)) as { cwd?: unknown; env?: Record<string, unknown>; argv0?: unknown } | undefined;
      const env = opts?.env ? Object.entries(opts.env).flat() : [];
      return [args[0], ...list, opts?.cwd, opts?.argv0, ...env].some(holdsUnpassable);
    };
    mod[name] = guarded(fn as AnyFn, `child_process.${name}`, check, 'throw');
  }
}

/**
 * Turns the aborts into errors, on Windows only (elsewhere such strings work).
 * `mods` stands in for Node's modules in tests.
 */
export function guardWindowsPaths(platform: NodeJS.Platform, mods: { fs: object; fsp: object; cp: object }): boolean {
  if (platform !== 'win32') return false;
  guardFs(mods.fs as Record<string, unknown>, 'fs', false);
  guardFs(mods.fsp as Record<string, unknown>, 'fs.promises', true);
  guardProcesses(mods.cp as Record<string, unknown>);
  return true;
}

/** The same on Node's own modules; named imports elsewhere (`import { spawn } from ...`) see it too. Call it first thing. */
export function guardThisProcess(): void {
  if (guardWindowsPaths(process.platform, { fs, fsp, cp })) syncBuiltinESMExports();
}
