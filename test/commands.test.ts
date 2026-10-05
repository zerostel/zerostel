import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode, codex, cursor } from '../src/agents/adapters.js';
import { handleHook } from '../src/agents/hooks.js';
import { applyRestore, stepTarget, undoTarget } from '../src/commands/rewind.js';
import { applyPlan, defaultAgents, hookEntry, hookStatus, planInstall, planUninstall } from '../src/install.js';
import { renderReport } from '../src/report/html.js';
import { renderTimeline } from '../src/view/timeline.js';
import { openProject } from '../src/store/project.js';
import { findSession, listSessions, loadSession } from '../src/store/session.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const hook = (ev: Record<string, unknown>) => handleHook('claude-code', { session_id: 's', cwd: sb.project, ...ev }, sb.ctx);

function tool(id: string, name: string, input: Record<string, unknown>, effect: () => void) {
  hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input });
  effect();
  hook({ hook_event_name: 'PostToolUse', tool_name: name, tool_use_id: id, tool_input: input, tool_response: {} });
}

function twoTurns() {
  sb.write('a.txt', 'v1\n');
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'first' });
  tool('1', 'Write', { file_path: 'a.txt' }, () => sb.write('a.txt', 'v2\n'));
  hook({ hook_event_name: 'Stop' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'second' });
  tool('2', 'Bash', { command: 'rm a.txt' }, () => fs.rmSync(path.join(sb.project, 'a.txt')));
  hook({ hook_event_name: 'Stop' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'just a question' });
  hook({ hook_event_name: 'Stop' });
}

describe('undo and rewind', () => {
  it('undo skips turns that changed nothing and can be undone itself', () => {
    twoTurns();
    const p = openProject(sb.project, sb.ctx);
    let s = loadSession(findSession(p)!);
    const t = undoTarget(s)!;
    expect(t.label).toBe('Undo turn #3');
    applyRestore(p, s.ref, t);
    expect(sb.read('a.txt')).toBe('v2\n');

    s = loadSession(findSession(p)!);
    const back = undoTarget(s)!;
    expect(back.label).toMatch(/^Undo rewind #/);
    applyRestore(p, s.ref, back);
    expect(sb.read('a.txt')).toBeNull();
  });

  it('rewinds to before or after any step', () => {
    twoTurns();
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    applyRestore(p, s.ref, stepTarget(s, 2)); // before the Write
    expect(sb.read('a.txt')).toBe('v1\n');
    applyRestore(p, s.ref, stepTarget(s, 2, true)); // after the Write
    expect(sb.read('a.txt')).toBe('v2\n');
    expect(() => stepTarget(s, 99)).toThrow(/not found/);
  });

  it('does not report its own rewind as an outside change', () => {
    twoTurns();
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    applyRestore(p, s.ref, stepTarget(s, 1));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'again' });
    const types = loadSession(findSession(p)!).steps.map((x) => x.type);
    expect(types).not.toContain('outside');
  });
});

describe('install', () => {
  it('adds Claude Code hooks without touching other settings, and removes only its own', () => {
    fs.mkdirSync(sb.ctx.claudeDir, { recursive: true });
    const file = path.join(sb.ctx.claudeDir, 'settings.json');
    const mine = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } }));

    const entry = hookEntry(sb.ctx, claudeCode, '/usr/bin/node');
    applyPlan(planInstall(sb.ctx, claudeCode, entry));
    applyPlan(planInstall(sb.ctx, claudeCode, entry)); // twice is the same as once
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0].hooks[0]).toEqual(mine);
    expect(s.hooks.PostToolUse[0]).toEqual({ matcher: '*', hooks: [{ ...entry, timeout: 30 }] });
    expect(Object.keys(s.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hookStatus(sb.ctx, claudeCode).installed).toBe(true);
    expect(fs.existsSync(file + '.zerostel.bak')).toBe(true);

    applyPlan(planUninstall(sb.ctx, claudeCode));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } });
    expect(hookStatus(sb.ctx, claudeCode).installed).toBe(false);
  });

  it('writes Codex hooks.json with only the keys Codex accepts', () => {
    const linux = { ...sb.ctx, platform: 'linux' as const };
    const entry = hookEntry(linux, codex, '/usr/bin/node');
    applyPlan(planInstall(linux, codex, entry));
    const cfg = JSON.parse(fs.readFileSync(path.join(sb.ctx.codexDir, 'hooks.json'), 'utf8'));
    expect(Object.keys(cfg)).toEqual(['hooks']);
    expect(cfg.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    // bare on Linux temp paths, single-quoted when the path has unusual characters
    expect(cfg.hooks.PreToolUse[0].hooks[0].command).toMatch(/zerostel\.mjs'? hook codex$/);
    expect(cfg.hooks.PreToolUse[0].matcher).toBeUndefined();
    // uninstalling Codex leaves Claude Code alone and vice versa
    applyPlan(planInstall(sb.ctx, claudeCode, hookEntry(sb.ctx, claudeCode, '/usr/bin/node')));
    applyPlan(planUninstall(sb.ctx, codex));
    expect(hookStatus(sb.ctx, codex).installed).toBe(false);
    expect(hookStatus(sb.ctx, claudeCode).installed).toBe(true);
  });

  it('keeps 8.3 names as they are, and falls back to exec form when no plain path can be had', () => {
    const ci = { ...sb.ctx, platform: 'win32' as const, dataDir: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x\\zs' };
    expect(hookEntry(ci, claudeCode, 'C:\\node.exe').command).toBe('C:/Users/RUNNER~1/AppData/Local/Temp/x/zs/bin/zerostel-hook.cmd claude-code');
    // a folder with a space and no short name (it doesn't even exist here)
    const spaced = { ...sb.ctx, platform: 'win32' as const, dataDir: path.join(sb.root, 'no such folder', 'zs') };
    const claude = hookEntry(spaced, claudeCode, 'C:\\node.exe');
    expect(claude.args?.slice(-2)).toEqual(['hook', 'claude-code']);
    expect(hookEntry(spaced, codex, 'C:\\node.exe').command).toMatch(/^"[^"]+zerostel-hook\.cmd" codex$/);
  });

  it('uses the cmd shim for Claude Code and Codex on Windows, so Cursor can run them too', () => {
    const win = { ...sb.ctx, platform: 'win32' as const };
    // Cursor replays Claude Code's hooks in PowerShell and drops exec form's args
    const claude = hookEntry(win, claudeCode, 'C:\\Program Files\\nodejs\\node.exe');
    expect(claude.args).toBeUndefined();
    expect(claude.command).toMatch(/^[\w:/.~-]+\/zerostel-hook\.cmd claude-code$/);
    const cx = hookEntry(win, codex, 'C:\\node.exe');
    expect(cx.args).toBeUndefined();
    expect(cx.command).toMatch(/zerostel-hook\.cmd"? codex$/);
    const cu = hookEntry(win, cursor, "C:\\Program Files\\nodejs\\node.exe");
    expect(cu.command).toMatch(/^& 'C:\\Program Files\\nodejs\\node\.exe' '.*zerostel\.mjs' hook cursor$/);
  });

  it('writes Cursor hooks in its flat layout when Cursor is there', () => {
    const linux = { ...sb.ctx, platform: 'linux' as const };
    fs.mkdirSync(path.join(sb.ctx.home, '.cursor'), { recursive: true });
    expect(defaultAgents(linux).map((a) => a.id)).toContain('cursor');
    applyPlan(planInstall(linux, cursor));
    const cfg = JSON.parse(fs.readFileSync(path.join(sb.ctx.home, '.cursor', 'hooks.json'), 'utf8'));
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.preToolUse).toEqual([{ type: 'command', command: expect.stringMatching(/ hook cursor$/), timeout: 30 }]);
    expect(hookStatus(linux, cursor).installed).toBe(true);
    applyPlan(planUninstall(linux, cursor));
    expect(JSON.parse(fs.readFileSync(path.join(sb.ctx.home, '.cursor', 'hooks.json'), 'utf8'))).toEqual({ version: 1 });
  });

  it('maps Cursor payloads onto the same timeline', () => {
    sb.write('a.txt', 'one\n');
    const ev = (e: Record<string, unknown>) => handleHook('cursor', { conversation_id: 'cur-1', workspace_roots: [sb.project], cursor_version: '3.20', ...e }, sb.ctx);
    ev({ hook_event_name: 'beforeSubmitPrompt', prompt: 'change a' });
    ev({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_use_id: 's1', tool_input: { command: 'echo two > a.txt' } });
    sb.write('a.txt', 'two\n');
    ev({ hook_event_name: 'postToolUse', tool_name: 'Shell', tool_use_id: 's1', tool_input: { command: 'echo two > a.txt' } });
    // the same payload through the Claude Code hooks Cursor also loads is ignored
    handleHook('claude-code', { session_id: 'cur-1', cwd: sb.project, cursor_version: '3.20', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } }, sb.ctx);
    const p = openProject(sb.project, sb.ctx);
    const sessions = listSessions(p);
    expect(sessions.map((x) => x.agent)).toEqual(['cursor']);
    const s = loadSession(sessions[0]!);
    expect(s.steps.map((x) => x.summary)).toEqual(['change a', '$ echo two > a.txt']);
    expect(s.steps[1]!.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('refuses to overwrite a settings file it cannot parse', () => {
    fs.mkdirSync(sb.ctx.claudeDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.claudeDir, 'settings.json'), '{ broken');
    expect(() => planInstall(sb.ctx, claudeCode)).toThrow(/not valid JSON/);
  });
});

describe('report', () => {
  it('is self-contained, masks secrets and leaves out private files', () => {
    sb.write('.env', 'TOKEN=supersecretvalue123456\n');
    sb.write('app.js', 'let a = 1;\n');
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'reticulate <script>alert(1)</script> things' });
    tool('1', 'Bash', { command: 'echo hi' }, () => {
      sb.write('.env', 'TOKEN=anothersecretvalue654321\n');
      sb.write('app.js', 'let a = 2; // ghp_' + 'a1B2c3D4e5'.repeat(4) + '\n');
    });
    const p = openProject(sb.project, sb.ctx);
    const html = renderReport(p, loadSession(findSession(p)!));
    expect(html).toContain('Diff hidden for private files: .env');
    expect(html).not.toContain('supersecretvalue');
    expect(html).not.toContain('anothersecretvalue');
    expect(html).not.toContain('a1B2c3D4e5a1B2c3D4e5');
    expect(html).not.toContain('<script>alert(1)</script>');
    // nothing loaded from outside; the only link is the inlined data: icon
    expect(html).not.toMatch(/<script|src="http|href="http/);
    expect(html.match(/<link[^>]*>/g)).toEqual([expect.stringMatching(/^<link rel="icon" type="image\/svg\+xml" href="data:/)]);

    const hidden = renderReport(p, loadSession(findSession(p)!), { prompts: false });
    expect(hidden).not.toContain('reticulate');
  });
});

describe('timeline layout', () => {
  it('keeps a step that deleted files, with its warning mark, inside the terminal width', () => {
    for (const f of ['auth', 'session', 'tokens', 'keys']) sb.write(`src/legacy/${f}.ts`, 'export const x = 1;\n'.repeat(40));
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'remove the old code' });
    tool('1', 'Bash', { command: 'rm -rf src/legacy' }, () => fs.rmSync(path.join(sb.project, 'src/legacy'), { recursive: true }));
    const p = openProject(sb.project, sb.ctx);
    // the warning mark is two columns wide in many terminals
    const cols = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/⚠/g, '⚠ ').length;
    for (const width of [90, 100, 120, 160]) {
      const lines = renderTimeline(loadSession(findSession(p)!), { width });
      expect(lines.some((l) => l.includes('⚠'))).toBe(true);
      for (const l of lines.filter((x) => x.includes('#'))) expect(cols(l), l).toBeLessThanOrEqual(width);
    }
  });
});
