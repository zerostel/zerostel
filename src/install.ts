import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, type Adapter, type RenderInput } from './agents/adapters.js';
import { childEnv, comspec, findExecutable, neutralCwd } from './util/exec.js';
import { ensurePrivateDir, shellPath, type Ctx } from './util/paths.js';
import { STANDALONE } from './version.js';

export function binPath(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'bin', 'zerostel.mjs');
}

/** Where the standalone executable copies itself. */
export function exePath(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'bin', ctx.platform === 'win32' ? 'zerostel.exe' : 'zerostel');
}

/** What a hook runs: Node with the copied bundle, or the standalone executable on its own. */
export interface Launch {
  exe: string;
  args: string[];
}

export function launch(ctx: Ctx, node = process.execPath, standalone = STANDALONE): Launch {
  return standalone ? { exe: exePath(ctx), args: [] } : { exe: node, args: [binPath(ctx)] };
}

function shimPath(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'bin', 'zerostel-hook.cmd');
}

/**
 * Copy the running bundle (or the standalone executable) to ~/.zerostel/bin
 * so hooks keep working after an npx cache cleanup or a global uninstall,
 * and start fast.
 */
export function installBin(ctx: Ctx, opts: { source?: string; node?: string; standalone?: boolean } = {}): string {
  if (opts.standalone ?? STANDALONE) {
    const dest = exePath(ctx);
    ensurePrivateDir(ctx.dataDir, ctx.platform);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    replaceExecutable(opts.source ?? process.execPath, dest);
    // the shim names the executable next to it: nothing is looked up on PATH
    if (ctx.platform === 'win32') fs.writeFileSync(shimPath(ctx), `@echo off\r\n"%~dp0${path.basename(dest)}" hook %*\r\n`);
    return dest;
  }
  const src = opts.source ?? fileURLToPath(import.meta.url);
  if (!/\.(m?js)$/.test(src)) throw new Error(`can't install from ${src}; run the built CLI (npm run build) instead`);
  const dest = binPath(ctx);
  ensurePrivateDir(ctx.dataDir, ctx.platform);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  if (ctx.platform === 'win32') {
    const node = opts.node ?? process.execPath;
    fs.writeFileSync(shimPath(ctx), `@echo off\r\n"${node}" "%~dp0zerostel.mjs" hook %*\r\n`);
  }
  return dest;
}

// A hook may be running the old executable right now, and Windows won't
// overwrite a running program. It does let one be renamed, so the old copy
// moves aside and goes away on a later install.
function replaceExecutable(src: string, dest: string): void {
  if (path.resolve(src) === path.resolve(dest)) return;
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  for (const old of fs.readdirSync(dir).filter((n) => n.startsWith(base + '.old-'))) {
    try {
      fs.rmSync(path.join(dir, old), { force: true });
    } catch {
      // still running; next time
    }
  }
  // an unguessable name, created exclusively below
  const tmp = `${dest}.new-${crypto.randomBytes(8).toString('hex')}`;
  fs.rmSync(tmp, { force: true });
  fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(tmp, 0o755);
  if (fs.existsSync(dest)) {
    try {
      fs.rmSync(dest);
    } catch {
      fs.renameSync(dest, `${dest}.old-${Date.now()}`);
    }
  }
  fs.renameSync(tmp, dest);
}

// a path that needs no quoting in bash, PowerShell or cmd (a ~ inside a
// path, as in an 8.3 name like RUNNER~1, is plain text to all three)
const SAFE_PATH = /^[\w@%+=:,./\\~-]+$/;

// cmd.exe chokes on quoted paths in some positions, so on Windows we hand
// cmd-based agents a path without spaces or quotes (the 8.3 short name if needed).
function noSpaces(p: string): string {
  if (SAFE_PATH.test(p)) return p;
  const r = spawnSync(comspec(), ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, cwd: neutralCwd(), env: childEnv() });
  const short = r.stdout?.trim().split(/\r?\n/).pop();
  // only a real short name will do: for a file that isn't there, cmd prints junk
  return short && SAFE_PATH.test(short) && /^[A-Za-z]:[\\/]/.test(short) ? short : `"${p}"`;
}

export interface HookEntry {
  type: 'command';
  command: string;
  args?: string[];
  timeout?: number;
}


// Single quotes: $, backticks and double quotes in a path stay literal in sh.
export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Plain paths stay bare: some agents split hook commands on spaces instead of
// using a shell, and quotes would then end up inside the arguments.
export function shArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : shQuote(s);
}

// PowerShell single-quoted strings only escape ' (as '').
export function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** The command an agent should run, written the way it runs commands on this OS. */
export function hookEntry(ctx: Ctx, a: Adapter, node = process.execPath, event?: string, l: Launch = launch(ctx, node)): HookEntry {
  const extra = a.eventArg && event ? [event] : [];
  const tail = ['hook', a.id, ...extra].join(' ');
  const argv = [l.exe, ...l.args];
  if (ctx.platform !== 'win32') return { type: 'command', command: `${argv.map(shArg).join(' ')} ${tail}` };
  switch (a.windowsRunner) {
    case 'exec':
      return { type: 'command', command: shellPath(l.exe), args: [...l.args.map(shellPath), 'hook', a.id, ...extra] };
    case 'cmd':
      return { type: 'command', command: [shellPath(noSpaces(shimPath(ctx))), a.id, ...extra].join(' ') };
    case 'shim': {
      const shim = shellPath(noSpaces(shimPath(ctx)));
      if (SAFE_PATH.test(shim)) return { type: 'command', command: [shim, a.id, ...extra].join(' ') };
      // no short name to be had: exec form still works for the agent itself
      return { type: 'command', command: shellPath(l.exe), args: [...l.args.map(shellPath), 'hook', a.id, ...extra] };
    }
    case 'powershell':
      return { type: 'command', command: `& ${argv.map(psQuote).join(' ')} ${tail}` };
  }
}

type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Config = { hooks?: Record<string, unknown[]>; disableAllHooks?: boolean; [k: string]: unknown };

// Antigravity's hooks file is keyed by hook-group name
const GROUP = 'zerostel';

function readJson(file: string): Config {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  let cfg: unknown;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}); fix it first, Zerostel won't overwrite it`);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file} is not a JSON object; Zerostel won't overwrite it`);
  return cfg as Config;
}

function isOurs(h: unknown, a: Adapter): boolean {
  if (!h || typeof h !== 'object') return false;
  const e = h as HookEntry;
  const line = [e.command, ...(Array.isArray(e.args) ? e.args : [])].join(' ').trim();
  if (!line.includes('zerostel')) return false;
  return line.endsWith(` ${a.id}`) || (!!a.eventArg && new RegExp(` ${a.id} \\w+$`).test(line));
}

/** Every hook entry in the file, whatever the layout. */
function entries(cfg: Config, a: Adapter): unknown[] {
  const lists = a.layout === 'group' ? Object.values((cfg[GROUP] ?? {}) as Record<string, unknown>) : Object.values(cfg.hooks ?? {});
  const out: unknown[] = [];
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const group = item as HookGroup;
      if (group && Array.isArray(group.hooks)) out.push(...group.hooks);
      else out.push(item);
    }
  }
  return out;
}

function stripOurs(cfg: Config, a: Adapter): Config {
  if (a.layout === 'group') {
    delete cfg[GROUP];
    return cfg;
  }
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return cfg;
  for (const [event, list] of Object.entries(cfg.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept =
      a.layout === 'flat'
        ? list.filter((h) => !isOurs(h, a))
        : list.map((g) => ({ ...(g as HookGroup), hooks: ((g as HookGroup).hooks ?? []).filter((h) => !isOurs(h, a)) })).filter((g) => g.hooks.length);
    if (kept.length) cfg.hooks[event] = kept;
    else delete cfg.hooks[event];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return cfg;
}

export interface InstallPlan {
  agent: string;
  name: string;
  file: string;
  before: string;
  after: string;
  warnings: string[];
  /** the file is Zerostel's own and should be deleted rather than rewritten */
  remove?: boolean;
  /** a second file Zerostel owns (a plugin the config points to); empty content removes it */
  companion?: { file: string; content: string };
}

// Zerostel's lines in a text file it shares with the user (layout 'block')
const BLOCK_BEGIN = '# >>> zerostel: added by `zerostel install`, removed by `zerostel uninstall`';
const BLOCK_END = '# <<< zerostel';

function hasBlock(text: string): boolean {
  return text.split(/\r?\n/).some((l) => l.trimEnd() === BLOCK_BEGIN);
}

/** The file without Zerostel's block. Refuses a YAML file that isn't a list, which a block can't be appended to. */
function withoutBlock(text: string, file: string): string {
  const out: string[] = [];
  let inside = false;
  let blocks = 0;
  // only Zerostel's own marker lines, exactly, mark its block: a comment that
  // merely looks similar is the user's and stays
  for (const line of text.split(/\r?\n/)) {
    const l = line.trimEnd();
    if (l === BLOCK_BEGIN) {
      if (inside || ++blocks > 1) throw new Error(`${file} has more than one Zerostel block; fix it first, Zerostel won't guess which lines are its own.`);
      inside = true;
    } else if (inside && l === BLOCK_END) inside = false;
    else if (!inside) out.push(line);
  }
  // a start without an end would take the rest of the user's file with it
  if (inside) throw new Error(`${file} has Zerostel's start marker without its "${BLOCK_END}"; fix it first, Zerostel won't guess where its lines end.`);
  const kept = out.join('\n').replace(/\s+$/, '');
  const first = kept.split('\n').find((l) => l.trim() && !l.trimStart().startsWith('#'));
  if (first !== undefined && !first.startsWith('-')) throw new Error(`${file} is not a YAML list of patch steps; Zerostel won't edit it. Add its lines yourself (zerostel install --dry-run shows them).`);
  return kept;
}

// a path into ~/.zerostel/bin as a hooks file has it (JSON doubles backslashes)
const OUR_BIN = /[\\/]bin[\\/]+zerostel(?:\.mjs|\.exe)?\b/;

function renderInput(a: Adapter, l: Launch): RenderInput {
  const argv = [l.exe, ...l.args];
  const tail = (event?: string) => ['hook', a.id, ...(a.eventArg && event ? [event] : [])].join(' ');
  return {
    argv,
    unix: (event) => `${argv.map(shArg).join(' ')} ${tail(event)}`,
    powershell: (event) => `& ${argv.map(psQuote).join(' ')} ${tail(event)}`,
  };
}

export function planInstall(ctx: Ctx, a: Adapter, entryFor: HookEntry | ((event: string) => HookEntry) = (event) => hookEntry(ctx, a, process.execPath, event), node = process.execPath, l: Launch = launch(ctx, node)): InstallPlan {
  const file = a.configFile(ctx);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const base = { agent: a.id, name: a.name, file, before, warnings: [] as string[] };
  if (a.layout === 'owned') return { ...base, after: a.render!(renderInput(a, l)) };
  if (a.layout === 'block') {
    const kept = withoutBlock(before, file);
    const after = `${kept ? kept + '\n\n' : ''}${BLOCK_BEGIN}\n${a.block!(ctx).replace(/\s+$/, '')}\n${BLOCK_END}\n`;
    const companion = a.companion ? { file: a.companion.file(ctx), content: a.companion.render(renderInput(a, l)) } : undefined;
    return { ...base, after, companion };
  }

  const entry = (event: string): HookEntry => (typeof entryFor === 'function' ? entryFor(event) : entryFor);
  const cfg: Config = { ...(before.trim() ? {} : a.scaffold), ...stripOurs(readJson(file), a) };
  if (cfg.disableAllHooks) base.warnings.push(`"disableAllHooks" is true in ${file}, so hooks (and Zerostel) will not run.`);
  const lists: Record<string, unknown[]> = a.layout === 'group' ? {} : (cfg.hooks ??= {});
  for (const { event, matcher, timeout } of a.events) {
    const hook: HookEntry = { ...entry(event), timeout };
    const flat = a.layout === 'flat' || a.flatEvents?.includes(event);
    const item = flat ? hook : { ...(matcher ? { matcher } : {}), hooks: [hook] };
    lists[event] = [...(lists[event] ?? []), item];
  }
  if (a.layout === 'group') cfg[GROUP] = { enabled: true, ...lists };
  return { ...base, after: JSON.stringify(cfg, null, 2) + '\n' };
}

export function planUninstall(ctx: Ctx, a: Adapter): InstallPlan {
  const file = a.configFile(ctx);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const base = { agent: a.id, name: a.name, file, before, warnings: [] };
  if (a.layout === 'block') {
    const companion = a.companion ? { file: a.companion.file(ctx), content: '' } : undefined;
    if (!hasBlock(before)) return { ...base, after: before, companion };
    const kept = withoutBlock(before, file);
    // a file that held nothing but Zerostel's block goes away with it
    return { ...base, after: kept ? kept + '\n' : '', remove: !kept, companion };
  }
  if (a.layout === 'owned') {
    // only delete the file if Zerostel wrote it: it runs one of the copies in ~/.zerostel/bin
    const ours = OUR_BIN.test(before) && before.includes(a.id);
    if (before && !ours) return { ...base, after: before, warnings: [`${file} was not written by Zerostel; left it alone.`] };
    return { ...base, after: '', remove: !!before };
  }
  const after = before ? JSON.stringify(stripOurs(readJson(file), a), null, 2) + '\n' : '';
  return { ...base, after };
}

export function applyPlan(plan: InstallPlan): string | null {
  // the companion goes in before the file that points to it, and out after
  const companion = plan.companion;
  if (companion?.content) writeOwned(companion.file, companion.content);
  try {
    return applyMain(plan);
  } finally {
    if (companion && !companion.content) fs.rmSync(companion.file, { force: true });
  }
}

function writeOwned(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.zerostel.tmp';
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function applyMain(plan: InstallPlan): string | null {
  if (plan.remove) {
    fs.rmSync(plan.file, { force: true });
    return null;
  }
  if (plan.before === plan.after) return null;
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  let backup: string | null = null;
  let mode: number | undefined;
  if (plan.before) {
    // the backup and the rewritten file are never more readable than the original
    mode = fs.statSync(plan.file).mode & 0o777;
    // keep the first backup: it's the file as it was before Zerostel touched it
    backup = plan.file + '.zerostel.bak';
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, plan.before, { mode, flag: 'wx' });
  }
  const tmp = plan.file + '.zerostel.tmp';
  // a leftover tmp file would keep its old permissions; start fresh
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, plan.after, mode !== undefined ? { mode, flag: 'wx' } : { flag: 'wx' });
  fs.renameSync(tmp, plan.file);
  return backup;
}

/** Whether the agent looks installed on this machine (its config folder exists). */
export function agentPresent(ctx: Ctx, a: Adapter): boolean {
  if (a.cli && !findExecutable(a.cli)) return false;
  // for files Zerostel owns, look one level up: ~/.copilot rather than ~/.copilot/hooks
  const dir = path.dirname(a.configFile(ctx));
  return fs.existsSync(a.layout === 'owned' ? path.dirname(dir) : dir);
}

/** Agents `zerostel install` sets up when none is named. */
export function defaultAgents(ctx: Ctx): Adapter[] {
  const found = ADAPTERS.filter((a) => !a.experimental && agentPresent(ctx, a));
  return found.length ? found : ADAPTERS.filter((a) => a.id === 'claude-code');
}

export interface HookStatus {
  installed: boolean;
  healthy: boolean; // the hook points at files that exist
  disabled: boolean;
  command?: string;
}

export function hookStatus(ctx: Ctx, a: Adapter): HookStatus {
  const file = a.configFile(ctx);
  const copied = fs.existsSync(binPath(ctx)) || fs.existsSync(exePath(ctx));
  if (a.layout === 'block') {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // no file, no block
    }
    const installed = hasBlock(text);
    const healthy = installed && copied && (!a.companion || fs.existsSync(a.companion.file(ctx)));
    return { installed, healthy, disabled: false, command: installed ? file : undefined };
  }
  if (a.layout === 'owned') {
    const installed = fs.existsSync(file);
    return { installed, healthy: installed && copied, disabled: false, command: installed ? file : undefined };
  }
  let cfg: Config = {};
  try {
    cfg = readJson(file);
  } catch {
    // unreadable config counts as not installed
  }
  const entry = entries(cfg, a).find((h) => isOurs(h, a)) as HookEntry | undefined;
  let healthy = false;
  if (entry) {
    const exe = entry.args ? entry.command : (/^(?:& )?(['"])(.+?)\1/.exec(entry.command)?.[2] ?? entry.command.split(' ')[0]!);
    healthy = copied && fs.existsSync(exe);
  }
  const disabled = !!cfg.disableAllHooks || (a.layout === 'group' && (cfg[GROUP] as { enabled?: boolean } | undefined)?.enabled === false);
  return { installed: !!entry, healthy, disabled, command: entry ? [entry.command, ...(entry.args ?? [])].join(' ') : undefined };
}
