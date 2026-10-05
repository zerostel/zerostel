import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, runTool } from '../util/exec.js';
import type { Ctx } from '../util/paths.js';

// The parts of the machine outside any project that a shell command can
// change for good: global packages, and on Windows the user's environment
// variables (they live in the registry, not in a file `watch` could cover).
// Zerostel looks at them only around commands that look like they change
// them. Tests get a fake; a fake home folder gets none, so tests never reach
// the real machine.

export type Manager = 'npm' | 'pip' | 'brew';

export interface EnvValue {
  type: string; // REG_SZ, REG_EXPAND_SZ
  value: string;
}

export interface UserEnv {
  read(): Record<string, EnvValue> | null;
  set(name: string, v: EnvValue): void;
  remove(name: string): void;
}

export interface SystemProbe {
  /** a manager's global packages, name -> version; null when it can't be read */
  packages(manager: Manager): Record<string, string> | null;
  /** Windows only */
  userEnv?: UserEnv;
}

/** What was read before a command ran, to compare with afterwards. */
export interface SysCapture {
  packages?: Partial<Record<Manager, Record<string, string>>>;
  env?: Record<string, EnvValue>;
}

/** Read what `command` might change. Undefined when it touches nothing Zerostel watches. */
export function captureBefore(ctx: Ctx, command: string): SysCapture | undefined {
  const probe = systemOf(ctx);
  if (!probe || !command) return undefined;
  const cap: SysCapture = {};
  for (const m of managersTouched(command)) {
    const list = probe.packages(m);
    if (list) (cap.packages ??= {})[m] = list;
  }
  if (ctx.platform === 'win32' && probe.userEnv && touchesUserEnv(command)) cap.env = probe.userEnv.read() ?? undefined;
  return cap.packages || cap.env ? cap : undefined;
}

/** Read the same things again and say what changed. */
export function captureAfter(ctx: Ctx, before: SysCapture): { packages: { manager: Manager; change: PackageChange }[]; env: EnvChange[] } {
  const probe = systemOf(ctx);
  const out = { packages: [] as { manager: Manager; change: PackageChange }[], env: [] as EnvChange[] };
  if (!probe) return out;
  for (const [m, list] of Object.entries(before.packages ?? {}) as [Manager, Record<string, string>][]) {
    const now = probe.packages(m);
    const change = now && diffPackages(list, now);
    if (change) out.packages.push({ manager: m, change });
  }
  if (before.env && probe.userEnv) {
    const now = probe.userEnv.read();
    if (now) out.env = diffEnv(before.env, now);
  }
  return out;
}

/** Which managers a shell command could change. */
export function managersTouched(command: string): Manager[] {
  const out: Manager[] = [];
  if (/\bnpm(?:\.cmd)?\s(?:[^|;&]*\s)?(?:i|install|add|uninstall|un|remove|rm|r|update|up|upgrade|link|ln)\b[^|;&]*\s(?:-g|--global)\b/i.test(command) || /\bnpm(?:\.cmd)?\s+(?:-g|--global)\s/i.test(command)) out.push('npm');
  if (/\b(?:pip3?|python3?\s+-m\s+pip|py\s+-m\s+pip)\s+(?:install|uninstall)\b/i.test(command)) out.push('pip');
  if (/\bbrew\s+(?:install|uninstall|remove|rm|upgrade|reinstall)\b/i.test(command)) out.push('brew');
  return out;
}

/** Whether a shell command could change the Windows user environment. */
export function touchesUserEnv(command: string): boolean {
  return /\bsetx\b|\breg(?:\.exe)?\s+(?:add|delete|import)\b[^|;&]*environment|SetEnvironmentVariable|Set-ItemProperty[^|;&]*Environment|Remove-ItemProperty[^|;&]*Environment/i.test(command);
}

function npmList(): Record<string, string> | null {
  const r = runTool('npm', ['ls', '-g', '--depth=0', '--json'], 20_000);
  if (!r?.stdout) return null;
  try {
    const deps = (JSON.parse(r.stdout) as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {};
    return Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, v.version ?? '?']));
  } catch {
    return null;
  }
}

function pipList(): Record<string, string> | null {
  const cmd = findExecutable('pip3') ? 'pip3' : 'pip';
  const r = runTool(cmd, ['list', '--format=json', '--disable-pip-version-check'], 20_000);
  if (!r || r.status !== 0) return null;
  try {
    return Object.fromEntries((JSON.parse(r.stdout) as { name: string; version: string }[]).map((p) => [p.name, p.version]));
  } catch {
    return null;
  }
}

function brewList(): Record<string, string> | null {
  const r = runTool('brew', ['list', '--versions'], 20_000);
  if (!r || r.status !== 0) return null;
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const [name, ...versions] = line.trim().split(/\s+/);
    if (name) out[name] = versions.join(' ');
  }
  return out;
}

const KEY = 'HKCU\\Environment';

const HEX_TYPES: Record<string, string> = { '0': 'REG_NONE', '1': 'REG_SZ', '2': 'REG_EXPAND_SZ', '3': 'REG_BINARY', '4': 'REG_DWORD', '7': 'REG_MULTI_SZ', b: 'REG_QWORD' };

/**
 * Values from a `reg export` file. The file is UTF-16, so every character
 * comes through exactly; `reg query` output goes through the console code
 * page instead, which turns a Chinese folder name in PATH into question
 * marks. Types other than plain and expandable strings keep their raw bytes
 * as hex: enough to notice a change, never written back.
 */
export function parseRegExport(text: string): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {};
  const src = text.replace(/^﻿/, '').replace(/,\\\r?\n[ \t]*/g, ',');
  const unescape = (x: string) => x.replace(/\\([\s\S])/g, '$1');
  const re = /^"((?:[^"\\]|\\[\s\S])*)"=(?:"((?:[^"\\]|\\[\s\S])*)"|dword:([0-9a-f]{8})|hex(?:\(([0-9a-f]+)\))?:([0-9a-f,]*))\r?$/gim;
  for (const m of src.matchAll(re)) {
    const name = unescape(m[1]!);
    if (m[2] !== undefined) out[name] = { type: 'REG_SZ', value: unescape(m[2]) };
    else if (m[3] !== undefined) out[name] = { type: 'REG_DWORD', value: `0x${m[3].toLowerCase()}` };
    else {
      const kind = (m[4] ?? '3').toLowerCase().replace(/^0+(?=.)/, '');
      const type = HEX_TYPES[kind] ?? `REG_TYPE_${kind}`;
      const hex = (m[5] ?? '').toLowerCase();
      if (type === 'REG_SZ' || type === 'REG_EXPAND_SZ') out[name] = { type, value: Buffer.from(hex.replace(/,/g, ''), 'hex').toString('utf16le').replace(/\0+$/, '') };
      else out[name] = { type, value: hex };
    }
  }
  return out;
}

// reg.exe by absolute path; arguments go straight to it, never through a shell
const regEnv: UserEnv = {
  read() {
    let dir: string | null = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerostel-env-'));
      const file = path.join(dir, 'env.reg');
      const r = runTool('reg', ['export', KEY, file, '/y']);
      if (!r || r.status !== 0) return null;
      return parseRegExport(fs.readFileSync(file).toString('utf16le'));
    } catch {
      return null;
    } finally {
      // the values can hold secrets; don't leave a copy behind
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  set(name, v) {
    checkWritable(name, v);
    const r = runTool('reg', ['add', KEY, '/v', name, '/t', v.type, '/d', v.value, '/f']);
    if (!r || r.status !== 0) throw new Error(`couldn't set ${name}: ${r?.stderr.trim() || 'reg.exe failed'}`);
  },
  remove(name) {
    const r = runTool('reg', ['delete', KEY, '/v', name, '/f']);
    if (!r || r.status !== 0) throw new Error(`couldn't remove ${name}: ${r?.stderr.trim() || 'reg.exe failed'}`);
  },
};

/**
 * Only plain and expandable strings are put back, and only intact ones.
 * Versions before 0.1.3 read values through the console code page, so a
 * recorded value can hold U+FFFD where a character was lost; writing that
 * back would break the variable for good.
 */
export function checkWritable(name: string, v: EnvValue): void {
  if (v.type !== 'REG_SZ' && v.type !== 'REG_EXPAND_SZ') throw new Error(`left ${name} alone: it was a ${v.type} value, which Zerostel doesn't write back; set it by hand`);
  if (v.value.includes('�') || v.value.includes('\0')) throw new Error(`left ${name} alone: the recorded value is damaged, so writing it back would break it; set it by hand`);
}

const REAL: SystemProbe = {
  packages: (m) => (m === 'npm' ? npmList() : m === 'pip' ? pipList() : brewList()),
  userEnv: process.platform === 'win32' ? regEnv : undefined,
};

/** The machine to look at: the real one, a test's fake, or none (null) for a fake home folder. */
export function systemOf(ctx: Ctx): SystemProbe | null {
  return ctx.system === undefined ? REAL : ctx.system;
}

export interface PackageChange {
  added: Record<string, string>;
  removed: Record<string, string>;
  changed: Record<string, { from: string; to: string }>;
}

export function diffPackages(before: Record<string, string>, after: Record<string, string>): PackageChange | null {
  const res: PackageChange = { added: {}, removed: {}, changed: {} };
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) res.added[k] = v;
    else if (before[k] !== v) res.changed[k] = { from: before[k]!, to: v };
  }
  for (const [k, v] of Object.entries(before)) if (!(k in after)) res.removed[k] = v;
  return Object.keys(res.added).length + Object.keys(res.removed).length + Object.keys(res.changed).length ? res : null;
}

/** Commands that would undo a change, newest first. Shown, never run. */
export function undoCommands(manager: Manager, c: PackageChange): string[] {
  const at = (name: string, v: string) => (manager === 'pip' ? `${name}==${v}` : manager === 'npm' ? `${name}@${v}` : name);
  const install = manager === 'npm' ? 'npm install -g' : manager === 'pip' ? 'pip install' : 'brew install';
  const remove = manager === 'npm' ? 'npm uninstall -g' : manager === 'pip' ? 'pip uninstall -y' : 'brew uninstall';
  const out: string[] = [];
  if (Object.keys(c.added).length) out.push(`${remove} ${Object.keys(c.added).join(' ')}`);
  const back = [...Object.entries(c.removed).map(([k, v]) => at(k, v)), ...Object.entries(c.changed).map(([k, v]) => at(k, v.from))];
  if (back.length) out.push(`${install} ${back.join(' ')}`);
  return out;
}

export interface EnvChange {
  name: string;
  from?: EnvValue;
  to?: EnvValue;
}

export function diffEnv(before: Record<string, EnvValue>, after: Record<string, EnvValue>): EnvChange[] {
  const out: EnvChange[] = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    const a = before[name];
    const b = after[name];
    if (a?.type === b?.type && a?.value === b?.value) continue;
    out.push({ name, from: a, to: b });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
