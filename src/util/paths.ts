import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SystemProbe } from '../system/probe.js';

// Everything Zerostel needs to know about the machine. Tests pass a fake one,
// so nothing else should read os.homedir() or process.env for these.
export interface Ctx {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  dataDir: string; // ~/.zerostel
  claudeDir: string; // ~/.claude, or $CLAUDE_CONFIG_DIR
  codexDir: string; // ~/.codex, or $CODEX_HOME
  copilotDir: string; // ~/.copilot, or $COPILOT_HOME
  configHome: string; // ~/.config, or $XDG_CONFIG_HOME
  dshHome: string; // ~/.dsh, or $DSH_HOME (DeepSeek Harness)
  geminiHome: string; // the folder holding .gemini for Gemini CLI: home, or $GEMINI_CLI_HOME
  /** global packages and the Windows user environment; undefined = the real machine, null = leave them alone */
  system?: SystemProbe | null;
}

export function defaultCtx(over: Partial<Ctx> = {}): Ctx {
  const home = over.home ?? os.homedir();
  const fake = over.home !== undefined;
  return {
    home,
    cwd: over.cwd ?? process.cwd(),
    platform: over.platform ?? process.platform,
    dataDir: over.dataDir ?? ((!fake && process.env.ZEROSTEL_DIR) || path.join(home, '.zerostel')),
    claudeDir: over.claudeDir ?? ((!fake && process.env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude')),
    codexDir: over.codexDir ?? ((!fake && process.env.CODEX_HOME) || path.join(home, '.codex')),
    copilotDir: over.copilotDir ?? ((!fake && process.env.COPILOT_HOME) || path.join(home, '.copilot')),
    configHome: over.configHome ?? ((!fake && process.env.XDG_CONFIG_HOME) || path.join(home, '.config')),
    dshHome: over.dshHome ?? ((!fake && process.env.DSH_HOME) || path.join(home, '.dsh')),
    geminiHome: over.geminiHome ?? ((!fake && process.env.GEMINI_CLI_HOME) || home),
    // a fake home folder means a test: never touch the real machine's packages or registry
    system: over.system !== undefined ? over.system : fake ? null : undefined,
  };
}

/** Path relative to `root` with forward slashes, or `~/...` when outside it. */
export function displayPath(file: string, root: string, home: string): string {
  if (!file) return file;
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  const h = path.relative(home, abs);
  if (h && !h.startsWith('..') && !path.isAbsolute(h)) return '~/' + h.replace(/\\/g, '/');
  return abs.replace(/\\/g, '/');
}

/** `~/...` for paths under home, otherwise the path as is. */
export function tilde(p: string, home: string): string {
  const rel = path.relative(home, p);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return '~/' + rel.replace(/\\/g, '/');
  return p;
}

/** Forward-slash path for commands that end up in bash or cmd. */
export function shellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * ~/.zerostel holds copies of project files, .env included, so keep it to the
 * owner. On Windows the profile folder's ACL already does this.
 */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return;
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  if ((fs.statSync(dir).mode & 0o077) !== 0) throw new Error(`cannot make the private data directory owner-only: ${dir}`);
}
