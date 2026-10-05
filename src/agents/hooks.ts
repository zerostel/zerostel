import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../detect/secrets.js';
import { evaluate, loadPolicy, withMovedFolders, type Decision } from '../guard/policy.js';
import { hookStatus } from '../install.js';
import { openProject, unsafeRoot, type Project } from '../store/project.js';
import { append, firstLine, newId, now, readState, SESSION_VERSION, sessionRef, writeState, type SessionRef, type SessionState } from '../store/session.js';
import { homeChanges, snapshotHome } from '../store/home.js';
import { captureAfter, captureBefore, undoCommands } from '../system/probe.js';
import { BaselinePending, baselineRunning, changes, maintain, needsBaseline, snapshot, SnapshotSkipped } from '../store/shadow.js';
import { gitVersion } from '../util/git.js';
import { withLock } from '../util/lock.js';
import { displayPath, tilde, type Ctx } from '../util/paths.js';
import { getAdapter, type Adapter, type HookInput } from './adapters.js';

export type { HookInput };

// Tools that never change files. Everything else (shell, edits, MCP tools,
// tools we don't know yet) gets a snapshot before and after.
const READ_ONLY = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead',
  'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'Skill', 'ToolSearch',
  'BashOutput', 'TaskOutput', 'KillShell', 'KillBash', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'SlashCommand',
  'spawn_agent',
]);

export function toolKind(tool: string): string {
  // any spelling: a rule about commands must not miss a shell tool named "bash"
  const t = tool.toLowerCase();
  if (t === 'bash' || t === 'powershell') return 'shell';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'].includes(tool)) return 'edit';
  if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(tool)) return 'read';
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web';
  if (tool === 'Task' || tool === 'Agent' || tool === 'spawn_agent') return 'agent';
  if (tool.startsWith('mcp__')) return 'mcp';
  return 'other';
}

export function changesFiles(tool: string): boolean {
  return !READ_ONLY.has(tool);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** File paths named in an apply_patch body (Codex, and opencode for GPT models), rename targets included. */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^[ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) out.push(m[1]!.trim());
  return out;
}

// Argument names that hold a path, whatever the agent calls them: file_path,
// filePath, AbsolutePath, TargetFile, SearchDirectory, dir_path, paths, cwd...
const PATH_ARG = /(?:path|paths|file|files|filename|dir|directory|folder|target|dest|destination|cwd|workdir)$/;
// Arguments that carry text rather than a location: a path written inside
// them is content (a file that mentions ~/.ssh), not something the tool opens.
const TEXT_ARG = /^(?:content|contents|text|body|newstring|oldstring|newstr|oldstr|patch|diff|command|commands|cmd|script|code|prompt|description|message|query|pattern|regex|replacement|reason|title|summary)$/;

/**
 * A value that is a location however its argument is named (`source`, `uri`,
 * `location`...): absolute, home-relative, explicitly relative, or a file:
 * URL, which is returned as the path it points at.
 */
export function pathShaped(v: string): string | undefined {
  if (v.length > 4096 || /[\r\n]/.test(v)) return undefined;
  const url = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(v);
  if (url) {
    let p: string;
    try {
      p = decodeURIComponent(url[1]!);
    } catch {
      p = url[1]!;
    }
    return /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p;
  }
  return /^(?:~(?:[\\/]|$)|\$HOME\b|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%|[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/i.test(v) ? v : undefined;
}

/**
 * Every path a tool call's arguments name, so a rule sees them however the
 * agent spells the argument, nested ones included (`edits: [{ file_path }]`).
 * `incomplete` says what was too much to look at.
 */
function argPaths(...inputs: (Record<string, unknown> | undefined)[]): { paths: string[]; incomplete?: string } {
  const out = new Set<string>();
  let budget = 10_000;
  let incomplete: string | undefined;
  const visit = (v: unknown, key: 'path' | 'text' | 'other', depth: number): void => {
    if (--budget < 0) {
      incomplete ??= 'arguments too large to look through';
      return;
    }
    if (typeof v === 'string') {
      if (!v) return;
      if (key === 'path') out.add(pathShaped(v) ?? v);
      else if (key === 'other') {
        const p = pathShaped(v);
        if (p) out.add(p);
      }
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (depth > 6) {
      incomplete ??= 'arguments nested too deep';
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      const name = k.toLowerCase().replace(/[_-]/g, '');
      visit(x, PATH_ARG.test(name) ? 'path' : TEXT_ARG.test(name) ? 'text' : 'other', depth + 1);
    }
  };
  for (const ti of inputs) visit(ti ?? {}, 'other', 0);
  return { paths: [...out], incomplete };
}

// Agents often prefix commands with `cd <project> && `, which pushes the
// part that matters out of a one-line summary.
export function stripCd(cmd: string): string {
  return cmd.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
}

export function summarizeTool(tool: string, input: Record<string, unknown>, root: string, home: string): string {
  const rel = (p: unknown) => displayPath(str(p), root, home);
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return '$ ' + firstLine(redact(stripCd(str(input.command))), 160);
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Read':
    case 'Delete':
      return `${tool} ${rel(input.file_path)}`;
    case 'NotebookEdit':
    case 'NotebookRead':
      return `${tool} ${rel(input.notebook_path)}`;
    case 'apply_patch': {
      const files = patchFiles(str(input.command) || str(input.patch));
      return `Patch ${files.length ? files.map(rel).join(', ') : 'files'}`;
    }
    case 'Glob':
      return `Glob ${str(input.pattern)}`;
    case 'Grep':
      return `Grep "${firstLine(str(input.pattern), 60)}"${input.path ? ' in ' + rel(input.path) : ''}`;
    case 'LS':
      return `LS ${rel(input.path)}`;
    case 'WebFetch':
      return `Fetch ${firstLine(redact(str(input.url)), 120)}`;
    case 'WebSearch':
      return `Search "${firstLine(str(input.query), 80)}"`;
    case 'Task':
    case 'Agent':
    case 'spawn_agent':
      return `Subagent: ${firstLine(str(input.description) || str(input.prompt) || str(input.message), 80)}`;
    case 'TodoWrite':
      return 'Update todo list';
  }
  if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__');
    return `MCP ${server} › ${rest.join('__')}`;
  }
  return tool;
}

function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redact(v.length > 4000 ? v.slice(0, 4000) + '…' : v);
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => redactDeep(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v).slice(0, 200)) out[k] = redactDeep(x, depth + 1);
  return out;
}

// Keep stored inputs small: diffs already hold file contents.
function compactInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (['content', 'old_string', 'new_string', 'edits', 'new_source', 'patch'].includes(k)) continue;
    if (tool === 'apply_patch' && k === 'command') continue;
    if (typeof v === 'string') out[k] = redact(v.length > 4000 ? v.slice(0, 4000) + '…' : v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v !== null && v !== undefined) {
      // mask the values, not the JSON text: a masked "token=…" inside a string could break the JSON
      const masked = redactDeep(v);
      const j = JSON.stringify(masked);
      out[k] = j.length > 2000 ? j.slice(0, 2000) + '…' : masked;
    }
  }
  return out;
}

function tail(s: string, max: number): string {
  return s.length > max ? '…' + s.slice(-max) : s;
}

export function summarizeOutput(tool: string, response: unknown): { ok: boolean; output?: string } {
  if (response === undefined || response === null) return { ok: true };
  if (typeof response === 'string') return { ok: true, output: toolKind(tool) === 'read' ? undefined : redact(tail(response, 2000)) };
  const r = response as Record<string, unknown>;
  const failed = r.interrupted === true || r.is_error === true || r.isError === true || r.success === false || (typeof r.exit_code === 'number' && r.exit_code !== 0);
  if (tool === 'Bash' || tool === 'PowerShell') {
    const text = [str(r.stdout), str(r.stderr), str(r.output)].filter(Boolean).join('\n');
    return { ok: !failed, output: text ? redact(tail(text, 2000)) : undefined };
  }
  if (toolKind(tool) === 'read') return { ok: !failed };
  if (typeof r.error === 'string') return { ok: false, output: redact(tail(r.error, 2000)) };
  return { ok: !failed };
}

// ---- token usage from the transcript ----

type TranscriptLine = {
  type?: string;
  requestId?: string;
  message?: { id?: string; model?: string; usage?: Record<string, number> };
  payload?: { type?: string; info?: { total_token_usage?: Record<string, number> } | null; model?: string };
};

/**
 * Reads new lines of the agent's transcript and updates the session's token
 * totals. Claude Code logs usage per assistant message (repeated once per
 * content block, so we dedupe); Codex logs running totals in token_count events.
 */
export function readTranscriptUsage(file: string | null | undefined, st: SessionState): void {
  if (!file || !fs.existsSync(file)) return;
  const size = fs.statSync(file).size;
  if (size < st.transcriptOffset) st.transcriptOffset = 0;
  if (size === st.transcriptOffset) return;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size - st.transcriptOffset, 64 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.transcriptOffset);
    const lastNl = buf.lastIndexOf(10);
    if (lastNl < 0) return;
    const seen = new Set(st.seen);
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line.includes('usage')) continue;
      let o: TranscriptLine;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const total = o.payload?.type === 'token_count' ? o.payload.info?.total_token_usage : undefined;
      if (total) {
        const cached = total.cached_input_tokens ?? 0;
        const written = total.cache_write_input_tokens ?? 0;
        st.usageFound = true;
        st.usage = {
          input: Math.max(0, (total.input_tokens ?? 0) - cached - written),
          output: total.output_tokens ?? 0,
          cacheRead: cached,
          cacheWrite: written,
        };
        continue;
      }
      const u = o.message?.usage;
      if (o.type !== 'assistant' || !u || o.message?.model === '<synthetic>') continue;
      const key = `${o.message?.id ?? ''}:${o.requestId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      st.usageFound = true;
      st.usage.input += u.input_tokens ?? 0;
      st.usage.output += u.output_tokens ?? 0;
      st.usage.cacheRead += u.cache_read_input_tokens ?? 0;
      st.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      if (o.message?.model) st.model = o.message.model;
    }
    st.seen = [...seen].slice(-1000);
    st.transcriptOffset += lastNl + 1;
  } finally {
    fs.closeSync(fd);
  }
}

// ---- the hook ----

function toolId(input: HookInput): string {
  if (input.tool_use_id) return input.tool_use_id;
  const h = crypto.createHash('sha1').update(`${input.tool_name}:${JSON.stringify(input.tool_input ?? {})}`).digest('hex');
  return `t${h.slice(0, 12)}`;
}

interface Env {
  p: Project;
  ref: SessionRef;
  st: SessionState;
  canSnap: boolean;
  ctx: Ctx;
  result: HookResult;
  /** hands a project's first snapshot to a background worker */
  startBaseline?: (root: string) => void;
}

// Watched files outside the project (config.json `watch`) are snapshotted at
// the same moments; a change shows up as its own step.
function snapHome(env: Env): void {
  let h: string | null;
  try {
    h = snapshotHome(env.ctx);
  } catch (e) {
    env.result.problem ??= `watched files: ${(e as Error).message}`;
    return;
  }
  if (!h || h === env.st.lastHome) return;
  let files: ReturnType<typeof homeChanges> = [];
  try {
    if (env.st.lastHome) files = homeChanges(env.ctx, env.st.lastHome, h);
  } catch {
    // an older home snapshot is gone; record the new one without a diff
  }
  append(env.ref, { e: 'home', ts: now(), id: newId(), from: env.st.lastHome, to: h, files });
  env.st.lastHome = h;
}

// A skipped snapshot (project too large, paused) still records the step. A
// first snapshot that didn't finish in time carries on in the background.
// Files git couldn't copy are reported (errors.log, doctor); rewinds leave them alone.
function trySnapshot(p: Project, msg: string, startBaseline?: (root: string) => void, problem?: (m: string) => void): string | undefined {
  try {
    const s = snapshot(p, msg);
    if (s.incomplete) problem?.(`snapshot incomplete, some files keep an older copy: ${s.incomplete}`);
    return s.sha;
  } catch (e) {
    if (e instanceof BaselinePending) {
      if (startBaseline && !baselineRunning(p)) startBaseline(p.root);
      return undefined;
    }
    if (e instanceof SnapshotSkipped) return undefined;
    throw e;
  }
}

function snap(env: Env, msg: string): string | undefined {
  snapHome(env);
  if (!env.canSnap) return undefined;
  const s = trySnapshot(env.p, msg, env.startBaseline, (m) => (env.result.problem ??= m));
  if (!s) return undefined;
  // anything that changed since our last snapshot happened outside the agent
  if (env.st.lastSnap && env.st.lastSnap !== s) {
    const files = changes(env.p, env.st.lastSnap, s);
    if (files.length) append(env.ref, { e: 'outside', ts: now(), id: newId(), from: env.st.lastSnap, to: s, files });
  }
  env.st.lastSnap = s;
  return s;
}

/**
 * The project is where the agent was started, not wherever it has `cd`-ed
 * to since. Claude Code exports that as CLAUDE_PROJECT_DIR.
 */
const PROJECT_DIR_ENV: Record<string, string> = { 'claude-code': 'CLAUDE_PROJECT_DIR', cursor: 'CURSOR_PROJECT_DIR', gemini: 'GEMINI_PROJECT_DIR' };

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function projectDir(adapter: Adapter, input: HookInput, ctx: Ctx): string {
  const name = PROJECT_DIR_ENV[adapter.id];
  const fromEnv = name ? process.env[name] : undefined;
  return fromEnv && fs.existsSync(fromEnv) ? fromEnv : input.cwd || ctx.cwd;
}

export interface HookResult {
  /** a policy rule stopped the tool call or wants the agent to ask first */
  decision?: Decision;
  /** policy.json couldn't be used as written; worth logging */
  policyProblem?: string;
  /** something else went wrong while recording; the decision above still stands */
  problem?: string;
}

/**
 * Check a tool call against ~/.zerostel/policy.json. Errors never block: they're reported instead.
 * `raw` is the arguments as the agent sent them, before they were renamed for the summaries.
 */
function guard(base: Ctx, tool: string, ti: Record<string, unknown>, root: string, cwd: string, raw?: Record<string, unknown>): HookResult {
  const { policy, problem } = loadPolicy(base);
  if (!policy) return { policyProblem: problem };
  try {
    const { paths, incomplete } = argPaths(ti, raw);
    // a patch names its files in its body, whichever tool carries it
    const patch = (tool === 'apply_patch' ? str(ti.command) : '') || str(ti.patch) || str(raw?.patchText) || str(raw?.patch);
    if (patch) paths.push(...patchFiles(patch));
    // matching is linear, and evaluate() caps how much it reads, saying so when it does
    const command = toolKind(tool) === 'shell' ? str(ti.command) : undefined;
    // rules name the usual folders; an environment variable may have moved them
    const moved: [string, string][] = [
      ['~/.zerostel', base.dataDir],
      ['~/.claude', base.claudeDir],
      ['~/.codex', base.codexDir],
      ['~/.copilot', base.copilotDir],
      ['~/.config', base.configHome],
      ['~/.gemini', path.join(base.geminiHome, '.gemini')],
      ['~/.dsh', base.dshHome],
    ];
    const rules = withMovedFolders(policy, moved, base.home);
    return { decision: evaluate(rules, { tool, paths, command, writes: changesFiles(tool), root, cwd, home: base.home, platform: base.platform, incomplete }) ?? undefined, policyProblem: problem };
  } catch (e) {
    return { policyProblem: `policy check failed: ${(e as Error).message}` };
  }
}

// Rules can't stop every way an agent might edit its own hook settings, but
// it can't do it unseen: the hooks it is running stay loaded for the rest of
// the session, so the next call notices and writes it into the log.
function watchHooks(env: Env, adapter: Adapter): void {
  const file = adapter.configFile(env.ctx);
  let sig = 'none';
  try {
    const s = fs.statSync(file);
    sig = `${s.size}:${s.mtimeMs}`;
  } catch {
    // no file: no hooks in it
  }
  const seen = env.st.hooks;
  if (seen?.sig === sig) return;
  const status = hookStatus(env.ctx, adapter);
  const on = status.installed && !status.disabled;
  if (seen?.on && !on) append(env.ref, { e: 'hooks', ts: now(), id: newId(), file: tilde(file, env.ctx.home), change: status.installed ? 'disabled' : 'removed' });
  env.st.hooks = { sig, on };
}

/**
 * Record one hook call. `raw` is the agent's own payload.
 * `opts.projectDir` pins the project (the demo uses it), ignoring CLAUDE_PROJECT_DIR and the payload.
 * `opts.onDecision` hears a rule's decision as soon as it's made, before anything is recorded,
 * so the answer reaches the agent even if recording is slow enough to hit its hook timeout.
 */
export function handleHook(
  agentOrId: Adapter | string,
  raw: Record<string, unknown>,
  base: Ctx,
  event?: string,
  opts: { projectDir?: string; onDecision?: (r: HookResult) => void; startBaseline?: (root: string) => void } = {},
): HookResult {
  const adapter = typeof agentOrId === 'string' ? getAdapter(agentOrId) : agentOrId;
  if (!adapter) throw new Error(`unknown agent ${String(agentOrId)}`);
  const input = adapter.normalize(raw, event);
  const result: HookResult = {};
  if (!input) return result;
  const hookInput: HookInput = input;
  const agent = adapter.id;
  const dir = opts.projectDir ?? projectDir(adapter, input, base);
  const ctx = { ...base, cwd: dir };
  const sessionId = input.session_id || 'unknown';
  const tool0 = input.tool_name ?? '';
  // relative paths in a tool call are relative to where the agent is now, which may be below the project root
  const shellCwd = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : dir;
  // the rules are checked before anything else, so no failure in recording can turn a "deny" into silence
  let p: Project;
  try {
    p = openProject(dir, ctx);
  } catch (e) {
    if (input.moment === 'pre') Object.assign(result, guard(base, tool0, input.tool_input ?? {}, dir, shellCwd, input.raw_input));
    if (result.decision) {
      opts.onDecision?.(result);
      result.problem = `recording failed: ${(e as Error).message}`;
      return result;
    }
    throw e;
  }
  if (input.moment === 'pre') Object.assign(result, guard(base, tool0, input.tool_input ?? {}, p.root, shellCwd, input.raw_input));
  if (result.decision) opts.onDecision?.(result);
  const ref = sessionRef(p, agent, sessionId);
  const canSnap = !unsafeRoot(p.root, ctx) && isDir(p.root) && gitVersion() !== null;

  try {
    record(p, ref, canSnap);
  } catch (e) {
    if (!result.decision) throw e;
    result.problem = `recording failed: ${(e as Error).message}`;
  }
  return result;

  function record(p: Project, ref: SessionRef, canSnap: boolean): void {
    const input = hookInput;
  withLock(ref.file + '.lock', () => {
    const st = readState(ref);
    // the same payload twice means Zerostel is hooked in twice (the plugin and
    // `zerostel install`, say): record it once. Tool events carry a unique id;
    // prompts and turn ends don't (two "continue" prompts look alike), so for
    // those only an identical payload right after, within seconds, counts.
    const key = crypto.createHash('sha1').update(`${adapter!.id}\0${event ?? ''}\0${JSON.stringify(raw)}`).digest('hex').slice(0, 16);
    const nowMs = Date.now();
    const seen = (st.recent ??= []).map((r) => r.split('@') as [string, string]);
    const last = seen[seen.length - 1];
    if (input.tool_use_id ? seen.some(([k]) => k === key) : last?.[0] === key && nowMs - Number(last[1]) < 3000) return;
    st.recent = [...st.recent, `${key}@${nowMs}`].slice(-64);
    const env: Env = { p, ref, st, canSnap, ctx: base, result, startBaseline: opts.startBaseline };
    if (!fs.existsSync(ref.file)) {
      append(ref, { e: 'start', v: SESSION_VERSION, ts: now(), agent, session: sessionId, cwd: dir, transcript: input.transcript_path ?? undefined, source: input.source });
    }
    try {
      watchHooks(env, adapter!);
    } catch (e) {
      result.problem ??= `hook check: ${(e as Error).message}`;
    }
    if (input.model) st.model = input.model;
    const moment = input.moment;
    const tool = input.tool_name ?? '';

    // a new project's first snapshot starts in the background as the session
    // opens, so it's usually done before the first prompt
    if (moment === 'start' && canSnap && opts.startBaseline) {
      try {
        if (needsBaseline(p) && !baselineRunning(p)) opts.startBaseline(p.root);
      } catch (e) {
        result.problem ??= `first snapshot: ${(e as Error).message}`;
      }
    }

    if (moment === 'prompt') {
      const s = snap(env, 'before prompt');
      append(ref, { e: 'prompt', ts: now(), id: newId(), text: redact(input.prompt ?? ''), snap: s });
    } else if (moment === 'pre') {
      const id = toolId(input);
      const summary = summarizeTool(tool, input.tool_input ?? {}, p.root, ctx.home);
      const verdict = result.decision;
      // an agent that can't pause to ask is told no, and to get the user's go-ahead
      const blocked = verdict?.action === 'deny' || (verdict?.action === 'ask' && !adapter!.asks);
      if (verdict) append(ref, { e: 'guard', ts: now(), id: newId(), tool, summary, action: blocked ? 'deny' : 'ask', reason: verdict.reason });
      // a blocked call never runs: no snapshot, and no Post will come
      if (!blocked) {
        const mutating = changesFiles(tool);
        const s = mutating ? snap(env, `before ${tool}`) : undefined;
        // global packages and the user environment are read only around commands that look like they change them
        let sys;
        try {
          sys = toolKind(tool) === 'shell' ? captureBefore(base, str(input.tool_input?.command)) : undefined;
        } catch (e) {
          result.problem ??= `system check: ${(e as Error).message}`;
        }
        st.pending[id] = { snap: s, sys };
        append(ref, {
          e: 'pre',
          ts: now(),
          id,
          tool,
          kind: toolKind(tool),
          summary,
          subagent: input.agent_type || undefined,
          input: compactInput(tool, input.tool_input ?? {}),
          snap: s,
        });
      }
    } else if (moment === 'post' || moment === 'post-fail') {
      const id = toolId(input);
      const pending = st.pending[id];
      delete st.pending[id];
      const { ok, output } = summarizeOutput(tool, input.tool_response);
      let after: string | undefined;
      let files;
      if (changesFiles(tool)) snapHome(env);
      if (pending?.sys) {
        try {
          const sys = captureAfter(base, pending.sys);
          for (const { manager, change } of sys.packages) append(ref, { e: 'packages', ts: now(), id: newId(), manager, ...change, undo: undoCommands(manager, change) });
          if (sys.env.length) append(ref, { e: 'userenv', ts: now(), id: newId(), changes: sys.env });
        } catch (e) {
          result.problem ??= `system check: ${(e as Error).message}`;
        }
      }
      if (changesFiles(tool) && canSnap) {
        const before = pending?.snap ?? st.lastSnap;
        after = trySnapshot(p, `after ${tool}`, opts.startBaseline, (m) => (result.problem ??= m));
        files = before && after ? changes(p, before, after) : [];
        if (after) st.lastSnap = after;
      }
      append(ref, {
        e: 'post',
        ts: now(),
        id,
        ok: ok && moment !== 'post-fail',
        output,
        snap: after,
        files,
        durationMs: typeof input.duration_ms === 'number' ? input.duration_ms : undefined,
      });
    } else if (moment === 'stop') {
      const s = snap(env, 'end of turn');
      readTranscriptUsage(input.transcript_path, st);
      // no usage at all means we couldn't read it, which is not the same as 0 tokens
      append(ref, { e: 'turn', ts: now(), snap: s, usage: st.usageFound ? { ...st.usage } : undefined, model: st.model });
      if (canSnap) maintain(p);
    } else if (moment === 'end') {
      append(ref, { e: 'end', ts: now(), reason: input.reason });
    }
    // drop pending entries whose Post never came (interrupted tools)
    const ids = Object.keys(st.pending);
    if (ids.length > 200) for (const k of ids.slice(0, ids.length - 200)) delete st.pending[k];
    writeState(ref, st);
  });
  }
}
