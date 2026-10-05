import fs from 'node:fs';
import path from 'node:path';
import { exclude, git, GitError, type GitRepo } from '../util/git.js';
import { sleepSync, withLock } from '../util/lock.js';
import { assertProjectIdentity, storeInProject, writeProjectMeta, type Project } from './project.js';

// Dependency and cache folders that are big, regenerable and not worth a
// snapshot. The project's own .gitignore applies on top of this.
const DEFAULT_EXCLUDES = [
  'node_modules/', 'bower_components/', 'jspm_packages/',
  '.venv/', 'venv/', '__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/',
  '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.parcel-cache/', '.angular/', '.vite/',
  '.gradle/', '.terraform/', '.dart_tool/', 'Pods/', 'DerivedData/',
  '.DS_Store', 'Thumbs.db',
];

// Ignored files we still back up when they are small: an agent deleting
// .env or a local config is exactly the kind of thing people need back.
const SMALL_IGNORED_MAX = 1024 * 1024;
const SMALL_IGNORED_COUNT = 500;
const SKIP_IGNORED = /(^|\/)(node_modules|\.venv|venv|__pycache__|\.next|\.nuxt|dist|build|out|target|coverage|\.cache|logs?)(\/|$)|\.(log|pyc|tmp|swp|lock)$/i;

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Snapshot ids come back from session files; only ever hand git a plain hash
// so nothing in those files can turn into a command-line option.
export function assertRev(rev: string): string {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(rev)) throw new Error(`not a snapshot id: ${JSON.stringify(rev).slice(0, 80)}`);
  return rev;
}

export function lockFile(p: Project): string {
  return path.join(p.dir, 'lock');
}

// Bump when the settings below change; older repos get them on next use.
const REPO_VERSION = 3;

function configureRepo(p: Project): void {
  const cfg: [string, string][] = [
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['core.longpaths', 'true'],
    ['core.quotepath', 'false'],
    ['core.fsmonitor', 'false'],
    ['core.untrackedCache', 'true'],
    ['commit.gpgsign', 'false'],
    ['gc.autoDetach', 'false'],
    // macOS hands out decomposed (NFD) names; store them the way git elsewhere does
    ['core.precomposeunicode', 'true'],
  ];
  for (const [k, v] of cfg) git(p.repo, ['config', k, v]);
  const info = path.join(p.repo.gitDir, 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(path.join(info, 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n');
  // store bytes exactly as they are on disk: no eol conversion, no LFS, no
  // re-encoding (a working-tree-encoding git can't apply makes `add` give up)
  fs.writeFileSync(path.join(info, 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
  fs.writeFileSync(path.join(p.dir, 'repo-version'), String(REPO_VERSION));
}

function repoVersion(p: Project): number {
  try {
    return Number(fs.readFileSync(path.join(p.dir, 'repo-version'), 'utf8')) || 0;
  } catch {
    return 0; // created before versioning, or not yet
  }
}

export function ensureRepo(p: Project): void {
  assertProjectIdentity(p);
  const ready = () => fs.existsSync(path.join(p.repo.gitDir, 'HEAD')) && repoVersion(p) >= REPO_VERSION;
  if (ready()) return;
  // Several hooks start at once on a new project; one sets it up. A lock of
  // its own: callers may already hold the project lock.
  fs.mkdirSync(p.dir, { recursive: true });
  withLock(path.join(p.dir, 'init.lock'), () => {
    if (ready()) return;
    if (!fs.existsSync(path.join(p.repo.gitDir, 'HEAD'))) {
      if (!fs.existsSync(p.repo.emptyConfig)) fs.writeFileSync(p.repo.emptyConfig, '');
      writeProjectMeta(p);
      git(p.repo, ['init', '-q']);
    }
    configureRepo(p);
  });
}

export function head(p: Project): string | null {
  const out = git(p.repo, ['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true }).trim();
  return out || null;
}

const SKIP_WALK = new Set(['.git', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.gradle', '.terraform']);

/**
 * Folders inside the project that are really links somewhere else. git on
 * Windows walks through junctions and directory symlinks as if they were
 * plain folders, so without this a link to the home directory would copy the
 * whole home directory into the snapshot. On other systems git stores
 * symlinks as links and never follows them.
 */
export function linkedDirs(p: Project, platform: NodeJS.Platform = process.platform, limit = 100_000): string[] {
  if (platform !== 'win32') return [];
  const own = storeInProject(p);
  const found = new Set<string>();
  const isLink = (rel: string) => {
    try {
      return fs.lstatSync(path.join(p.root, rel)).isSymbolicLink();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
      throw new SnapshotSkipped(`linked-folder safety scan could not inspect ${rel}: ${(e as NodeJS.ErrnoException).code ?? 'filesystem error'}`);
    }
  };
  // folders that already hold snapshotted files
  const dirs = new Set<string>();
  for (const f of git(p.repo, ['ls-files', '-z']).split('\0')) {
    for (let i = f.lastIndexOf('/'); i > 0; i = f.lastIndexOf('/', i - 1)) {
      const d = f.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
    }
  }
  for (const d of dirs) if (isLink(d)) found.add(d);
  // a snapshotted file that has since been replaced by a link to a folder
  for (const f of git(p.repo, ['diff-files', '--name-only', '-z', '--diff-filter=DT']).split('\0')) if (f && isLink(f)) found.add(f);
  // new folders: walk them ourselves rather than let git walk through a link
  const budget = { left: limit };
  // Project .gitignore rules can re-include default dependency folders, so
  // those are skipped only when git agrees they're ignored. Asked in batches:
  // one git call per round instead of one per folder.
  let deferred: string[] = [];
  const walk = (rel: string) => {
    if (isLink(rel)) {
      found.add(rel);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(p.root, rel), { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return;
      throw new SnapshotSkipped(`linked-folder safety scan could not read ${rel}: ${(e as NodeJS.ErrnoException).code ?? 'filesystem error'}`);
    }
    for (const e of entries) {
      if (--budget.left < 0) throw new ScanTooLarge(`linked-folder safety scan exceeded ${limit} entries; snapshots paused rather than risk copying files outside the project`);
      const child = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) found.add(child);
      else if (e.isDirectory() && e.name !== '.git' && child !== own) {
        if (SKIP_WALK.has(e.name)) deferred.push(child);
        else walk(child);
      }
    }
  };
  const untracked = git(p.repo, ['ls-files', '-z', '-o', '--directory', '--exclude-standard', '--', '.', ...[...found, ...(own ? [own] : [])].map(exclude), ...userExcludes(p)], { magic: true });
  for (const e of untracked.split('\0')) if (e.endsWith('/')) walk(e.slice(0, -1));
  while (deferred.length) {
    const batch = deferred;
    deferred = [];
    const out = git(p.repo, ['check-ignore', '--no-index', '-z', '--stdin'], { input: batch.map((d) => d + '/\0').join(''), allowFail: true });
    const ignored = new Set(out.split('\0').map((x) => x.replace(/\/$/, '')));
    for (const d of batch) if (!ignored.has(d)) walk(d);
  }
  return [...found];
}

// New files above config.maxFileMB (datasets, model weights, dumps) are left
// out so one stray download can't double the snapshot store every time it changes.
function largeNewFiles(p: Project, links: string[]): string[] {
  const max = p.config.maxFileMB * 1024 * 1024;
  const out = git(p.repo, ['ls-files', '-z', '-o', '--exclude-standard', '--', '.', ...links.map(exclude)], { magic: true });
  const big: string[] = [];
  for (const rel of out.split('\0')) {
    if (!rel) continue;
    try {
      if (fs.lstatSync(path.join(p.root, rel)).size > max) big.push(rel);
    } catch {
      // gone already
    }
  }
  return big;
}

const PRECIOUS = /(^|\/)(\.env[^/]*|\.envrc|\.npmrc|\.dev\.vars|[^/]*\.local(\.[^/]+)?|secrets?\.[^/]+|config\.[^/]+)$/i;

/** config.json `exclude` patterns (git glob syntax) as exclude pathspecs. */
function userExcludes(p: Project): string[] {
  return p.config.exclude.map((pattern) => `:(exclude,glob)${pattern}`);
}

function addSmallIgnored(p: Project, links: string[]): void {
  const out = git(p.repo, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory', '--', '.', ...links.map(exclude), ...userExcludes(p)], { magic: true });
  // .env and friends first, so a pile of small ignored files can't crowd them out
  const candidates = out
    .split('\0')
    .filter((rel) => rel && !rel.endsWith('/') && !SKIP_IGNORED.test(rel))
    .slice(0, 20_000)
    .sort((a, b) => Number(PRECIOUS.test(b)) - Number(PRECIOUS.test(a)));
  const picks: string[] = [];
  for (const rel of candidates) {
    if (blockingParent(p.root, rel)) continue;
    try {
      const st = fs.lstatSync(path.join(p.root, rel));
      if (st.isFile() && st.size <= SMALL_IGNORED_MAX) picks.push(rel);
    } catch {
      continue;
    }
    if (picks.length >= SMALL_IGNORED_COUNT) break;
  }
  if (picks.length) git(p.repo, ['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: picks.join('\0') });
}

export interface Snap {
  sha: string;
  created: boolean; // false when nothing changed since the last snapshot
  /** git couldn't copy some files (unreadable, locked); they keep their older copy */
  incomplete?: string;
}

// A huge or ever-growing tree (by accident or on purpose) must not stall the
// agent on every tool call. If staging takes too long, stop snapshotting this
// project for a while and keep recording the timeline only.
const PAUSE_MS = 60 * 60 * 1000;

export class SnapshotSkipped extends Error {}

/** The linked-folder scan met more entries than it may look at in one go. */
class ScanTooLarge extends SnapshotSkipped {}

// The first snapshot of a project reads every file in it, which takes minutes
// on a big one (on Windows a virus scanner looks at each file as git reads
// it). It goes in chunks, each of which leaves the index saved, so no work is
// lost when time runs out: the next attempt, or a background worker, carries on.
// Later snapshots only look at what changed and take a fraction of a second.
const CHUNK = 300;
/** How long a hook spends on a first snapshot before handing it to the background. */
export const FIRST_SNAPSHOT_MS = 8_000;
const BASELINE_MAX_MS = 30 * 60 * 1000;

/** Thrown while a project's first snapshot is still being taken. */
export class BaselinePending extends SnapshotSkipped {}

export interface SnapshotOptions {
  /** time for staging a first snapshot (default FIRST_SNAPSHOT_MS) */
  firstBudgetMs?: number;
  /** files per git add while staging a first snapshot */
  chunk?: number;
  /** the background worker itself, which doesn't wait for itself */
  background?: boolean;
}

function baselineFile(p: Project): string {
  return path.join(p.dir, 'baseline.json');
}

/** Whether a background worker is taking this project's first snapshot right now. */
export function baselineRunning(p: Project): boolean {
  let j: { pid: number; at: number };
  try {
    j = JSON.parse(fs.readFileSync(baselineFile(p), 'utf8')) as { pid: number; at: number };
  } catch {
    return false;
  }
  if (!Number.isInteger(j.pid) || Date.now() - j.at > BASELINE_MAX_MS) return false;
  try {
    process.kill(j.pid, 0);
    return true;
  } catch (e) {
    // there but not ours to signal still means there
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the project has no snapshot yet. */
export function needsBaseline(p: Project): boolean {
  ensureRepo(p);
  return head(p) === null;
}

/** Stage what isn't staged yet, a chunk at a time, until done (true) or the deadline. */
function stageRemaining(p: Project, skip: string[], deadline: number, chunk: number, onFail: (e: { stderr: string }) => void): boolean {
  const out = git(p.repo, ['ls-files', '-z', '-o', '--exclude-standard', '--', '.', ...skip], { magic: true });
  const files = out.split('\0').filter(Boolean);
  for (let i = 0; i < files.length; i += chunk) {
    if (Date.now() >= deadline) return false;
    try {
      git(p.repo, ['add', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: files.slice(i, i + chunk).join('\0'), allowFail: true, onFail, timeoutMs: p.config.snapshotTimeoutSec * 1000 });
    } catch (e) {
      if (e instanceof GitError && e.timedOut) return false;
      throw e;
    }
  }
  return true;
}

/**
 * Take a project's first snapshot in the background, a chunk at a time,
 * letting hooks take the lock in between. Null when someone else finished it.
 */
export function takeBaseline(p: Project, message: string): Snap | null {
  ensureRepo(p);
  // claimed with an exclusive create, so two workers never start on one project
  const claim = () => {
    try {
      fs.writeFileSync(baselineFile(p), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return false;
    }
  };
  if (!claim()) {
    if (baselineRunning(p)) return null;
    fs.rmSync(baselineFile(p), { force: true }); // left by a worker that died
    if (!claim()) return null;
  }
  try {
    const until = Date.now() + BASELINE_MAX_MS;
    while (Date.now() < until) {
      if (head(p)) return null;
      try {
        return snapshot(p, message, { firstBudgetMs: 3_000, background: true });
      } catch (e) {
        if (!(e instanceof BaselinePending)) throw e;
      }
      sleepSync(20);
    }
    return null;
  } finally {
    fs.rmSync(baselineFile(p), { force: true });
  }
}

function pausedFile(p: Project): string {
  return path.join(p.dir, 'paused.json');
}

/** Why snapshots are paused for this project, or null when they aren't. */
export function snapshotsPaused(p: Project): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(pausedFile(p), 'utf8')) as { at: number; reason: string };
    if (Date.now() - j.at < PAUSE_MS) return j.reason;
  } catch {
    // no pause file
  }
  return null;
}

function snapshotUnlocked(p: Project, message: string, opts: SnapshotOptions = {}): Snap {
  if (p.snapshotProblem) throw new SnapshotSkipped(`cannot safely apply snapshot privacy settings: ${p.snapshotProblem}`);
  ensureRepo(p);
  const paused = snapshotsPaused(p);
  if (paused) throw new SnapshotSkipped(paused);
  const first = head(p) === null;
  if (first && !opts.background && baselineRunning(p)) throw new BaselinePending('the first snapshot of this project is being taken in the background');
  // we hold the project lock, so an index.lock here was left by a crash
  fs.rmSync(path.join(p.repo.gitDir, 'index.lock'), { force: true });
  // pathspec excludes, not ignore files: a repo's .gitignore can't override them
  let links: string[];
  try {
    // a hook scans a bounded number of new entries; the background worker
    // taking a big project's first snapshot gets room for the whole tree
    links = linkedDirs(p, process.platform, opts.background ? 5_000_000 : 100_000);
  } catch (e) {
    if (e instanceof ScanTooLarge && first && !opts.background) throw new BaselinePending('the first snapshot of this large project goes on in the background');
    if (e instanceof SnapshotSkipped) fs.writeFileSync(pausedFile(p), JSON.stringify({ at: Date.now(), reason: e.message }));
    throw e;
  }
  // Zerostel's own store, if it sits inside the project, is never part of a snapshot
  const own = storeInProject(p);
  if (own) links.push(own);
  if (links.length) git(p.repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...links]);
  // a pattern added to config.json later also drops what earlier snapshots already held
  if (p.config.exclude.length) git(p.repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...p.config.exclude.map((g) => `:(glob)${g}`)], { magic: true });
  // with --ignore-errors git still copies what it can; remember what it couldn't
  let incomplete: string | undefined;
  const onFail = (e: { stderr: string }) => {
    incomplete ??= e.stderr.split('\n').find((l) => /^(error|fatal):/.test(l))?.trim() ?? 'git add failed';
  };
  try {
    const large = largeNewFiles(p, links);
    if (large.length) noteSkipped(p, large);
    const skip = [...[...links, ...large].map(exclude), ...userExcludes(p)];
    if (first && !stageRemaining(p, skip, Date.now() + (opts.firstBudgetMs ?? FIRST_SNAPSHOT_MS), opts.chunk ?? CHUNK, onFail)) {
      throw new BaselinePending('the first snapshot of this project is still being taken');
    }
    git(p.repo, ['add', '-A', '--ignore-errors', '--', '.', ...skip], { allowFail: true, onFail, magic: true, timeoutMs: p.config.snapshotTimeoutSec * 1000 });
  } catch (e) {
    if (!(e instanceof GitError && e.timedOut)) throw e;
    const reason = `snapshotting took longer than ${p.config.snapshotTimeoutSec}s; the project may be too large (add big folders to .gitignore)`;
    fs.writeFileSync(pausedFile(p), JSON.stringify({ at: Date.now(), reason }));
    fs.rmSync(path.join(p.repo.gitDir, 'index.lock'), { force: true });
    throw new SnapshotSkipped(reason);
  }
  addSmallIgnored(p, links);
  const tree = git(p.repo, ['write-tree']).trim();
  const parent = head(p);
  if (parent) {
    const parentTree = git(p.repo, ['rev-parse', `${parent}^{tree}`]).trim();
    if (parentTree === tree) return { sha: parent, created: false, incomplete };
  }
  const args = ['commit-tree', tree, '-m', message || 'snapshot'];
  if (parent) args.push('-p', parent);
  const sha = git(p.repo, args).trim();
  git(p.repo, ['update-ref', 'HEAD', sha]);
  return { sha, created: true, incomplete };
}

export function snapshot(p: Project, message: string, opts: SnapshotOptions = {}): Snap {
  // Hooks queue for the lock even while a worker takes the first snapshot: on
  // a small project it finishes while they wait, and the step about to run
  // (an rm -rf, say) is then snapshotted before it, not skipped.
  return withLock(lockFile(p), () => snapshotUnlocked(p, message, opts));
}

export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'T';
  added: number;
  deleted: number;
  binary: boolean;
}

export function changes(p: Project, from: string | null, to: string): FileChange[] {
  return changesIn(p.repo, from, to);
}

/** Files that differ between two snapshots of any snapshot repo. */
export function changesIn(repo: GitRepo, from: string | null, to: string): FileChange[] {
  const a = assertRev(from ?? EMPTY_TREE);
  assertRev(to);
  if (a === to) return [];
  const names = git(repo, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, to]).split('\0');
  const byPath = new Map<string, FileChange>();
  for (let i = 0; i + 1 < names.length; i += 2) {
    const status = names[i]!.charAt(0) as FileChange['status'];
    const file = names[i + 1]!;
    byPath.set(file, { path: file, status, added: 0, deleted: 0, binary: false });
  }
  const nums = git(repo, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', a, to]).split('\0');
  for (const line of nums) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(line);
    if (!m) continue;
    const c = byPath.get(m[3]!);
    if (!c) continue;
    c.binary = m[1] === '-';
    c.added = c.binary ? 0 : Number(m[1]);
    c.deleted = c.binary ? 0 : Number(m[2]);
  }
  return [...byPath.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

export function diffText(p: Project, from: string | null, to: string, paths: string[] = []): string {
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', assertRev(from ?? EMPTY_TREE), assertRev(to)];
  if (paths.length) args.push('--', ...paths);
  return git(p.repo, args);
}

export function revExists(p: Project, rev: string): boolean {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(rev)) return false;
  if (!fs.existsSync(path.join(p.repo.gitDir, 'HEAD'))) return false;
  return git(p.repo, ['rev-parse', '-q', '--verify', `${rev}^{commit}`], { allowFail: true }).trim() !== '';
}

export interface RestoreResult {
  from: string; // snapshot of the state right before restoring
  to: string;
  created: string[];
  modified: string[];
  deleted: string[];
  failed: { path: string; error: string }[];
  dryRun: boolean;
}

function underAny(rel: string, only: string[]): boolean {
  return only.some((o) => rel === o || rel.startsWith(o.endsWith('/') ? o : o + '/'));
}

// ---- restore ----
//
// The project is untrusted: an agent (or a cloned repo) can leave symlinks,
// junctions and ignored folders anywhere. Restoring must never touch a path
// outside the project and never delete anything the pre-restore snapshot
// doesn't hold a copy of, so a rewind can always be undone.

/** A repo-relative path from git that is safe to join onto the project root. */
export function validRel(rel: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !(platform === 'win32' && /[\\:]/.test(part)));
}

/**
 * The first parent of `rel` (walking down from the root) that isn't a real
 * directory: a symlink, a junction, or a file. Null when every existing
 * parent is a plain directory.
 */
export function blockingParent(root: string, rel: string): string | null {
  const parts = rel.split('/');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]!);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return null; // missing: nothing further down exists either
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return parts.slice(0, i + 1).join('/');
  }
  return null;
}

/** True when every file under `relDir` is in `kept`, so removing it loses nothing. */
function fullyBackedUp(root: string, relDir: string, kept: Set<string>, budget = { left: 50_000 }): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (--budget.left < 0) return false;
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory() && !e.isSymbolicLink()) {
      if (!fullyBackedUp(root, rel, kept, budget)) return false;
    } else if (!kept.has(rel)) return false;
  }
  return true;
}

function removeEmptyParents(root: string, rel: string): void {
  const parts = rel.split('/').slice(0, -1);
  while (parts.length) {
    const dir = path.join(root, ...parts);
    try {
      if (fs.lstatSync(dir).isSymbolicLink() || fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    parts.pop();
  }
}

/** Files whose content on disk differs from the copy staged in the shadow index. */
function changedOnDisk(p: Project): Set<string> {
  // re-read files whose timestamps changed, so only real content changes count
  git(p.repo, ['update-index', '-q', '--refresh'], { allowFail: true });
  return new Set(git(p.repo, ['diff-files', '--name-only', '-z']).split('\0').filter(Boolean));
}

export function trackedPaths(p: Project, rev: string): Set<string> {
  return new Set(git(p.repo, ['ls-tree', '-r', '-z', '--name-only', assertRev(rev)]).split('\0').filter(Boolean));
}

/**
 * Put the working tree back to snapshot `target`. Always snapshots the
 * current state first, so a restore can itself be undone.
 */
export function restore(p: Project, target: string, opts: { only?: string[]; dryRun?: boolean } = {}): RestoreResult {
  assertRev(target);
  return withLock(lockFile(p), () => {
    const current = snapshotUnlocked(p, `before restore to ${target.slice(0, 10)}`).sha;
    const own = storeInProject(p);
    let diff = changes(p, current, target);
    // snapshots taken before the store was left out may hold it; never write into it
    if (own) diff = diff.filter((c) => !underAny(c.path, [own]));
    if (opts.only?.length) diff = diff.filter((c) => underAny(c.path, opts.only!));
    const res: RestoreResult = { from: current, to: target, created: [], modified: [], deleted: [], failed: [], dryRun: !!opts.dryRun };
    const root = path.resolve(p.root);
    const skip = (rel: string, error: string) => res.failed.push({ path: rel, error });
    // What the snapshot just taken really holds a copy of: in it, and the
    // same on disk. git can fail on single files (unreadable, locked by
    // another program, a full disk) and keep an older copy; nothing that
    // isn't backed up exactly is ever deleted or overwritten.
    const unsaved = changedOnDisk(p);
    const kept = new Set([...trackedPaths(p, current)].filter((x) => !unsaved.has(x)));
    for (const c of diff) {
      if (!validRel(c.path)) {
        skip(c.path, 'unsafe path, skipped');
        continue;
      }
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(path.join(root, c.path));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          skip(c.path, `couldn't check what's there now (${code}); left alone`);
          continue;
        }
        // nothing there to lose
      }
      if (st && !st.isDirectory() && !kept.has(c.path)) {
        skip(c.path, unsaved.has(c.path) ? "changed since Zerostel could last copy it (locked or unreadable?); left alone" : "Zerostel has no copy of what's there now (excluded, too large or ignored); left alone");
        continue;
      }
      if (c.status === 'A') res.created.push(c.path);
      else if (c.status === 'D') res.deleted.push(c.path);
      else res.modified.push(c.path);
    }
    if (opts.dryRun) return res;

    for (const rel of res.deleted) {
      if (blockingParent(root, rel)) {
        skip(rel, 'a parent folder is a symlink or file now; left alone');
        continue;
      }
      const abs = path.join(root, rel);
      try {
        if (fs.lstatSync(abs).isDirectory()) {
          skip(rel, 'is a folder now; left alone');
          continue;
        }
        fs.unlinkSync(abs);
        removeEmptyParents(root, rel);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') skip(rel, (e as Error).message);
      }
    }

    const write: string[] = [];
    for (const rel of [...res.created, ...res.modified]) {
      // something in the way: a symlink or file where the target has a folder
      const parent = blockingParent(root, rel);
      if (parent) {
        if (!kept.has(parent)) {
          skip(rel, `${parent} is in the way and Zerostel has no copy of it; move it and try again`);
          continue;
        }
        try {
          fs.unlinkSync(path.join(root, parent));
        } catch (e) {
          skip(rel, (e as Error).message);
          continue;
        }
      }
      // a folder (or link) where the target has a file
      const abs = path.join(root, rel);
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(abs);
      } catch {
        // doesn't exist yet
      }
      if (st?.isSymbolicLink()) {
        if (!kept.has(rel)) {
          skip(rel, 'a symlink Zerostel has no copy of is in the way; move it and try again');
          continue;
        }
        fs.unlinkSync(abs);
      } else if (st?.isDirectory()) {
        if (!fullyBackedUp(root, rel, kept)) {
          skip(rel, 'a folder with files Zerostel has no copy of is in the way; move it and try again');
          continue;
        }
        fs.rmSync(abs, { recursive: true, force: true });
      }
      write.push(rel);
    }

    if (write.length) {
      try {
        git(p.repo, ['checkout', target, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: write.join('\0') });
      } catch {
        // fall back to one file at a time so one locked file doesn't stop the rest
        for (const rel of write) {
          try {
            git(p.repo, ['checkout', target, '--', rel]);
          } catch (e) {
            skip(rel, (e as Error).message.split('\n')[0]!);
          }
        }
      }
    }
    const failed = new Set(res.failed.map((f) => f.path));
    res.created = res.created.filter((x) => !failed.has(x));
    res.modified = res.modified.filter((x) => !failed.has(x));
    res.deleted = res.deleted.filter((x) => !failed.has(x));
    return res;
  });
}

export function repoSize(p: Project): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else
        try {
          total += fs.statSync(f).size;
        } catch {
          // gone
        }
    }
  };
  walk(p.dir);
  return total;
}

/**
 * commit-tree never triggers git's automatic gc, so loose objects would pile
 * up forever. `gc --auto` is a no-op until there are a few thousand of them.
 */
export function maintain(p: Project): void {
  withLock(lockFile(p), () => {
    git(p.repo, ['gc', '--auto', '--quiet'], { allowFail: true });
  });
}

// ---- coverage: what a rewind can't bring back ----

function skippedFile(p: Project): string {
  return path.join(p.dir, 'skipped.json');
}

/** Remember new files left out for size, so log, doctor and reports can say so. */
function noteSkipped(p: Project, files: string[]): void {
  let known: string[] = [];
  try {
    known = JSON.parse(fs.readFileSync(skippedFile(p), 'utf8')) as string[];
  } catch {
    // first one
  }
  const next = [...new Set([...known, ...files])].slice(-200);
  if (next.length !== known.length) fs.writeFileSync(skippedFile(p), JSON.stringify(next));
}

export interface Coverage {
  nested: string[]; // folders with their own .git: only a pointer is stored, not their files
  ignoredDirs: string[]; // folders .gitignore leaves out (minus dependency folders)
  tooLarge: string[]; // new files over maxFileMB that were left out
}

const DEPENDENCY_DIR = /(^|\/)(node_modules|bower_components|jspm_packages|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.next|\.nuxt|\.svelte-kit|\.turbo|\.parcel-cache|\.angular|\.vite|\.gradle|\.terraform|\.dart_tool|Pods|DerivedData|\.git)\/$/;

/**
 * Computed on demand (log, doctor, report), never in a hook: listing the
 * tree is proportional to the project size. Cached per snapshot.
 */
export function coverage(p: Project): Coverage {
  const tip = fs.existsSync(path.join(p.repo.gitDir, 'HEAD')) ? head(p) : null;
  let tooLarge: string[] = [];
  try {
    tooLarge = (JSON.parse(fs.readFileSync(skippedFile(p), 'utf8')) as string[]).filter((f) => fs.existsSync(path.join(p.root, f)));
  } catch {
    // none recorded
  }
  if (!tip) return { nested: [], ignoredDirs: [], tooLarge };
  const cacheFile = path.join(p.dir, 'coverage.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Coverage & { head: string };
    if (cached.head === tip) return { nested: cached.nested, ignoredDirs: cached.ignoredDirs, tooLarge };
  } catch {
    // not cached yet
  }
  const nested: string[] = [];
  for (const line of git(p.repo, ['ls-tree', '-r', '-z', tip]).split('\0')) {
    const m = /^160000 commit [0-9a-f]+\t(.+)$/.exec(line);
    if (m) nested.push(m[1]!);
  }
  const ignoredDirs = fs.existsSync(p.root)
    ? git(p.repo, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'], { allowFail: true })
        .split('\0')
        .filter((e) => e.endsWith('/') && !DEPENDENCY_DIR.test(e))
        .slice(0, 50)
    : [];
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ head: tip, nested, ignoredDirs }));
  } catch {
    // read-only data dir; just don't cache
  }
  return { nested, ignoredDirs, tooLarge };
}

/** One line for humans, or null when everything is covered. */
export function coverageNote(c: Coverage): string | null {
  const parts: string[] = [];
  if (c.nested.length) parts.push(`nested git repos (${c.nested.slice(0, 3).join(', ')}${c.nested.length > 3 ? ', …' : ''})`);
  if (c.ignoredDirs.length) parts.push(`ignored folders (${c.ignoredDirs.slice(0, 3).join(', ')}${c.ignoredDirs.length > 3 ? ', …' : ''})`);
  if (c.tooLarge.length) parts.push(`${c.tooLarge.length} file(s) over the size limit (${c.tooLarge.slice(0, 2).join(', ')}${c.tooLarge.length > 2 ? ', …' : ''})`);
  return parts.length ? `Not snapshotted, so a rewind can't bring them back: ${parts.join('; ')}` : null;
}
