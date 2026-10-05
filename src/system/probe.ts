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

// reg.exe by absolute path; arguments go straight to it, never through a shell
const regEnv: UserEnv = {
  read() {
    const r = runTool('reg', ['query', KEY]);
    if (!r || r.status !== 0) return null;
    const out: Record<string, EnvValue> = {};
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^ {4}(.+?) {4}(REG_\w+)(?: {4}(.*))?$/.exec(line);
      if (m) out[m[1]!] = { type: m[2]!, value: m[3] ?? '' };
    }
    return out;
  },
  set(name, v) {
    const type = v.type === 'REG_EXPAND_SZ' ? 'REG_EXPAND_SZ' : 'REG_SZ';
    const r = runTool('reg', ['add', KEY, '/v', name, '/t', type, '/d', v.value, '/f']);
    if (!r || r.status !== 0) throw new Error(`couldn't set ${name}: ${r?.stderr.trim() || 'reg.exe failed'}`);
  },
  remove(name) {
    const r = runTool('reg', ['delete', KEY, '/v', name, '/f']);
    if (!r || r.status !== 0) throw new Error(`couldn't remove ${name}: ${r?.stderr.trim() || 'reg.exe failed'}`);
  },
};

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
