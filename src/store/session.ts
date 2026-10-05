import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendChained } from './audit.js';
import type { EnvChange, Manager, SysCapture } from '../system/probe.js';
import type { Project } from './project.js';
import type { FileChange } from './shadow.js';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Format of the session files; bump and migrate in loadSession when it changes. */
export const SESSION_VERSION = 2;

export type Ev =
  | { e: 'start'; v?: number; ts: string; agent: string; session: string; cwd: string; transcript?: string; source?: string; command?: string }
  | { e: 'prompt'; ts: string; id: string; text: string; snap?: string }
  | { e: 'pre'; ts: string; id: string; tool: string; kind: string; summary: string; input?: unknown; snap?: string; subagent?: string }
  | { e: 'post'; ts: string; id: string; ok: boolean; output?: string; snap?: string; files?: FileChange[]; durationMs?: number }
  | { e: 'outside'; ts: string; id: string; from: string; to: string; files: FileChange[] }
  | { e: 'change'; ts: string; id: string; from: string; to: string; files: FileChange[] }
  | { e: 'turn'; ts: string; snap?: string; usage?: Usage; model?: string }
  | { e: 'snapshot'; ts: string; id: string; snap: string; message: string }
  | { e: 'restore'; ts: string; id: string; from: string; to: string; label: string; files: FileChange[]; homeFrom?: string; homeTo?: string }
  // watched files outside the project changed; from/to are snapshots of ~/.zerostel/home
  | { e: 'home'; ts: string; id: string; from?: string; to: string; files: FileChange[] }
  | { e: 'guard'; ts: string; id: string; tool: string; summary: string; action: 'deny' | 'ask'; reason: string }
  // global packages a command changed; rewinds can't undo these, so the commands that would are kept
  | { e: 'packages'; ts: string; id: string; manager: Manager; added: Record<string, string>; removed: Record<string, string>; changed: Record<string, { from: string; to: string }>; undo: string[] }
  // Windows user environment variables a command changed (values are kept here for rewinds, never shown)
  | { e: 'userenv'; ts: string; id: string; changes: EnvChange[] }
  | { e: 'hooks'; ts: string; id: string; file: string; change: 'removed' | 'disabled' }
  | { e: 'end'; ts: string; reason?: string; exit?: number | null };

export interface SessionRef {
  agent: string;
  id: string;
  file: string;
}

export function newId(): string {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

export function now(): string {
  return new Date().toISOString();
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

export function sessionsDir(p: Project): string {
  return path.join(p.dir, 'sessions');
}

export function sessionRef(p: Project, agent: string, id: string): SessionRef {
  return { agent, id, file: path.join(sessionsDir(p), `${safe(agent)}__${safe(id)}.jsonl`) };
}

export function append(ref: SessionRef, ev: Ev): void {
  appendChained(ref.file, ev);
}

export function readEvents(file: string): Ev[] {
  if (!fs.existsSync(file)) return [];
  const out: Ev[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Ev);
    } catch {
      // a line cut short by a crash; skip it
    }
  }
  return out;
}

export function listSessions(p: Project): SessionRef[] {
  const dir = sessionsDir(p);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const [agent, id] = f.replace(/\.jsonl$/, '').split('__');
      return { agent: agent!, id: id ?? '', file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ agent, id, file }) => ({ agent, id, file }));
}

/** Find a session by (a prefix of) its id; newest first. */
/**
 * A session id as shown to people. opencode's ids start with a timestamp
 * (ses_ef61…), so sessions from the same hour share a prefix: show their end.
 * DeepSeek Harness's are "session-" and a UUID: show the UUID's start.
 */
export function shortId(id: string): string {
  if (id.startsWith('ses_') && id.length > 12) return id.slice(-8);
  if (id.startsWith('session-') && id.length > 16) return id.slice(8, 16);
  return id.slice(0, 8);
}

export function findSession(p: Project, idOrPrefix?: string): SessionRef | null {
  const all = listSessions(p);
  if (!idOrPrefix) return all[0] ?? null;
  return all.find((s) => s.id === idOrPrefix) ?? all.find((s) => s.id.startsWith(idOrPrefix)) ?? all.find((s) => shortId(s.id) === idOrPrefix) ?? null;
}

// ---- per-session hook state (pending tool calls, transcript offset) ----

export interface SessionState {
  lastSnap?: string;
  lastHome?: string;
  pending: Record<string, { snap?: string; sys?: SysCapture }>;
  transcriptOffset: number;
  usage: Usage;
  seen: string[];
  /** fingerprints of the last hook payloads, to drop duplicates */
  recent?: string[];
  model?: string;
  usageFound?: boolean; // false until the transcript yields a usage record
  /** the agent's hooks file as last seen: size and time, and whether Zerostel's hooks were on in it */
  hooks?: { sig: string; on: boolean };
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function stateFile(ref: SessionRef): string {
  return ref.file.replace(/\.jsonl$/, '.state.json');
}

export function readState(ref: SessionRef): SessionState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(ref), 'utf8')) as Partial<SessionState>;
    return { pending: {}, transcriptOffset: 0, usage: emptyUsage(), seen: [], ...s };
  } catch {
    return { pending: {}, transcriptOffset: 0, usage: emptyUsage(), seen: [] };
  }
}

export function writeState(ref: SessionRef, s: SessionState): void {
  fs.mkdirSync(path.dirname(ref.file), { recursive: true });
  const tmp = stateFile(ref) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, stateFile(ref));
}

// ---- steps: what the timeline shows ----

export type StepType = 'prompt' | 'tool' | 'outside' | 'change' | 'snapshot' | 'restore' | 'turn' | 'guard' | 'home' | 'packages' | 'userenv' | 'hooks';

export interface Step {
  n: number; // 1-based number shown to the user; 0 for turn markers
  id: string;
  type: StepType;
  ts: string;
  endTs?: string;
  durationMs?: number;
  tool?: string;
  kind?: string;
  summary: string;
  text?: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  before?: string;
  after?: string;
  files: FileChange[];
  usage?: Usage; // per turn
  model?: string;
  subagent?: string; // which subagent made this tool call, if not the main agent
  guard?: 'deny' | 'ask'; // a policy rule blocked this tool call, or asked you first
  /** snapshots of the watched files outside the project, around this step */
  homeBefore?: string;
  homeAfter?: string;
  /** for global package changes: commands that would undo them */
  undo?: string[];
}

export interface Session {
  ref: SessionRef;
  agent: string;
  id: string;
  cwd?: string;
  command?: string;
  startedAt?: string;
  endedAt?: string;
  steps: Step[];
  usage: Usage;
  model?: string;
}

function diffUsage(a: Usage, b: Usage): Usage {
  return { input: a.input - b.input, output: a.output - b.output, cacheRead: a.cacheRead - b.cacheRead, cacheWrite: a.cacheWrite - b.cacheWrite };
}

export function loadSession(ref: SessionRef): Session {
  const events = readEvents(ref.file);
  const s: Session = { ref, agent: ref.agent, id: ref.id, steps: [], usage: emptyUsage() };
  const byId = new Map<string, Step>();
  let lastUsage = emptyUsage();
  let lastTs: string | undefined;
  let home: string | undefined; // the watched files' snapshot as of this point in the log
  for (const ev of events) {
    lastTs = ev.ts;
    const count = s.steps.length;
    switch (ev.e) {
      case 'start':
        s.startedAt ??= ev.ts;
        s.cwd ??= ev.cwd;
        s.command ??= ev.command;
        break;
      case 'prompt':
        s.steps.push({ n: 0, id: ev.id, type: 'prompt', ts: ev.ts, summary: firstLine(ev.text, 100), text: ev.text, before: ev.snap, after: ev.snap, files: [] });
        break;
      case 'pre': {
        const st: Step = { n: 0, id: ev.id, type: 'tool', ts: ev.ts, tool: ev.tool, kind: ev.kind, summary: ev.summary, input: ev.input, before: ev.snap, files: [], subagent: ev.subagent };
        byId.set(ev.id, st);
        s.steps.push(st);
        break;
      }
      case 'post': {
        const st = byId.get(ev.id);
        if (!st) break;
        st.endTs = ev.ts;
        st.ok = ev.ok;
        st.output = ev.output;
        st.after = ev.snap ?? st.before;
        st.files = ev.files ?? [];
        st.durationMs = ev.durationMs;
        st.homeAfter = home;
        break;
      }
      case 'outside':
        s.steps.push({ n: 0, id: ev.id, type: 'outside', ts: ev.ts, summary: 'Changes made outside the agent', before: ev.from, after: ev.to, files: ev.files });
        break;
      case 'change':
        s.steps.push({ n: 0, id: ev.id, type: 'change', ts: ev.ts, summary: describeFiles(ev.files), before: ev.from, after: ev.to, files: ev.files });
        break;
      case 'snapshot':
        s.steps.push({ n: 0, id: ev.id, type: 'snapshot', ts: ev.ts, summary: ev.message || 'Snapshot', before: ev.snap, after: ev.snap, files: [] });
        break;
      case 'restore':
        s.steps.push({ n: 0, id: ev.id, type: 'restore', ts: ev.ts, summary: ev.label, before: ev.from, after: ev.to, files: ev.files });
        if (ev.homeTo) home = ev.homeTo;
        break;
      case 'home':
        home = ev.to;
        if (ev.from && ev.files.length) s.steps.push({ n: 0, id: ev.id, type: 'home', ts: ev.ts, summary: describeFiles(ev.files), files: ev.files, homeBefore: ev.from, homeAfter: ev.to });
        break;
      case 'packages': {
        const parts = [...Object.entries(ev.added).map(([k, v]) => `+${k} ${v}`), ...Object.entries(ev.removed).map(([k]) => `−${k}`), ...Object.entries(ev.changed).map(([k, v]) => `${k} ${v.from} → ${v.to}`)];
        const label = ev.manager === 'npm' ? 'npm -g' : ev.manager;
        s.steps.push({ n: 0, id: ev.id, type: 'packages', ts: ev.ts, summary: `${label}: ${parts.slice(0, 6).join(', ')}${parts.length > 6 ? ', …' : ''}`, text: `Rewinds don't undo this. To undo it: ${ev.undo.join(' ; ')}`, undo: ev.undo, files: [] });
        break;
      }
      case 'userenv':
        s.steps.push({ n: 0, id: ev.id, type: 'userenv', ts: ev.ts, summary: `User environment: ${ev.changes.map((c) => c.name).join(', ')}`, files: [] });
        break;
      case 'hooks':
        s.steps.push({ n: 0, id: ev.id, type: 'hooks', ts: ev.ts, summary: `Zerostel's hooks were ${ev.change === 'removed' ? 'removed from' : 'switched off in'} ${ev.file}`, text: 'Recording can stop from the next time the agent starts. Run zerostel install to put the hooks back, and check who changed the file.', files: [] });
        break;
      case 'guard':
        s.steps.push({ n: 0, id: ev.id, type: 'guard', ts: ev.ts, tool: ev.tool, summary: ev.summary, text: `${ev.action === 'deny' ? 'Blocked' : 'Asked first'}: ${ev.reason}`, guard: ev.action, files: [] });
        break;
      case 'turn': {
        const usage = ev.usage ? diffUsage(ev.usage, lastUsage) : undefined;
        if (ev.usage) {
          lastUsage = ev.usage;
          s.usage = ev.usage;
        }
        if (ev.model) s.model = ev.model;
        s.steps.push({ n: 0, id: 'turn-' + ev.ts, type: 'turn', ts: ev.ts, summary: 'Turn finished', before: ev.snap, after: ev.snap, files: [], usage, model: ev.model });
        break;
      }
      case 'end':
        s.endedAt = ev.ts;
        break;
    }
    // steps added by this event start from the watched files as they were
    for (const st of s.steps.slice(count)) {
      if (st.type === 'home') continue;
      st.homeBefore ??= ev.e === 'restore' ? ev.homeFrom : home;
      st.homeAfter ??= ev.e === 'restore' ? ev.homeTo : home;
    }
  }
  s.endedAt ??= lastTs;
  let n = 0;
  for (const st of s.steps) if (st.type !== 'turn') st.n = ++n;
  return s;
}

export function firstLine(text: string, max: number): string {
  const line = (text ?? '').trim().split(/\r?\n/)[0] ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

export function describeFiles(files: FileChange[]): string {
  if (files.length === 1 || files.length === 2) {
    const verb = { A: 'Added', M: 'Changed', T: 'Changed', D: 'Deleted' } as const;
    const kinds = new Set(files.map((f) => verb[f.status]));
    if (kinds.size === 1) return `${[...kinds][0]} ${files.map((f) => f.path).join(', ')}`;
  }
  const c = { A: 0, M: 0, D: 0 } as Record<string, number>;
  for (const f of files) c[f.status === 'T' ? 'M' : f.status] = (c[f.status === 'T' ? 'M' : f.status] ?? 0) + 1;
  const parts: string[] = [];
  if (c.M) parts.push(`${c.M} modified`);
  if (c.A) parts.push(`${c.A} added`);
  if (c.D) parts.push(`${c.D} deleted`);
  return parts.length ? `Files changed: ${parts.join(', ')}` : 'No file changes';
}

export interface SessionSummary {
  steps: number;
  prompts: number;
  tools: number;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  filesDeleted: number;
  durationMs: number;
  usage: Usage;
  title: string;
}

export function summarize(s: Session): SessionSummary {
  const touched = new Set<string>();
  const deleted = new Set<string>();
  let add = 0;
  let del = 0;
  for (const st of s.steps) {
    if (st.type === 'restore' || st.type === 'turn') continue;
    for (const f of st.files) {
      touched.add(f.path);
      if (f.status === 'D') deleted.add(f.path);
      add += f.added;
      del += f.deleted;
    }
  }
  const start = s.startedAt ?? s.steps[0]?.ts;
  const durationMs = start && s.endedAt ? Date.parse(s.endedAt) - Date.parse(start) : 0;
  const firstPrompt = s.steps.find((x) => x.type === 'prompt');
  return {
    steps: s.steps.filter((x) => x.type !== 'turn').length,
    prompts: s.steps.filter((x) => x.type === 'prompt').length,
    tools: s.steps.filter((x) => x.type === 'tool').length,
    filesChanged: touched.size,
    linesAdded: add,
    linesDeleted: del,
    filesDeleted: deleted.size,
    durationMs: Math.max(0, durationMs),
    usage: s.usage,
    title: firstPrompt ? firstLine(firstPrompt.text ?? '', 80) : s.command ?? `${s.agent} session`,
  };
}

/** How long a tool step took: the agent's own number when it reports one. */
export function stepDuration(st: Step): number | undefined {
  if (typeof st.durationMs === 'number') return st.durationMs;
  return st.endTs ? Date.parse(st.endTs) - Date.parse(st.ts) : undefined;
}

export interface Regression {
  command: string;
  passed: Step; // the last run of the same command that succeeded
  failed: Step;
  changed: Step[]; // steps in between that changed files
}

/**
 * Commands that succeeded and later failed when run again unchanged. A failed
 * command on its own is just a failure (grep finding nothing fails too); the
 * same command going from passing to failing points at the steps in between.
 */
export function regressions(s: Session): Regression[] {
  const last = new Map<string, Step>();
  const out: Regression[] = [];
  for (const st of s.steps) {
    if (st.type !== 'tool' || st.kind !== 'shell' || st.ok === undefined) continue;
    const full = (st.input as { command?: unknown } | undefined)?.command;
    const key = typeof full === 'string' ? full.trim() : st.summary;
    if (!key) continue;
    const prev = last.get(key);
    if (st.ok === false && prev?.ok === true) {
      const changed = s.steps.filter((x) => x.n > prev.n && x.n < st.n && x.files.length && x.type !== 'turn');
      out.push({ command: st.summary.replace(/^\$ /, ''), passed: prev, failed: st, changed });
    }
    last.set(key, st);
  }
  return out;
}

/** When each agent last sent Zerostel anything, across every project. */
export function lastEventByAgent(dataDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const base = path.join(dataDir, 'projects');
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(base);
  } catch {
    return out;
  }
  for (const pr of projects) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(base, pr, 'sessions'));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const agent = f.split('__')[0]!;
      try {
        const t = fs.statSync(path.join(base, pr, 'sessions', f)).mtimeMs;
        if (t > (out[agent] ?? 0)) out[agent] = t;
      } catch {
        // gone
      }
    }
  }
  return out;
}
