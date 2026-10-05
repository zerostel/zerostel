import { restoreHome, type HomeRestore } from '../store/home.js';
import { storeInProject, type Project } from '../store/project.js';
import fs from 'node:fs';
import { append, listSessions, loadSession, newId, now, readEvents, readState, shortId, writeState, type Ev, type Session, type SessionRef, type Step } from '../store/session.js';
import { checkWritable, systemOf, type EnvChange, type EnvValue } from '../system/probe.js';
import { changes, restore, revExists, snapshot, type RestoreResult } from '../store/shadow.js';
import { withLock } from '../util/lock.js';
import type { Ctx } from '../util/paths.js';
import { agentName } from '../view/timeline.js';

/** Snapshot of the project just before step `idx` ran. */
export function snapBefore(steps: Step[], idx: number): string | undefined {
  if (steps[idx]?.before) return steps[idx]!.before;
  for (let j = idx - 1; j >= 0; j--) {
    const s = steps[j]!.after ?? steps[j]!.before;
    if (s) return s;
  }
  return undefined;
}

/** Snapshot of the project right after step `idx` finished. */
export function snapAfter(steps: Step[], idx: number): string | undefined {
  for (let j = idx; j >= 0; j--) {
    const st = steps[j]!;
    const s = st.after ?? st.before;
    if (s) return s;
  }
  return undefined;
}

export interface Target {
  snap: string;
  label: string;
  step?: Step;
  /** where the watched files outside the project go back to */
  home?: string;
  /** the target is just after `step` rather than just before it */
  after?: boolean;
}

function homeAt(steps: Step[], idx: number, after: boolean): string | undefined {
  const st = steps[idx]!;
  return after ? st.homeAfter ?? st.homeBefore : st.homeBefore;
}

export function stepTarget(s: Session, n: number, after = false): Target {
  const idx = s.steps.findIndex((x) => x.n === n);
  if (idx < 0) throw new Error(`step #${n} not found (this session has ${s.steps.filter((x) => x.n).length} steps)`);
  const step = s.steps[idx]!;
  const snap = after ? snapAfter(s.steps, idx) : snapBefore(s.steps, idx);
  if (!snap) throw new Error(`no snapshot exists ${after ? 'after' : 'before'} step #${n}`);
  return { snap, step, label: `Rewind to ${after ? 'after' : 'before'} #${n}`, home: homeAt(s.steps, idx, after), after };
}

/** Point zero: the project as it was when the session's first snapshot was taken. */
export function zeroTarget(s: Session): Target {
  const step = s.steps.find((x) => x.type !== 'turn' && (x.before ?? x.after));
  if (!step) throw new Error('this session has no snapshot to go back to');
  return { snap: (step.before ?? step.after)!, step, label: `Back to point zero (before #${step.n})`, home: step.homeBefore };
}

/** `rewind 0`, `rewind zero` or a step number. */
export function rewindTarget(s: Session, arg: string, after = false): Target {
  const a = arg.trim().toLowerCase().replace(/^#/, '');
  if (a === '0' || a === 'zero' || a === 'start') return zeroTarget(s);
  const n = Number(a);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${arg}" is not a step number; use a number from zerostel log, or 0 for point zero`);
  return stepTarget(s, n, after);
}

/**
 * What `zerostel undo` goes back to:
 *  - right after a rewind: undo the rewind
 *  - hook agents: the start of the latest turn that changed files
 *  - `zerostel run`: the latest batch of changes
 */
export function undoTarget(s: Session): Target | null {
  // a rewind records the user environment it put back right after itself; that's still "right after a rewind"
  const visible = s.steps.filter((x) => x.type !== 'turn' && x.type !== 'userenv');
  const last = visible[visible.length - 1];
  if (last?.type === 'restore' && last.before) return { snap: last.before, label: `Undo rewind #${last.n}`, step: last, home: last.homeBefore };

  const prompts = s.steps.map((x, i) => [x, i] as const).filter(([x]) => x.type === 'prompt');
  for (let k = prompts.length - 1; k >= 0; k--) {
    const [prompt, i] = prompts[k]!;
    const end = k + 1 < prompts.length ? prompts[k + 1]![1] : s.steps.length;
    const turn = s.steps.slice(i + 1, end);
    if (!turn.some((x) => (x.type === 'tool' || x.type === 'change') && x.files.length)) continue;
    if (prompt.before) return { snap: prompt.before, label: `Undo turn #${prompt.n}`, step: prompt, home: prompt.homeBefore };
    // No snapshot from before the prompt (a new project's first snapshot was
    // still being taken): go back as far into the turn as there is one,
    // rather than quietly undoing only its last step.
    // (for edits made outside the agent, the point just after them: before them may be an earlier turn)
    const first = turn.find((x) => (x.type === 'tool' || x.type === 'change' ? x.before : x.type === 'outside' ? x.after : undefined));
    const snap = first && (first.type === 'outside' ? first.after : first.before);
    if (first && snap) return { snap, label: `Undo turn #${prompt.n} from #${first.n} (the turn has no snapshot from before it)`, step: first, home: first.type === 'outside' ? first.homeAfter : first.homeBefore };
  }
  for (let i = s.steps.length - 1; i >= 0; i--) {
    const st = s.steps[i]!;
    if ((st.type === 'change' || st.type === 'tool') && st.files.length && st.before) return { snap: st.before, label: `Undo #${st.n}`, step: st, home: st.homeBefore };
  }
  return null;
}

/** Restore and record it in the session timeline. */
export type Restored = RestoreResult & {
  home?: HomeRestore;
  /** Windows user environment variables put back (or to put back, in a preview) */
  env?: string[];
  /** global package changes since the target: rewinds can't undo them, these commands would */
  packages?: { summary: string; undo: string[] }[];
};

/** Index in the session from which later changes count as "since the target". */
function since(s: Session, t: Target): number | null {
  if (!t.step) return null;
  const idx = s.steps.findIndex((x) => x.id === t.step!.id);
  return idx < 0 ? null : idx + (t.after ? 1 : 0);
}

/**
 * Files someone other than this session changed after the target: another
 * agent's session in the same project, or edits made outside the agent. A
 * rewind of this session would take those back too; the caller can say so,
 * or leave them alone. Path -> who changed it.
 */
export function changedByOthers(p: Project, s: Session, t: Target): Map<string, string> {
  const out = recordedByOthers(p, s, t);
  // Edits nobody has recorded yet: you changed a file in your editor after the
  // agent's last step, and no hook has run since. They show up as differences
  // between this session's last snapshot and the project as it is now.
  try {
    const seen = readState(s.ref).lastSnap;
    if (seen) {
      const now = snapshot(p, 'looking for changes by others').sha;
      if (now !== seen) for (const f of changes(p, seen, now)) if (!out.has(f.path)) out.set(f.path, 'edits outside the agent, not recorded yet');
    }
  } catch {
    // snapshots paused or the old one pruned: only what was recorded counts
  }
  return out;
}

function recordedByOthers(p: Project, s: Session, t: Target): Map<string, string> {
  const sinceMs = t.step ? Date.parse(t.step.ts) : s.startedAt ? Date.parse(s.startedAt) : 0;
  const later = s.steps.slice(since(s, t) ?? 0);
  // when this session itself last changed each file (its own tool calls and rewinds)
  const mine = new Map<string, number>();
  for (const st of later) if (st.type === 'tool' || st.type === 'change' || st.type === 'restore') for (const f of st.files) mine.set(f.path, Date.parse(st.endTs ?? st.ts));
  // who changed it after that: [time, who]
  const last = new Map<string, [number, string]>();
  const note = (path: string, at: number, who: string) => {
    if ((mine.get(path) ?? -Infinity) >= at) return;
    if ((last.get(path)?.[0] ?? -Infinity) < at) last.set(path, [at, who]);
  };
  for (const ref of listSessions(p)) {
    if (ref.file === s.ref.file) continue;
    try {
      if (fs.statSync(ref.file).mtimeMs < sinceMs) continue;
    } catch {
      continue;
    }
    const other = loadSession(ref);
    const who = `${agentName(other.agent)} session ${shortId(other.id)}`;
    // only its own steps: what it saw as "outside" may be this session's work
    for (const st of other.steps) {
      if ((st.type !== 'tool' && st.type !== 'change' && st.type !== 'restore') || Date.parse(st.ts) < sinceMs) continue;
      for (const f of st.files) note(f.path, Date.parse(st.endTs ?? st.ts), who);
    }
  }
  // changes this session saw from outside, that no other session claims
  for (const st of later) if (st.type === 'outside') for (const f of st.files) if (!last.has(f.path)) note(f.path, Date.parse(st.ts), 'edits outside the agent');
  return new Map([...last].map(([path, [, who]]) => [path, who]));
}

/** User environment changes since the target, as the changes that would undo them. */
function envPlan(ctx: Ctx, ref: SessionRef, s: Session, from: number): { plan: EnvChange[]; apply: (c: EnvChange) => void } | null {
  const probe = systemOf(ctx);
  if (ctx.platform !== 'win32' || !probe?.userEnv) return null;
  const ids = new Set(s.steps.slice(from).filter((x) => x.type === 'userenv').map((x) => x.id));
  if (!ids.size) return null;
  // the value each variable had before its first change since the target
  const want = new Map<string, EnvValue | undefined>();
  for (const ev of readEvents(ref.file) as Ev[]) {
    if (ev.e !== 'userenv' || !ids.has(ev.id)) continue;
    for (const c of ev.changes) if (!want.has(c.name)) want.set(c.name, c.from);
  }
  const current = probe.userEnv.read();
  if (!current) return null;
  const plan: EnvChange[] = [];
  for (const [name, value] of want) {
    const cur = current[name];
    if (cur?.type === value?.type && cur?.value === value?.value) continue;
    plan.push({ name, from: cur, to: value });
  }
  const env = probe.userEnv;
  return {
    plan,
    apply: (c) => {
      if (!c.to) return env.remove(c.name);
      checkWritable(c.name, c.to);
      env.set(c.name, c.to);
    },
  };
}

export function applyRestore(p: Project, ref: SessionRef, t: Target, opts: { only?: string[]; keep?: string[]; dryRun?: boolean; ctx?: Ctx } = {}): Restored {
  if (!revExists(p, t.snap)) throw new Error(`snapshot ${t.snap.slice(0, 10)} is missing from ${p.repo.gitDir}`);
  const label = t.label + (opts.only?.length ? ` (${opts.only.join(', ')})` : '');
  const id = newId();
  // Recorded before any file changes, so a rewind cut short (killed, power
  // cut) can still be undone, and prune keeps the snapshot it would go back to.
  if (!opts.dryRun) {
    withLock(ref.file + '.lock', () => append(ref, { e: 'rewinding', ts: now(), id, from: snapshot(p, `before ${t.label}`).sha, label }));
  }
  const res: Restored = restore(p, t.snap, opts);
  // watched files outside the project go back too, unless the rewind is limited to some paths
  if (opts.ctx && t.home && !opts.only?.length) {
    // a missing home snapshot (say ~/.zerostel/home was reset) mustn't stop the project rewind or skip its record
    try {
      res.home = restoreHome(opts.ctx, t.home, { dryRun: opts.dryRun });
    } catch (e) {
      res.home = { from: null, to: null, restored: [], kept: [], failed: [{ path: '~ (watched files)', error: (e as Error).message }] };
    }
  }
  const s = loadSession(ref);
  const from = since(s, t);
  let env: ReturnType<typeof envPlan> = null;
  if (from !== null) {
    res.packages = s.steps.slice(from).filter((x) => x.type === 'packages').reverse().map((x) => ({ summary: x.summary, undo: x.undo ?? [] }));
    if (opts.ctx && !opts.only?.length) env = envPlan(opts.ctx, ref, s, from);
    if (env?.plan.length) res.env = env.plan.map((c) => c.name);
  }
  if (res.dryRun) return res;
  const envDone: EnvChange[] = [];
  for (const c of env?.plan ?? []) {
    try {
      env!.apply(c);
      envDone.push(c);
    } catch (e) {
      res.failed.push({ path: `%${c.name}%`, error: (e as Error).message });
    }
  }
  withLock(ref.file + '.lock', () => {
    const after = snapshot(p, t.label).sha;
    const files = changes(p, res.from, after);
    // check the result instead of trusting it: anything still different from
    // the target (within --only) wasn't restored
    const failed = new Set(res.failed.map((f) => f.path));
    const own = storeInProject(p);
    for (const c of changes(p, t.snap, after)) {
      const inScope = !opts.only?.length || opts.only.some((o) => c.path === o || c.path.startsWith(o.replace(/\/$/, '') + '/'));
      const ours = own !== null && (c.path === own || c.path.startsWith(own + '/'));
      if (inScope && !ours && !failed.has(c.path) && !res.kept.includes(c.path)) res.failed.push({ path: c.path, error: 'still differs from the snapshot after rewinding' });
    }
    const homeFiles = (res.home?.restored ?? []).map((path) => ({ path, status: 'M' as const, added: 0, deleted: 0, binary: false }));
    for (const f of res.home?.failed ?? []) res.failed.push(f);
    append(ref, { e: 'restore', ts: now(), id, from: res.from, to: after, label, files: [...files, ...homeFiles], homeFrom: res.home?.from ?? undefined, homeTo: res.home?.to ?? undefined });
    // recorded like any other change, so undoing this rewind puts the variables back too
    if (envDone.length) append(ref, { e: 'userenv', ts: now(), id: newId(), changes: envDone });
    // so the next hook doesn't report the rewind as an outside change
    const st = readState(ref);
    st.lastSnap = after;
    if (res.home?.to) st.lastHome = res.home.to;
    writeState(ref, st);
  });
  return res;
}
