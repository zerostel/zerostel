import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { findGitRoot, type GitRepo } from '../util/git.js';
import { ensurePrivateDir, type Ctx } from '../util/paths.js';

export interface Project {
  root: string; // the user's project directory (the shadow repo's work tree)
  id: string;
  dir: string; // ~/.zerostel/projects/<id>
  repo: GitRepo;
  config: Config;
  snapshotProblem?: string;
}

// The real path decides the project: realpath gives the spelling the file
// system actually uses, so /tmp/Repo and /tmp/repo stay apart on a
// case-sensitive macOS volume and match on a case-insensitive one. Only
// Windows, where folders are effectively always case-insensitive, also
// folds case so `D:\Proj` and `d:\proj` agree when realpath can't run.
function key(root: string, platform: NodeJS.Platform): string {
  let p = path.resolve(root);
  try {
    p = fs.realpathSync.native(p);
  } catch {
    // folder moved or deleted; use the path as given
  }
  p = p.replace(/\\/g, '/').replace(/\/$/, '');
  return platform === 'win32' ? p.toLowerCase() : p;
}

export function projectRoot(cwd: string): string {
  return findGitRoot(cwd) ?? path.resolve(cwd);
}

export function openProject(cwd: string, ctx: Ctx): Project {
  ensurePrivateDir(ctx.dataDir, ctx.platform);
  const root = projectRoot(cwd);
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || 'root';
  const hash = crypto.createHash('sha1').update(key(root, ctx.platform)).digest('hex').slice(0, 8);
  const id = `${slug}-${hash}`;
  const dir = path.join(ctx.dataDir, 'projects', id);
  const loaded = loadConfig(ctx);
  const project: Project = {
    root,
    id,
    dir,
    repo: { gitDir: path.join(dir, 'snapshots.git'), workTree: root, emptyConfig: path.join(ctx.dataDir, 'empty.gitconfig') },
    config: loaded.config,
    snapshotProblem: loaded.snapshotProblem,
  };
  assertProjectIdentity(project, ctx.platform);
  return project;
}

/** The short display id is not enough to establish ownership of stored data. */
export function assertProjectIdentity(p: Pick<Project, 'root' | 'dir'>, platform: NodeJS.Platform = process.platform): void {
  let text: string;
  try {
    text = fs.readFileSync(path.join(p.dir, 'project.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const meta: unknown = JSON.parse(text);
  if (!meta || typeof meta !== 'object' || typeof (meta as { root?: unknown }).root !== 'string') throw new Error('project store metadata has no valid root; refusing to use it');
  if (key((meta as { root: string }).root, platform) !== key(p.root, platform)) throw new Error('project store belongs to a different root; refusing to mix snapshots or sessions');
}

/**
 * Snapshotting a whole home directory or drive would copy far too much, so
 * agents started there only get a timeline, no snapshots.
 */
export function unsafeRoot(root: string, ctx: Ctx): string | null {
  const r = key(root, ctx.platform);
  if (r === key(ctx.home, ctx.platform)) return 'the home directory';
  if (path.parse(path.resolve(root)).root.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === r.toLowerCase() || r === '') return 'a drive or filesystem root';
  return null;
}

export interface ProjectInfo {
  id: string;
  root: string;
  dir: string;
}

export function listProjects(ctx: Ctx): ProjectInfo[] {
  const base = path.join(ctx.dataDir, 'projects');
  if (!fs.existsSync(base)) return [];
  const out: ProjectInfo[] = [];
  for (const id of fs.readdirSync(base)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(base, id, 'project.json'), 'utf8')) as { root: string };
      out.push({ id, root: meta.root, dir: path.join(base, id) });
    } catch {
      // half-created project dir; ignore
    }
  }
  return out;
}

export function writeProjectMeta(p: Project): void {
  assertProjectIdentity(p);
  const file = path.join(p.dir, 'project.json');
  if (fs.existsSync(file)) return;
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ root: p.root, createdAt: new Date().toISOString() }, null, 2));
}
