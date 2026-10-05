import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv, findExecutable, isBatch, neutralCwd } from './exec.js';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

export interface GitRepo {
  gitDir: string;
  workTree: string;
  emptyConfig: string; // stands in for the user's global git config
}

// The shadow repo must not pick up the user's global or system git config:
// hooks, gpg signing, autocrlf, LFS filters or fsmonitor would all change
// what we store or slow every snapshot down.
function env(repo: GitRepo, magic: boolean): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('GIT_')) e[k] = v;
  return {
    ...e,
    GIT_DIR: repo.gitDir,
    GIT_WORK_TREE: repo.workTree,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: repo.emptyConfig,
    GIT_AUTHOR_NAME: 'Zerostel',
    GIT_AUTHOR_EMAIL: 'zerostel@localhost',
    GIT_COMMITTER_NAME: 'Zerostel',
    GIT_COMMITTER_EMAIL: 'zerostel@localhost',
    GIT_TERMINAL_PROMPT: '0',
    // file names from the project are data: a file called `*` or `:(top)`
    // must not turn into a pattern that matches everything
    // (magic: true only for calls that pass our own :(exclude,literal) specs)
    GIT_LITERAL_PATHSPECS: magic ? '0' : '1',
    // never prompt for or run anything on behalf of the shadow repo
    GIT_ASKPASS: '',
    GIT_EDITOR: ':',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    // a second line of defence if anything below git starts a program by name
    ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}),
  };
}

export interface RunOpts {
  input?: string | Buffer;
  allowFail?: boolean;
  /** with allowFail: told when git exits non-zero anyway */
  onFail?: (e: { code: number | null; stderr: string }) => void;
  maxBuffer?: number;
  magic?: boolean; // allow pathspec magic; every path must then be wrapped with exclude()
  timeoutMs?: number;
}

export function git(repo: GitRepo, args: string[], opts: RunOpts = {}): string {
  return gitBuf(repo, args, opts).toString('utf8');
}

/**
 * git by absolute path. The work tree is the user's project, and a bare
 * `git` would let a git.exe sitting in that project run instead (Windows
 * looks in the current directory first). Batch files are refused: their
 * arguments would go through cmd.exe.
 */
export function gitPath(): string | null {
  const found = findExecutable('git');
  return found && !isBatch(found) ? found : null;
}

export function gitBuf(repo: GitRepo, args: string[], opts: RunOpts = {}): Buffer {
  const exe = gitPath();
  if (!exe) throw new GitError('git was not found on PATH', '', null);
  const r = spawnSync(exe, args, {
    cwd: repo.workTree,
    env: env(repo, !!opts.magic),
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
    timeout: opts.timeoutMs,
    windowsHide: true,
  });
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    throw new GitError(timedOut ? `git ${args[0]} took longer than ${opts.timeoutMs}ms` : `git ${args[0]} failed: ${r.error.message}`, '', null, timedOut);
  }
  if (r.status !== 0 && opts.allowFail) opts.onFail?.({ code: r.status, stderr: r.stderr?.toString('utf8') ?? '' });
  if (r.status !== 0 && !opts.allowFail) {
    const stderr = r.stderr?.toString('utf8') ?? '';
    throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim().split('\n')[0]}`, stderr, r.status);
  }
  return r.stdout ?? Buffer.alloc(0);
}

let gitChecked: string | null | undefined;

/** Installed git version, or null when git is missing. */
export function gitVersion(): string | null {
  if (gitChecked !== undefined) return gitChecked;
  const exe = gitPath();
  if (!exe) return (gitChecked = null);
  const r = spawnSync(exe, ['--version'], { windowsHide: true, cwd: neutralCwd(), env: childEnv() });
  gitChecked = r.status === 0 ? r.stdout.toString().trim().replace(/^git version /, '') : null;
  return gitChecked;
}

/** Nearest directory at or above `dir` that has a .git entry, or null. */
export function findGitRoot(dir: string): string | null {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Pathspec that leaves `rel` out; only valid with { magic: true }. */
export function exclude(rel: string): string {
  return `:(exclude,literal)${rel}`;
}
