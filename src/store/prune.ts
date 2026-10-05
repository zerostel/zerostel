import fs from 'node:fs';
import { git } from '../util/git.js';
import { rechain, refreshHead, verify } from './audit.js';
import { withLock } from '../util/lock.js';
import type { Project } from './project.js';
import { listSessions, shortId, type SessionRef } from './session.js';
import { head, lockFile, repoSize } from './shadow.js';

// Snapshots form one chain of commits (each one's parent is the previous), so
// every snapshot stays reachable and git never garbage-collects it. Pruning
// drops old sessions, rebuilds the chain with only the snapshots the
// remaining sessions still point at, rewrites those ids in the session files,
// and lets git delete the rest.

const SHA = /^[0-9a-f]{40}$/;

export interface PruneResult {
  sessionsRemoved: SessionRef[];
  sessionsKept: number;
  snapshotsBefore: number;
  snapshotsAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  dryRun: boolean;
}

function lastActivity(ref: SessionRef): number {
  try {
    return fs.statSync(ref.file).mtimeMs;
  } catch {
    return 0;
  }
}

function stateFile(ref: SessionRef): string {
  return ref.file.replace(/\.jsonl$/, '.state.json');
}

// Snapshot ids live in a few known fields. Only those are read or rewritten:
// a 40-hex string that happens to sit in a prompt or command output is text.
const EVENT_FIELDS = ['snap', 'from', 'to'] as const;
const isSha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v) && v.length === 40;

type Mapper = (sha: string) => string;

function mapEventLine(line: string, f: Mapper): string {
  if (!line.trim()) return line;
  try {
    const ev = JSON.parse(line) as Record<string, unknown>;
    for (const k of EVENT_FIELDS) if (isSha(ev[k])) ev[k] = f(ev[k] as string);
    return JSON.stringify(ev);
  } catch {
    return line; // a line cut short by a crash stays as it is
  }
}

function mapState(text: string, f: Mapper): string {
  const st = JSON.parse(text) as { lastSnap?: unknown; pending?: Record<string, { snap?: unknown }> };
  if (isSha(st.lastSnap)) st.lastSnap = f(st.lastSnap);
  for (const v of Object.values(st.pending ?? {})) if (v && isSha(v.snap)) v.snap = f(v.snap);
  return JSON.stringify(st);
}

function referenced(refs: SessionRef[]): Set<string> {
  const out = new Set<string>();
  const add: Mapper = (s) => (out.add(s), s);
  for (const ref of refs) {
    try {
      for (const line of fs.readFileSync(ref.file, 'utf8').split('\n')) mapEventLine(line, add);
    } catch {
      // session file gone
    }
    try {
      mapState(fs.readFileSync(stateFile(ref), 'utf8'), add);
    } catch {
      // no state file
    }
  }
  return out;
}

/** Sessions touched in the last few minutes probably belong to a running agent. */
export function activeSessions(p: Project, withinMs = 2 * 60_000): SessionRef[] {
  const now = Date.now();
  return listSessions(p).filter((r) => now - lastActivity(r) < withinMs);
}

export function prune(p: Project, opts: { olderThanDays: number; dryRun?: boolean; now?: number; force?: boolean }): PruneResult {
  return withLock(
    lockFile(p),
    () => {
      const cutoff = (opts.now ?? Date.now()) - opts.olderThanDays * 86_400_000;
      const all = listSessions(p);
      const old = all.filter((r) => lastActivity(r) < cutoff);
      const kept = all.filter((r) => !old.includes(r));
      const bytesBefore = repoSize(p);
      const tip = fs.existsSync(p.repo.gitDir) ? head(p) : null;
      const chain = tip ? git(p.repo, ['rev-list', '--reverse', tip]).split('\n').filter(Boolean) : [];
      const keep = referenced(kept);
      if (tip) keep.add(tip); // the latest snapshot is the base for the next one
      const survivors = chain.filter((c) => keep.has(c));
      const result: PruneResult = {
        sessionsRemoved: old,
        sessionsKept: kept.length,
        snapshotsBefore: chain.length,
        snapshotsAfter: survivors.length,
        bytesBefore,
        bytesAfter: bytesBefore,
        dryRun: !!opts.dryRun,
      };
      if (opts.dryRun || (!old.length && survivors.length === chain.length)) return result;

      // re-signing a log that doesn't verify would hide whatever was done to it
      if (!opts.force) {
        for (const ref of kept) {
          const v = verify(ref.file);
          if (v.status === 'broken') throw new Error(`the log of session ${shortId(ref.id)} doesn't verify (${v.problems[0]}); pruning would re-sign it. Look at it with zerostel verify, or pass --force`);
        }
      }

      // rebuild the chain from the surviving snapshots, oldest first
      const info = new Map<string, { tree: string; subject: string }>();
      if (chain.length) {
        for (const line of git(p.repo, ['log', '--format=%H %T %s', tip!]).split('\n')) {
          const [sha, tree, ...subject] = line.split(' ');
          if (sha && tree) info.set(sha, { tree, subject: subject.join(' ') || 'snapshot' });
        }
      }
      const renamed = new Map<string, string>();
      let parent: string | null = null;
      for (const old of survivors) {
        const { tree, subject } = info.get(old)!;
        const args = ['commit-tree', tree, '-m', subject];
        if (parent) args.push('-p', parent);
        parent = git(p.repo, args).trim();
        renamed.set(old, parent);
      }

      // point the remaining sessions at the new ids before moving HEAD
      for (const ref of kept) {
        withLock(ref.file + '.lock', () => {
          const f: Mapper = (s) => renamed.get(s) ?? s;
          for (const file of [ref.file, stateFile(ref)]) {
            if (!fs.existsSync(file)) continue;
            const text = fs.readFileSync(file, 'utf8');
            let next: string;
            try {
              // new snapshot ids change the lines, so their chain values are recomputed
              next = file === ref.file ? rechain(file, text.split('\n').map((l) => mapEventLine(l, f))).join('\n') : mapState(text, f);
            } catch {
              continue; // unreadable state file; the next hook rewrites it
            }
            if (next === text) continue;
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, next);
            fs.renameSync(tmp, file);
            if (file === ref.file) refreshHead(file);
          }
        });
      }
      // only if nothing snapshotted meanwhile; otherwise stop before gc can drop it
      if (parent) git(p.repo, ['update-ref', 'HEAD', parent, tip!]);
      for (const ref of old) for (const f of [ref.file, stateFile(ref), ref.file + '.lock', ref.file + '.head']) fs.rmSync(f, { force: true });

      git(p.repo, ['reflog', 'expire', '--expire=now', '--all'], { allowFail: true });
      git(p.repo, ['gc', '--prune=now', '--quiet'], { allowFail: true });
      result.bytesAfter = repoSize(p);
      return result;
    },
    { timeoutMs: 120_000, staleMs: 600_000 },
  );
}
