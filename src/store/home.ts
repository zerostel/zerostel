import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { git, gitBuf, type GitRepo } from '../util/git.js';
import { withLock } from '../util/lock.js';
import { ensurePrivateDir, type Ctx } from '../util/paths.js';
import { assertRev, blockingParent, changesIn, type FileChange } from './shadow.js';

// Files outside the project that config.json `watch` lists, such as
// ~/.zshrc or ~/.gitconfig, are snapshotted into a repo of their own and
// rewound along with the project. Only those files: git never walks the home
// folder. Zerostel reads each listed file itself and hands git its bytes.

const MAX_BYTES = 1024 * 1024;
const NO_FILE = '0'.repeat(40);

export interface Watched {
  rel: string; // relative to the home folder, with forward slashes
  abs: string;
}

function dir(ctx: Pick<Ctx, 'dataDir'>): string {
  return path.join(ctx.dataDir, 'home');
}

export function homeRepo(ctx: Pick<Ctx, 'dataDir' | 'home'>): GitRepo {
  return { gitDir: path.join(dir(ctx), 'snapshots.git'), workTree: ctx.home, emptyConfig: path.join(ctx.dataDir, 'empty.gitconfig') };
}

/** The watch list as files under the home folder. Anything else, including ~/.zerostel itself, is left out. */
export function watched(ctx: Pick<Ctx, 'dataDir' | 'home' | 'platform'>, list = loadConfig(ctx).config.watch): Watched[] {
  const home = path.resolve(ctx.home);
  const data = path.resolve(ctx.dataDir);
  const out: Watched[] = [];
  const seen = new Set<string>();
  // macOS and Windows file systems ignore case by default, so ~/.ZEROSTEL is ~/.zerostel
  const fold = (p: string) => (ctx.platform === 'win32' || ctx.platform === 'darwin' ? p.toLowerCase() : p);
  const inside = (base: string, p: string) => {
    const rel = path.relative(fold(base), fold(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  for (const raw of list) {
    const expanded = raw === '~' ? home : /^~[\\/]/.test(raw) ? path.join(home, raw.slice(2)) : raw;
    if (!path.isAbsolute(expanded)) continue;
    const abs = path.resolve(expanded);
    if (!inside(home, abs) || fold(abs) === fold(data) || inside(data, abs)) continue;
    const rel = path.relative(home, abs).split(path.sep).join('/');
    if (/[\0\n\r]/.test(rel)) continue;
    const key = ctx.platform === 'win32' || ctx.platform === 'darwin' ? rel.toLowerCase() : rel;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rel, abs });
  }
  return out;
}

/** The latest snapshot, read from the repo's files rather than by starting git. */
function headOf(repo: GitRepo): string | null {
  try {
    const ref = fs.readFileSync(path.join(repo.gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref: (refs\/heads\/[\w.-]+)$/.exec(ref);
    if (!m) return /^[0-9a-f]{40}$/.test(ref) ? ref : null;
    const sha = fs.readFileSync(path.join(repo.gitDir, m[1]!), 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    // no commit yet, or the ref was packed: ask git
    return git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true }).trim() || null;
  }
}

function ensureRepo(ctx: Ctx, repo: GitRepo): void {
  if (fs.existsSync(path.join(repo.gitDir, 'HEAD'))) return;
  ensurePrivateDir(ctx.dataDir, ctx.platform);
  fs.mkdirSync(repo.gitDir, { recursive: true });
  if (!fs.existsSync(repo.emptyConfig)) fs.writeFileSync(repo.emptyConfig, '');
  git(repo, ['init', '-q']);
  for (const [k, v] of [['core.autocrlf', 'false'], ['core.fsmonitor', 'false'], ['commit.gpgsign', 'false'], ['gc.autoDetach', 'false']]) git(repo, ['config', k!, v!]);
  fs.mkdirSync(path.join(repo.gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo.gitDir, 'info', 'attributes'), '* -text -filter -ident\n');
}

interface State {
  head: string | null;
  files: Record<string, string>; // rel -> size:mtime:inode, or "missing" / "other"
}

function signature(abs: string): { sig: string; st: fs.Stats | null } {
  try {
    const st = fs.lstatSync(abs);
    return { st, sig: st.isFile() ? `${st.size}:${st.mtimeMs}:${st.ino}` : 'other' };
  } catch {
    return { st: null, sig: 'missing' };
  }
}

/** Read a file without following a link that replaced it since lstat. */
function readNoFollow(abs: string): Buffer {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Snapshot the watched files. Returns the snapshot id, or null when nothing
 * is watched. Unchanged files (same size, mtime and inode) aren't reread, so
 * the common case starts no git process at all.
 */
export function snapshotHome(ctx: Ctx): string | null {
  const list = watched(ctx);
  if (!list.length) return null;
  ensurePrivateDir(ctx.dataDir, ctx.platform);
  fs.mkdirSync(dir(ctx), { recursive: true });
  return withLock(path.join(dir(ctx), 'lock'), () => {
    const repo = homeRepo(ctx);
    ensureRepo(ctx, repo);
    const stateFile = path.join(dir(ctx), 'state.json');
    let prev: State = { head: null, files: {} };
    try {
      prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State;
    } catch {
      // first run, or a damaged state file: everything is reread
    }
    const head = headOf(repo);
    if (head !== prev.head) prev = { head, files: {} };
    const next: State = { head, files: {} };
    const lines: string[] = [];
    for (const w of list) {
      const { sig, st } = signature(w.abs);
      next.files[w.rel] = sig;
      if (head && prev.files[w.rel] === sig) continue;
      // links, folders, missing and oversized files aren't kept, nor anything reached through a linked folder
      if (!st || !st.isFile() || st.size > MAX_BYTES || blockingParent(path.resolve(ctx.home), w.rel)) {
        lines.push(`0 ${NO_FILE}\t${w.rel}`);
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readNoFollow(w.abs);
      } catch {
        lines.push(`0 ${NO_FILE}\t${w.rel}`);
        continue;
      }
      const sha = git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes }).trim();
      const mode = ctx.platform !== 'win32' && st.mode & 0o111 ? '100755' : '100644';
      lines.push(`${mode} ${sha}\t${w.rel}`);
    }
    // files taken off the watch list leave the snapshots too
    for (const rel of Object.keys(prev.files)) if (!(rel in next.files)) lines.push(`0 ${NO_FILE}\t${rel}`);
    if (!lines.length && head) {
      fs.writeFileSync(stateFile, JSON.stringify(next));
      return head;
    }
    // NUL-separated, so no file name can be read as more than one entry
    if (lines.length) git(repo, ['update-index', '-z', '--index-info'], { input: lines.join('\0') + '\0' });
    const tree = git(repo, ['write-tree']).trim();
    let sha = head;
    if (!head || git(repo, ['rev-parse', `${head}^{tree}`]).trim() !== tree) {
      const args = ['commit-tree', tree, '-m', 'watched files'];
      if (head) args.push('-p', head);
      sha = git(repo, args).trim();
      git(repo, ['update-ref', 'HEAD', sha]);
    }
    next.head = sha;
    fs.writeFileSync(stateFile, JSON.stringify(next));
    return sha;
  });
}

/** Watched files that differ between two home snapshots, shown as ~/path. */
export function homeChanges(ctx: Pick<Ctx, 'dataDir' | 'home'>, from: string | null, to: string): FileChange[] {
  return changesIn(homeRepo(ctx), from, to).map((f) => ({ ...f, path: '~/' + f.path }));
}

export interface HomeRestore {
  /** the home snapshot taken just before, so the restore can be undone */
  from: string | null;
  /** and the one just after */
  to: string | null;
  restored: string[];
  /** watched files that didn't exist at the target point; left as they are */
  kept: string[];
  failed: { path: string; error: string }[];
}

/** Put watched files back to a home snapshot. Only files on the current watch list are touched. */
export function restoreHome(ctx: Ctx, target: string, opts: { dryRun?: boolean } = {}): HomeRestore {
  const res: HomeRestore = { from: null, to: null, restored: [], kept: [], failed: [] };
  const list = watched(ctx);
  if (!list.length) return res;
  const repo = homeRepo(ctx);
  assertRev(target);
  res.from = res.to = snapshotHome(ctx);
  if (!res.from || res.from === target) return res;
  const byRel = new Map(list.map((w) => [w.rel, w]));
  for (const f of changesIn(repo, res.from, target)) {
    const w = byRel.get(f.path);
    if (!w) continue;
    const shown = '~/' + w.rel;
    if (f.status === 'D') {
      res.kept.push(shown);
      continue;
    }
    // not in the snapshot just taken (over the size limit, unreadable): if
    // something is there now, there'd be no copy of it after overwriting
    if (f.status === 'A') {
      let there = true;
      try {
        fs.lstatSync(w.abs);
      } catch (e) {
        there = (e as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      if (there) {
        res.failed.push({ path: shown, error: 'Zerostel has no copy of it as it is now (over 1 MB, or unreadable); left alone' });
        continue;
      }
    }
    res.restored.push(shown);
    if (opts.dryRun) continue;
    try {
      const parent = blockingParent(path.resolve(ctx.home), w.rel);
      if (parent) throw new Error(`~/${parent} is a link or not a folder`);
      // A file still there keeps its permissions. One that's gone comes back
      // owner-only: a snapshot doesn't hold its old mode, and a watched file
      // (a shell profile, an SSH config) is better too private than readable by all.
      const exec = /^100755 /.test(git(repo, ['ls-tree', target, '--', w.rel]).trim());
      let mode = exec ? 0o700 : 0o600;
      try {
        const st = fs.lstatSync(w.abs);
        if (st.isSymbolicLink()) throw new Error('it is a link now; not following it');
        mode = st.mode & 0o777;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const bytes = gitBuf(repo, ['cat-file', 'blob', `${target}:${w.rel}`]);
      fs.mkdirSync(path.dirname(w.abs), { recursive: true });
      const tmp = `${w.abs}.zerostel-${process.pid}.tmp`;
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, bytes, { mode, flag: 'wx' });
      fs.renameSync(tmp, w.abs);
    } catch (e) {
      res.failed.push({ path: shown, error: (e as Error).message });
    }
  }
  if (!opts.dryRun && res.restored.length) res.to = snapshotHome(ctx);
  return res;
}
