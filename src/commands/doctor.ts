import { spawnSync } from 'node:child_process';
import { childEnv, comspec, findExecutable, isBatch, neutralCwd } from '../util/exec.js';
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS } from '../agents/adapters.js';
import { configPath, loadConfig } from '../config.js';
import { agentPresent, hookStatus, launch } from '../install.js';
import { listProjects, openProject, unsafeRoot } from '../store/project.js';
import { verify } from '../store/audit.js';
import { watched } from '../store/home.js';
import { listSessions } from '../store/session.js';
import { guardrailsSummary } from './trust.js';
import { coverage, coverageNote, repoSize, snapshotsPaused } from '../store/shadow.js';
import { gitVersion } from '../util/git.js';
import { tilde, type Ctx } from '../util/paths.js';
import { STANDALONE, VERSION } from '../version.js';

export type Level = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  area: string;
  level: Level;
  message: string;
  fix?: string;
}

function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = min.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]!;
  }
  return true;
}

/** Known runtime security baselines; distro Git versions may contain backports. */
export function runtimeSecurityChecks(node: string, git: string | null, platform: NodeJS.Platform): Check[] {
  const out: Check[] = [];
  const major = Number(node.replace(/^v/, '').split('.')[0]);
  const version = node.replace(/^v/, '');
  if ((major >= 20 && major < 22) || major === 23 || major === 25) {
    out.push({ area: 'node', level: 'warn', message: `Node ${node} is end-of-life`, fix: 'use the latest supported Node 22 or 24 LTS release: https://nodejs.org/en/about/previous-releases' });
  } else if ((major === 22 && !versionAtLeast(version, '22.23.2')) || (major === 24 && !versionAtLeast(version, '24.18.1')) || (major === 26 && !versionAtLeast(version, '26.5.1'))) {
    out.push({ area: 'node', level: 'warn', message: `Node ${node} predates the July 2026 security fixes`, fix: 'update to the latest supported LTS release: https://nodejs.org/en/blog/vulnerability/july-2026-security-releases' });
  }
  if (platform === 'win32' && git && /\.windows\./.test(git)) {
    const [gitMajor, minor, patch] = git.split('.').map(Number);
    const minimum: Record<number, number> = { 43: 7, 44: 4, 45: 4, 46: 4, 47: 3, 48: 2, 49: 1, 50: 1 };
    if (gitMajor === 2 && minor !== undefined && patch !== undefined && (minor < 43 || (minimum[minor] !== undefined && patch < minimum[minor]!))) {
      out.push({ area: 'git-security', level: 'warn', message: `Git for Windows ${git} is affected by CVE-2025-48384; untrusted recursive submodule clones can execute code`, fix: 'update Git for Windows: https://github.com/git/git/security/advisories/GHSA-vwqx-4fm8-6qc9' });
    }
    const build = Number(/\.windows\.(\d+)/.exec(git)?.[1] ?? 0);
    if (!versionAtLeast(git, '2.53.0') || (gitMajor === 2 && minor === 53 && patch === 0 && build < 3)) {
      const cves = gitMajor === 2 && minor === 53 && patch === 0 && build === 2 ? 'CVE-2026-32631' : 'CVE-2025-66413 and CVE-2026-32631';
      out.push({ area: 'git-security', level: 'warn', message: `Git for Windows ${git} predates the NTLM credential leak fixes (${cves})`, fix: 'update to the latest Git for Windows release: https://github.com/git-for-windows/git/security/advisories/GHSA-9j5h-h4m7-85hx' });
    }
  }
  return out;
}

// Agents are often installed as .cmd shims on Windows. Resolve them on PATH
// ourselves (never the current directory, which may be an untrusted repo)
// and start them from a neutral folder.
function toolVersion(cmd: string, args: string[]): string | null {
  const exe = findExecutable(cmd);
  if (!exe) return null;
  const opts = { encoding: 'utf8' as const, timeout: 10_000, windowsHide: true, cwd: neutralCwd(), env: childEnv() };
  const r = isBatch(exe)
    ? spawnSync(comspec(), ['/d', '/s', '/c', `""${exe}" ${args.join(' ')}"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(exe, args, opts);
  if (r.status !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr)?.[1] ?? null;
}

// What each agent needs for Zerostel's hooks to work, from each agent's own hook documentation
const AGENT_MIN: Record<string, { cmd: string; min: string; why: string }> = {
  'claude-code': { cmd: 'claude', min: process.platform === 'win32' ? '2.1.139' : '2.0.0', why: process.platform === 'win32' ? 'hooks in exec form (Windows)' : 'hooks' },
  codex: { cmd: 'codex', min: '0.124.0', why: 'stable hooks' },
};

export function runDoctor(ctx: Ctx, opts: { agentVersions?: boolean } = {}): Check[] {
  const checks: Check[] = [];
  const add = (area: string, level: Level, message: string, fix?: string) => checks.push({ area, level, message, fix });

  add('zerostel', 'info', `${VERSION} on ${process.platform} ${process.arch}, node ${process.version}${STANDALONE ? ' (built in)' : ''}`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) add('node', 'fail', `Node ${process.version} is too old`, 'install Node 20 or newer');

  const g = gitVersion();
  if (!g) add('git', 'fail', 'git not found on PATH; snapshots need it', 'install git from https://git-scm.com');
  else if (!versionAtLeast(g, '2.25.0')) add('git', 'fail', `git ${g} is too old (needs 2.25+)`, 'update git');
  else add('git', 'ok', `git ${g}`);
  // the standalone executable carries its own Node: a newer Zerostel is the fix
  checks.push(...runtimeSecurityChecks(process.version, g, ctx.platform).map((c) => (STANDALONE && c.area === 'node' ? { ...c, message: `the built-in ${c.message}`, fix: 'update Zerostel; each release ships the latest Node security fixes' } : c)));

  // the copy hooks run, and whether it matches this CLI
  const l = launch(ctx);
  if (fs.existsSync(l.args[0] ?? l.exe)) {
    const r = spawnSync(l.exe, [...l.args, '--version'], { encoding: 'utf8', timeout: 10_000, cwd: neutralCwd(), env: childEnv() });
    const v = r.stdout.trim();
    if (v && v !== VERSION) add('hooks', 'warn', `hooks run zerostel ${v}, this is ${VERSION}`, 'run `zerostel install` to update them');
  }

  for (const a of ADAPTERS) {
    const st = hookStatus(ctx, a);
    const file = tilde(a.configFile(ctx), ctx.home);
    if (st.installed) {
      if (st.disabled) add(a.name, 'warn', `hooks are disabled in ${file}`, 'remove "disableAllHooks" from that file');
      else if (!st.healthy) add(a.name, 'fail', `hook command points at a missing file (${st.command})`, 'run `zerostel install` again');
      else add(a.name, 'ok', `recording${a.experimental ? ' (experimental)' : ''} · ${file}`);
    } else if (agentPresent(ctx, a)) add(a.name, a.experimental ? 'info' : 'warn', 'found but not recording', `zerostel install --agent ${a.id}`);
    const need = AGENT_MIN[a.id];
    if (need && opts.agentVersions !== false && (st.installed || agentPresent(ctx, a))) {
      const v = toolVersion(need.cmd, ['--version']);
      if (v && !versionAtLeast(v, need.min)) add(a.name, 'warn', `${a.name} ${v} is older than ${need.min}, needed for ${need.why}`, `update ${a.name}`);
      else if (v) add(a.name, 'info', `${a.name} ${v}`);
    }
  }
  if (hookStatus(ctx, ADAPTERS.find((a) => a.id === 'codex')!).installed) {
    add('Codex', 'info', 'Codex runs new or changed hooks only after you approve them with /hooks inside Codex');
  }

  const { problems } = loadConfig(ctx);
  for (const pr of problems) add('config', 'warn', `${tilde(configPath(ctx), ctx.home)}: ${pr}`);

  if (fs.existsSync(ctx.dataDir) && process.platform !== 'win32') {
    const mode = fs.statSync(ctx.dataDir).mode & 0o777;
    if (mode & 0o077) add('data', 'warn', `${tilde(ctx.dataDir, ctx.home)} is readable by other users (${mode.toString(8)})`, `chmod 700 ${tilde(ctx.dataDir, ctx.home)}`);
  }
  const projects = listProjects(ctx);
  const total = projects.reduce((n, pr) => n + repoSize({ dir: pr.dir } as never), 0);
  add('data', 'info', `${tilde(ctx.dataDir, ctx.home)} · ${projects.length} project(s) · ${(total / 1024 / 1024).toFixed(1)} MB`);

  const errFile = path.join(ctx.dataDir, 'errors.log');
  if (fs.existsSync(errFile)) {
    const lines = fs.readFileSync(errFile, 'utf8').trim().split('\n').filter((l) => /^\d{4}-/.test(l));
    const recent = lines.filter((l) => Date.now() - Date.parse(l.slice(0, 24)) < 7 * 86_400_000);
    if (recent.length) add('errors', 'warn', `${recent.length} hook error(s) in the last 7 days; latest: ${recent[recent.length - 1]!.slice(0, 200)}`, `see ${tilde(errFile, ctx.home)}`);
  }

  const p = openProject(ctx.cwd, ctx);
  const why = unsafeRoot(p.root, ctx);
  if (why) add('project', 'warn', `${tilde(p.root, ctx.home)} is ${why}: timeline only, no snapshots`, 'run agents inside a project folder');
  else add('project', 'info', `${tilde(p.root, ctx.home)} · ${listSessions(p).length} session(s)`);
  if (!why) {
    const gaps = coverageNote(coverage(p));
    if (gaps) add('project', 'info', gaps, 'fine for build output; anything you need back must not be in .gitignore, and nested repos need their own commits (README → Limits)');
  }
  const paused = snapshotsPaused(p);
  if (paused) add('project', 'warn', `snapshots paused: ${paused}`, 'add large folders to .gitignore or "exclude" in config.json');
  const latest = listSessions(p)[0];
  if (latest) {
    const v = verify(latest.file);
    if (!v.ok) add('audit', 'warn', `latest session log doesn't verify: ${v.problems[0]}`, 'zerostel verify shows every problem');
    else if (v.head) add('audit', 'ok', `latest session log intact (${v.events} events)`);
  }
  const { config: cfg } = loadConfig(ctx);
  const w = watched(ctx, cfg.watch);
  if (cfg.watch.length) add('watch', w.length === cfg.watch.length ? 'ok' : 'warn', `${w.length} file${w.length === 1 ? '' : 's'} outside projects snapshotted with them${w.length === cfg.watch.length ? '' : ` (${cfg.watch.length - w.length} ignored: only files under your home folder, not ~/.zerostel)`}`);
  const guard = guardrailsSummary(ctx);
  add('guardrails', guard.level, guard.text, guard.level === 'warn' ? 'fix ~/.zerostel/policy.json; until then tool calls are recorded but not checked' : undefined);
  return checks;
}
