import fs from 'node:fs';
import path from 'node:path';
import { runDoctor, type Level } from './doctor.js';
import { activeSessions, prune } from '../store/prune.js';
import { listProjects, openProject, projectRoot, type Project } from '../store/project.js';
import { listSessions, loadSession, regressions, shortId, summarize, type Session } from '../store/session.js';
import { repoSize } from '../store/shadow.js';
import { displayPath, tilde, type Ctx } from '../util/paths.js';
import { ago, c, err, fmtBytes, fmtClock, fmtDate, out, truncate } from '../util/term.js';

type Flags = { project?: string; json?: boolean; 'older-than'?: string; 'dry-run'?: boolean; force?: boolean; yes?: boolean };

function fail(msg: string): never {
  err(c.red('✗ ') + msg);
  process.exit(1);
}

/**
 * The project a command works on: --project (an id from `zerostel projects`,
 * or a path), otherwise the folder we're in. Ids keep working after a project
 * folder is moved or renamed.
 */
export function project(ctx: Ctx, flags: Flags): Project {
  if (!flags.project) return openProject(ctx.cwd, ctx);
  const known = listProjects(ctx);
  const byId = known.find((x) => x.id === flags.project) ?? known.find((x) => x.id.startsWith(flags.project!));
  if (byId) return openProject(byId.root, ctx);
  const dir = path.resolve(ctx.cwd, flags.project);
  if (fs.existsSync(dir)) return openProject(dir, ctx);
  fail(`no project "${flags.project}"; see zerostel projects`);
}

export function sessionHeader(s: Session) {
  const sum = summarize(s);
  return { id: s.id, agent: s.agent, startedAt: s.startedAt, endedAt: s.endedAt, ...sum, model: s.model };
}

export function sessionJson(s: Session) {
  const regs = regressions(s).map((r) => ({ command: r.command, passed: r.passed.n, failed: r.failed.n, changed: r.changed.map((x) => x.n) }));
  return { ...sessionHeader(s), regressions: regs, steps: s.steps };
}

/** Every step, in every session of the project, that touched `target`. */
export function find(p: Project, target: string | undefined, flags: Flags): void {
  if (!target) fail('usage: zerostel find <path>');
  // paths are relative to where you are, like any other command
  const relToRoot = displayPath(path.resolve(process.cwd(), target), p.root, p.root).replace(/\/$/, '');
  const hits: { session: Session; n: number; ts: string; status: string; path: string; summary: string }[] = [];
  for (const ref of listSessions(p)) {
    const s = loadSession(ref);
    for (const st of s.steps) {
      for (const f of st.files) {
        if (f.path === relToRoot || f.path.startsWith(relToRoot + '/')) hits.push({ session: s, n: st.n, ts: st.ts, status: f.status, path: f.path, summary: st.summary });
      }
    }
  }
  hits.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (flags.json) {
    out(JSON.stringify(hits.map((h) => ({ session: h.session.id, agent: h.session.agent, step: h.n, ts: h.ts, status: h.status, path: h.path, summary: h.summary })), null, 2));
    return;
  }
  if (!hits.length) return out(c.dim(`No recorded step touched ${relToRoot}.`));
  const word = { A: c.green('added'), M: c.yellow('changed'), T: c.yellow('changed'), D: c.red('deleted') } as Record<string, string>;
  for (const h of hits.slice(0, 100)) {
    out(`${c.dim(fmtDate(h.ts) + ':' + fmtClock(h.ts).slice(6))}  ${c.bold(shortId(h.session.id))} #${String(h.n).padEnd(4)} ${(word[h.status] ?? h.status).padEnd(16)} ${h.path}  ${c.dim(truncate(h.summary, 60))}`);
  }
  if (hits.length > 100) out(c.dim(`… ${hits.length - 100} more`));
  const last = hits[0]!;
  out(c.dim(`\n  zerostel diff ${last.n} --session ${last.session.id} · zerostel rewind ${last.n} --session ${last.session.id} --only ${relToRoot}`));
}

function parseDays(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(d|days?|w|weeks?|h|hours?)?$/i.exec(v.trim());
  if (!m) fail(`--older-than takes something like 30d, 2w or 12h`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'd')[0]!.toLowerCase();
  return unit === 'w' ? n * 7 : unit === 'h' ? n / 24 : n;
}

export function pruneCmd(ctx: Ctx, p: Project, flags: Flags): void {
  const days = parseDays(flags['older-than'], p.config.retentionDays);
  const busy = activeSessions(p);
  if (busy.length && !flags.force && !flags['dry-run']) {
    fail(`an agent looks active in this project (${busy.map((b) => shortId(b.id)).join(', ')}); stop it first or pass --force`);
  }
  let r: ReturnType<typeof prune>;
  try {
    r = prune(p, { olderThanDays: days, dryRun: flags['dry-run'], force: flags.force });
  } catch (e) {
    fail((e as Error).message);
  }
  if (flags.json) return out(JSON.stringify({ ...r, sessionsRemoved: r.sessionsRemoved.map((x) => x.id) }, null, 2));
  const verb = r.dryRun ? 'Would remove' : 'Removed';
  out(`${verb} ${r.sessionsRemoved.length} session(s) older than ${days} day(s), kept ${r.sessionsKept}.`);
  out(`Snapshots: ${r.snapshotsBefore} → ${r.snapshotsAfter}${r.dryRun ? '' : ` · ${fmtBytes(r.bytesBefore)} → ${fmtBytes(r.bytesAfter)}`}`);
  if (r.dryRun) out(c.dim('  dry run: nothing was changed'));
}

export function projects(ctx: Ctx, flags: Flags): void {
  const here = projectRoot(ctx.cwd);
  const rows = listProjects(ctx).map((pr) => {
    const p = openProject(pr.root, ctx);
    const refs = listSessions(p);
    const last = refs.length ? fs.statSync(refs[0]!.file).mtime.toISOString() : undefined;
    return { id: pr.id, root: pr.root, exists: fs.existsSync(pr.root), sessions: refs.length, bytes: repoSize(p), last, current: path.resolve(pr.root) === path.resolve(here) };
  });
  rows.sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
  if (flags.json) return out(JSON.stringify(rows, null, 2));
  if (!rows.length) return out(c.dim('Nothing recorded yet.'));
  for (const r of rows) {
    const where = tilde(r.root, ctx.home) + (r.exists ? '' : c.yellow('  (folder moved or deleted)'));
    out(`${r.current ? c.cyan('▸') : ' '} ${c.bold(r.id.padEnd(28))} ${String(r.sessions).padStart(3)} session(s)  ${fmtBytes(r.bytes).padStart(9)}  ${(r.last ? ago(r.last) : '').padEnd(9)}  ${where}`);
  }
  out(c.dim('\n  any command takes --project <id>, e.g. zerostel log --project ' + rows[0]!.id));
}

const MARK: Record<Level, string> = { ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗'), info: c.dim('·') };

export function doctor(ctx: Ctx, flags: Flags): void {
  const checks = runDoctor(ctx);
  if (flags.json) return out(JSON.stringify(checks, null, 2));
  for (const ch of checks) {
    out(`${MARK[ch.level]} ${ch.area.padEnd(12)} ${ch.message}`);
    if (ch.fix && ch.level !== 'ok') out(c.dim(`  ${' '.repeat(12)} → ${ch.fix}`));
  }
  const bad = checks.filter((x) => x.level === 'fail').length;
  const warn = checks.filter((x) => x.level === 'warn').length;
  out(bad ? c.red(`\n${bad} problem(s) need fixing.`) : warn ? c.yellow(`\n${warn} thing(s) worth a look.`) : c.green('\nAll good.'));
}
