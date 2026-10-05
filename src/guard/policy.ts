import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../util/paths.js';

// Guardrails: rules you write in ~/.zerostel/policy.json that stop a tool
// call before it runs, or make the agent ask you first. They match file
// paths, shell commands and tool names. They're a seatbelt against mistakes,
// not a sandbox: a command can reach a file without naming it, and the agent
// can't be stopped from doing what your own account is allowed to do.

export type Action = 'deny' | 'ask';

export interface Rule {
  action: Action;
  /** globs; `~/` is your home folder, other relative globs start at the project root */
  paths?: string[];
  /** globs over each part of a shell command (split at &&, ||, ;, | and newlines); `*` matches anything */
  commands?: string[];
  /** globs over tool names, e.g. "WebFetch" or "mcp__github__delete_*" */
  tools?: string[];
  /** "write": paths only count for tools that can change files (default: any access) */
  access?: 'write' | 'any';
  reason?: string;
}

export interface Policy {
  rules: Rule[];
}

/**
 * Rules name the usual folders (~/.zerostel, ~/.claude...). When an environment
 * variable such as ZEROSTEL_DIR or CLAUDE_CONFIG_DIR has moved one, each such
 * path also covers the folder in use. Rule numbers stay the same.
 */
export function withMovedFolders(policy: Policy, moved: [string, string][], home: string): Policy {
  const homeNorm = norm(home);
  // compared exactly: on Linux a folder that differs only in case is another folder
  const live = moved.filter(([from, to]) => norm(to) !== homeNorm + from.slice(1));
  if (!live.length) return policy;
  return {
    rules: policy.rules.map((r) => {
      if (!r.paths) return r;
      const extra: string[] = [];
      for (const p of r.paths) {
        const pat = p.replace(/\\/g, '/');
        for (const [from, to] of live) if (pat === from || pat.startsWith(from + '/')) extra.push(norm(to) + pat.slice(from.length));
      }
      return extra.length ? { ...r, paths: [...r.paths, ...extra] } : r;
    }),
  };
}

export interface Decision {
  action: Action;
  reason: string;
  /** index of the rule in policy.json */
  rule: number;
}

export interface Call {
  tool: string;
  /** paths the tool input names, as given (relative ones are resolved against cwd) */
  paths: string[];
  command?: string;
  writes: boolean;
  root: string;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  /** set when the call names more than the guard checks at once: then no rule matching isn't a pass */
  incomplete?: string;
}

/**
 * How much of a tool call the rules look at. Anything past these limits is
 * not silently let through: the call is asked about (or blocked, where the
 * agent can't ask) as one that couldn't be checked in full.
 */
export const LIMITS = { paths: 1_000, pathLength: 32_768, command: 262_144 };

export function policyPath(ctx: Pick<Ctx, 'dataDir'>): string {
  return path.join(ctx.dataDir, 'policy.json');
}

/** A starting point for `zerostel policy init`; edit it to taste. */
export const STARTER: Policy = {
  rules: [
    {
      action: 'deny',
      paths: ['~/.ssh/**', '~/.aws/**', '~/.gnupg/**', '~/.kube/**', '~/.config/gcloud/**', '~/.zerostel/**'],
      reason: "credentials, and Zerostel's own records, are off limits",
    },
    { action: 'ask', paths: ['**/.env', '**/.env.*'], access: 'write', reason: 'changes a .env file' },
    // zero trust includes the recorder: an agent shouldn't switch it off on its own. These
    // match text, so they slow that down rather than prevent it; hooks removed
    // anyway are noticed by the next hook call and written into the log.
    {
      action: 'ask',
      commands: ['*zerostel* uninstall*', '*zerostel* prune*', '*zerostel* policy init*'],
      reason: 'turns Zerostel off, deletes its records or replaces your rules',
    },
    {
      action: 'ask',
      paths: [
        '~/.claude/settings*.json', '~/.codex/hooks.json', '~/.codex/config.toml', '~/.cursor/hooks.json',
        '~/.gemini/settings.json', '~/.gemini/config/hooks.json', '~/.gemini/antigravity-cli/settings.json',
        '~/.copilot/hooks/**', '~/.copilot/settings.json', '~/.config/opencode/plugin*/**', '~/.dsh/cordis.patch.yml', '~/.dsh/profiles/*/cordis.patch.yml',
        // the same files inside the project, where they apply to it alone
        '**/.claude/settings*.json', '**/.codex/hooks.json', '**/.codex/config.toml', '**/.cursor/hooks.json',
        '**/.gemini/settings.json', '**/.agents/hooks.json', '**/.github/hooks/**', '**/.github/copilot/settings*.json', '**/.opencode/plugin*/**',
      ],
      access: 'write',
      reason: "changes an agent's hook settings, which is where Zerostel is switched on",
    },
    {
      action: 'ask',
      commands: ['git push --force*', 'git push -f*', 'git push * --force*', 'git push * -f*', 'git reset --hard*', 'git clean -*f*', 'git branch -D *', '* --no-verify*'],
      reason: 'rewrites or throws away git history',
    },
    // what a rewind can't take back: ask first
    {
      action: 'ask',
      commands: ['sudo *', 'su *', 'doas *', 'runas *', '*Start-Process*-Verb RunAs*'],
      reason: 'runs as administrator; Zerostel can only rewind your own files',
    },
    {
      action: 'ask',
      commands: [
        'npm install -g*', 'npm i -g*', 'npm install --global*', 'npm i --global*', 'npm * -g', 'npm * -g *', 'npm * --global*',
        'pnpm add -g*', 'pnpm add --global*', 'yarn global *', 'bun add -g*', 'bun install -g*',
        'pip install --user*', 'pip3 install --user*', 'pipx install *', 'cargo install *', 'go install *',
        'brew install *', 'brew uninstall *', 'brew upgrade*', 'apt install *', 'apt-get install *', 'apt remove *', 'apt-get remove *',
        'winget install *', 'winget uninstall *', 'choco install *', 'scoop install *',
      ],
      reason: "installs or removes software outside the project; a rewind won't undo it",
    },
    {
      action: 'ask',
      commands: ['setx *', 'reg add *', 'reg delete *', 'reg import *', '*SetEnvironmentVariable*', '*Set-ItemProperty*HKCU:*', '*Set-ItemProperty*HKLM:*', 'launchctl *', 'systemctl *', 'crontab *', 'schtasks *'],
      reason: 'changes system or user settings outside the project',
    },
    {
      action: 'ask',
      paths: ['/etc/**', '/usr/**', '/Library/**', '/System/**', 'C:/Windows/**', 'C:/Program Files/**', 'C:/Program Files (x86)/**', 'C:/ProgramData/**'],
      access: 'write',
      reason: 'writes to a system folder',
    },
    {
      action: 'ask',
      commands: [
        'npm publish*', 'pnpm publish*', 'yarn publish*', 'cargo publish*', 'twine upload *', 'gh release create *', 'docker push *',
        'kubectl apply *', 'kubectl delete *', 'helm install *', 'helm upgrade *', 'terraform apply*', 'terraform destroy*', 'pulumi up*',
        'vercel --prod*', 'vercel deploy --prod*', 'netlify deploy --prod*', 'firebase deploy*', 'fly deploy*', 'wrangler deploy*', 'serverless deploy*',
      ],
      reason: 'publishes or deploys; nothing on this computer can take it back',
    },
    { action: 'ask', commands: ['*DROP TABLE*', '*DROP DATABASE*', '*TRUNCATE TABLE*'], reason: 'deletes database data' },
  ],
};

function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 500);
}

export function validate(raw: unknown): { policy: Policy | null; problem?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { policy: null, problem: 'must be a JSON object with a "rules" list' };
  const rules = (raw as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return { policy: null, problem: '"rules" must be a list' };
  const out: Rule[] = [];
  for (const [i, r] of rules.entries()) {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== 'object') return { policy: null, problem: `${at} must be an object` };
    const { action, paths, commands, tools, access, reason } = r as Record<string, unknown>;
    if (action !== 'deny' && action !== 'ask') return { policy: null, problem: `${at}: "action" must be "deny" or "ask"` };
    for (const [k, v] of Object.entries({ paths, commands, tools })) if (v !== undefined && !strings(v)) return { policy: null, problem: `${at}: "${k}" must be a non-empty list of strings` };
    if (!paths && !commands && !tools) return { policy: null, problem: `${at} needs "paths", "commands" or "tools"` };
    if (access !== undefined && access !== 'write' && access !== 'any') return { policy: null, problem: `${at}: "access" must be "write" or "any"` };
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 300)) return { policy: null, problem: `${at}: "reason" must be a short string` };
    out.push({ action, paths: paths as string[] | undefined, commands: commands as string[] | undefined, tools: tools as string[] | undefined, access: access as Rule['access'], reason: reason as string | undefined });
  }
  return { policy: { rules: out } };
}

/** The policy, or null when there is none. A broken file is reported, never guessed at. */
export function loadPolicy(ctx: Pick<Ctx, 'dataDir'>): { policy: Policy | null; problem?: string } {
  const file = policyPath(ctx);
  const good = file.replace(/\.json$/, '.last-good.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { policy: null };
    return fallback(good, `can't read ${file}: ${(e as Error).message}`);
  }
  let res: { policy: Policy | null; problem?: string };
  try {
    res = validate(JSON.parse(text));
  } catch (e) {
    return fallback(good, `${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (res.problem) return fallback(good, `${file}: ${res.problem}`);
  // keep a copy of the last policy that worked, so breaking the file doesn't switch the rules off
  try {
    if (fs.readFileSync(good, 'utf8') !== text) fs.writeFileSync(good, text, { mode: 0o600 });
  } catch {
    try {
      fs.writeFileSync(good, text, { mode: 0o600 });
    } catch {
      // read-only data folder; the rules still apply this time
    }
  }
  return res;
}

function fallback(good: string, problem: string): { policy: Policy | null; problem: string } {
  try {
    const res = validate(JSON.parse(fs.readFileSync(good, 'utf8')));
    if (res.policy) return { policy: res.policy, problem: `${problem} (the last working rules still apply)` };
  } catch {
    // no earlier copy
  }
  return { policy: null, problem };
}

// Globs are matched by stepping through the text once with the set of
// pattern positions still possible (no backtracking), so a rule with many
// wildcards can't take long however the command or path was crafted.
type Tok = { t: 'c'; ch: string } | { t: '?' } | { t: '*'; slash: boolean } | { t: 'dirs' };

export interface Glob {
  test(s: string): boolean;
}

function compile(pattern: string, kind: 'path' | 'text', fold: boolean): Glob {
  const toks: Tok[] = [];
  const p = fold ? pattern.toLowerCase() : pattern;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (kind === 'path' && ch === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') {
        i++;
        toks.push({ t: 'dirs' }); // `**/`: nothing, or any folders
      } else toks.push({ t: '*', slash: true });
    } else if (ch === '*') toks.push({ t: '*', slash: kind === 'text' });
    else if (ch === '?') toks.push({ t: '?' });
    else toks.push({ t: 'c', ch });
  }
  const n = toks.length;
  const closure = (set: Uint8Array) => {
    for (let i = 0; i < n; i++) if (set[i] && (toks[i]!.t === '*' || toks[i]!.t === 'dirs')) set[i + 1] = 1;
  };
  return {
    test(input: string) {
      const s = fold ? input.toLowerCase() : input;
      let cur = new Uint8Array(n + 1);
      cur[0] = 1;
      closure(cur);
      for (const ch of s) {
        const next = new Uint8Array(n + 1);
        let any = false;
        for (let i = 0; i < n; i++) {
          if (!cur[i]) continue;
          const tk = toks[i]!;
          if (tk.t === 'c' ? tk.ch === ch : tk.t === '?' ? kind === 'text' || ch !== '/' : false) {
            next[i + 1] = 1;
            any = true;
          } else if (tk.t === '*' && (tk.slash || ch !== '/')) {
            next[i] = 1;
            any = true;
          } else if (tk.t === 'dirs') {
            next[i] = 1;
            if (ch === '/') next[i + 1] = 1;
            any = true;
          }
        }
        if (!any) return false;
        closure(next);
        cur = next;
      }
      return cur[n] === 1;
    },
  };
}

/** Glob for paths: `**` crosses folders, `*` and `?` stay within one, `dir/**` includes `dir`. */
export function pathGlob(pattern: string, fold: boolean): Glob {
  const g = compile(pattern, 'path', fold);
  if (!/\/\*\*$/.test(pattern)) return g;
  const self = compile(pattern.slice(0, -3), 'path', fold);
  return { test: (s) => self.test(s) || g.test(s) };
}

/** Glob for commands and tool names: `*` matches anything, case doesn't matter (Windows commands ignore it). */
export function textGlob(pattern: string): Glob {
  return compile(pattern, 'text', true);
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** A folder as written and as it really is (8.3 short names, links): paths are compared in both forms. */
function bothForms(dir: string): string[] {
  const spelled = norm(dir);
  try {
    const real = norm(fs.realpathSync.native(dir));
    return real === spelled ? [spelled] : [spelled, real];
  } catch {
    return [spelled];
  }
}

function absPatterns(pattern: string, call: Call): string[] {
  const p = pattern.replace(/\\/g, '/');
  if (p === '~' || p.startsWith('~/')) return bothForms(call.home).map((h) => h + p.slice(1));
  if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) return [p];
  return bothForms(call.root).map((r) => r + '/' + p);
}

/**
 * Paths a shell command seems to name: arguments with a slash, starting with
 * ~, $, % or a dot, or a file name with an extension (`cat secret.txt`).
 */
export function commandPaths(command: string, max = LIMITS.paths): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s"';|&<>()`]+)/g)) {
    const tok = (m[1] ?? m[2] ?? m[3] ?? '').replace(/^\d?>+|^<+/, '');
    if (!tok || tok.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) continue;
    const named = /[\\/]/.test(tok) || tok.startsWith('~') || tok.startsWith('.') || tok.startsWith('$') || tok.startsWith('%');
    const fileName = /^[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10}$/.test(tok) && !/^[\d.]+$/.test(tok);
    if (named || fileName) out.push(tok);
    if (out.length > max) break;
  }
  return out;
}

// Separate commands: && || ; | & newlines, and what runs inside ( ), $( ) and backticks.
function segments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\||&|\r?\n|\$\(|\(|\)|`)\s*/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/**
 * One path, the way the file system will see it: home-folder variables
 * expanded, Git Bash and WSL drive paths and Windows device prefixes turned
 * into plain drive paths, trailing dots and spaces dropped on Windows.
 */
/** `gaps` hears about a path whose real location couldn't be worked out in full. */
export function normalizePath(raw: string, call: Pick<Call, 'home' | 'cwd' | 'platform'>, gaps?: string[]): string[] {
  const win = call.platform === 'win32';
  let p = raw.trim();
  p = p.replace(/^(?:\$\{HOME\}|\$HOME|\$env:USERPROFILE|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)(?=$|[\\/])/i, call.home);
  if (p === '~' || /^~[\\/]/.test(p)) p = call.home + p.slice(1);
  if (win) {
    // \\?\UNC\server\share is \\server\share; \\?\C:\x is C:\x
    p = p.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, '');
    p = p.replace(/^\\\\(?:localhost|127\.0\.0\.1)\\([A-Za-z])\$\\/i, '$1:\\');
    p = p.replace(/^\/(?:mnt\/)?([A-Za-z])(?=\/|$)/, '$1:');
    p = p.split(/[\\/]/).map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : seg.replace(/[. ]+$/, '') || seg)).join('/');
  }
  const abs = norm(path.resolve(call.cwd, p.length > LIMITS.pathLength ? p.slice(0, LIMITS.pathLength) : p));
  const out = [abs];
  // the real path catches 8.3 short names and links. For a file that doesn't
  // exist yet, the deepest folder that does is resolved and the rest added
  // back, so a new file under a linked folder is checked where it will land.
  let dir = abs;
  const rest: string[] = [];
  for (let i = 0; ; i++) {
    // so deep that resolving it would cost too much: not checked in full, and the caller says so
    if (i >= 256) {
      gaps?.push('a path too deep to resolve');
      break;
    }
    try {
      const real = norm(path.join(fs.realpathSync.native(dir), ...rest));
      if (real !== abs) out.push(real);
      break;
    } catch {
      const parent = path.dirname(dir);
      // nothing along the way exists, so no link can redirect it
      if (parent === dir) break;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
  return out;
}

export function evaluate(policy: Policy | null, call: Call): Decision | null {
  if (!policy) return null;
  const fold = call.platform === 'win32' || call.platform === 'darwin';
  const gaps: string[] = call.incomplete ? [call.incomplete] : [];
  const command = call.command && call.command.length > LIMITS.command ? (gaps.push(`a command over ${LIMITS.command / 1024} KB`), call.command.slice(0, LIMITS.command)) : call.command;
  const fromCommand = command ? commandPaths(command) : [];
  const given = [...call.paths, ...fromCommand];
  if (given.length > LIMITS.paths) gaps.push(`more than ${LIMITS.paths} paths`);
  if (given.some((p) => p.length > LIMITS.pathLength)) gaps.push('a path too long to check');
  const named = given.slice(0, LIMITS.paths).flatMap((p) => normalizePath(p, call, gaps));
  const parts = command ? [command.trim().replace(/\s+/g, ' '), ...segments(command)] : [];
  let ask: Decision | null = null;
  for (const [i, r] of policy.rules.entries()) {
    let hit: string | null = null;
    if (r.tools) hit = r.tools.find((g) => textGlob(g).test(call.tool)) ? `tool ${call.tool}` : null;
    if (!hit && r.commands && parts.length) {
      const g = r.commands.find((c) => {
        const m = textGlob(c);
        return parts.some((s) => m.test(s));
      });
      if (g) hit = `command matches "${g}"`;
    }
    if (!hit && r.paths && named.length && (r.access !== 'write' || call.writes)) {
      for (const g of r.paths) {
        for (const pattern of absPatterns(g, call)) {
          const m = pathGlob(pattern, fold);
          const p = named.find((x) => m.test(x));
          if (p) {
            hit = `${p} matches "${g}"`;
            break;
          }
        }
        if (hit) break;
      }
    }
    if (!hit) continue;
    const d: Decision = { action: r.action, reason: r.reason ? `${r.reason} (${hit})` : hit, rule: i + 1 };
    if (r.action === 'deny') return d;
    ask ??= d;
  }
  // part of the call went unchecked: that's not the same as nothing matching
  if (!ask && gaps.length) return { action: 'ask', reason: `too much to check against your rules (${gaps.join(', ')}); look at it before it runs`, rule: 0 };
  return ask;
}
