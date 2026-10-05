import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { applyRestore, stepTarget, undoTarget } from '../src/commands/rewind.js';
import { restoreHome, snapshotHome, watched } from '../src/store/home.js';
import { openProject } from '../src/store/project.js';
import { handleMessage } from '../src/mcp/server.js';
import { findSession, loadSession } from '../src/store/session.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
const rc = () => path.join(sb.root, '.zshrc');
beforeEach(() => {
  sb = sandbox();
  fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), JSON.stringify({ watch: ['~/.zshrc', '~/.gitconfig'] }));
  fs.writeFileSync(rc(), 'export PATH=/usr/bin\n');
  sb.write('a.txt', 'a\n');
});
afterEach(() => sb.cleanup());

describe('watched files outside the project', () => {
  it('only accepts files under the home folder, never ~/.zerostel', () => {
    const list = watched(sb.ctx, ['~/.zshrc', '~/.zshrc', '/etc/hosts', '~/.zerostel/audit.key', 'relative.txt', '~/../x']);
    expect(list.map((w) => w.rel)).toEqual(['.zshrc']);
  });

  it('records a change the agent made to ~/.zshrc and rewinds it with the project', () => {
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'h', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'set up my shell' });
    const input = { command: 'echo "alias rm=yolo" >> ~/.zshrc' };
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: input });
    fs.appendFileSync(rc(), 'alias rm=yolo\n');
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: input, tool_response: {} });
    ev({ hook_event_name: 'Stop' });

    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    const home = s.steps.find((x) => x.type === 'home');
    expect(home?.files.map((f) => f.path)).toEqual(['~/.zshrc']);

    const tool = s.steps.find((x) => x.type === 'tool')!;
    const t = stepTarget(s, tool.n);
    const preview = applyRestore(p, s.ref, t, { dryRun: true, ctx: sb.ctx });
    expect(preview.home?.restored).toEqual(['~/.zshrc']);
    expect(fs.readFileSync(rc(), 'utf8')).toContain('yolo');
    applyRestore(p, s.ref, t, { ctx: sb.ctx });
    expect(fs.readFileSync(rc(), 'utf8')).toBe('export PATH=/usr/bin\n');

    // and the rewind itself can be undone, home files included
    const again = loadSession(findSession(p)!);
    applyRestore(p, again.ref, undoTarget(again)!, { ctx: sb.ctx });
    expect(fs.readFileSync(rc(), 'utf8')).toContain('yolo');
  });

  it("doesn't overwrite a watched file that grew too large to copy", () => {
    const first = snapshotHome(sb.ctx)!;
    const big = 'x'.repeat(1024 * 1024 + 10);
    fs.writeFileSync(rc(), big);
    const res = restoreHome(sb.ctx, first);
    expect(res.restored).toEqual([]);
    expect(res.failed.map((f) => f.path)).toEqual(['~/.zshrc']);
    expect(fs.readFileSync(rc(), 'utf8')).toBe(big);
  });

  it('does not reread unchanged files, and leaves files that did not exist back then', () => {
    const first = snapshotHome(sb.ctx)!;
    expect(snapshotHome(sb.ctx)).toBe(first);
    fs.writeFileSync(path.join(sb.root, '.gitconfig'), '[user]\n');
    const second = snapshotHome(sb.ctx)!;
    expect(second).not.toBe(first);
    const p = openProject(sb.project, sb.ctx);
    handleHook('claude-code', { session_id: 'k', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, sb.ctx);
    const s = loadSession(findSession(p)!);
    const res = applyRestore(p, s.ref, { snap: s.steps[0]!.before!, label: 'test', home: first }, { dryRun: true, ctx: sb.ctx });
    expect(res.home?.kept).toEqual(['~/.gitconfig']);
    expect(res.home?.restored).toEqual([]);
  });

  it('a lost home snapshot does not stop the project rewind or its record', () => {
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'm', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w', tool_input: { file_path: path.join(sb.project, 'a.txt') } });
    sb.write('a.txt', 'changed\n');
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w', tool_input: { file_path: path.join(sb.project, 'a.txt') }, tool_response: {} });
    fs.rmSync(path.join(sb.ctx.dataDir, 'home'), { recursive: true, force: true });
    // different content, so a fresh home snapshot can't come out identical to the lost one
    fs.writeFileSync(rc(), 'export PATH=/opt/bin\n');
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    const res = applyRestore(p, s.ref, undoTarget(s)!, { ctx: sb.ctx });
    expect(sb.read('a.txt')).toBe('a\n');
    expect(res.failed.map((f) => f.path)).toContain('~ (watched files)');
    expect(loadSession(findSession(p)!).steps.some((x) => x.type === 'restore')).toBe(true);
  });

  it('takes nothing from ~/.zerostel even spelled with other case on case-insensitive systems', () => {
    const ctx = { ...sb.ctx, platform: 'darwin' as const };
    expect(watched(ctx, ['~/.ZEROSTEL/policy.json', '~/.zshrc']).map((w) => w.rel)).toEqual(['.zshrc']);
  });

  it.skipIf(process.platform === 'win32')('will not write through a link that replaced a watched file', () => {
    const first = snapshotHome(sb.ctx)!;
    const outside = path.join(sb.root, 'outside.txt');
    fs.writeFileSync(outside, 'keep me\n');
    fs.rmSync(rc());
    fs.symlinkSync(outside, rc());
    const p = openProject(sb.project, sb.ctx);
    handleHook('claude-code', { session_id: 'l', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, sb.ctx);
    const s = loadSession(findSession(p)!);
    const res = applyRestore(p, s.ref, { snap: s.steps[0]!.before!, label: 'test', home: first }, { ctx: sb.ctx });
    expect(res.failed.map((f) => f.path)).toContain('~/.zshrc');
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep me\n');
  });
});

describe('watched files that were deleted', () => {
  it.skipIf(process.platform === 'win32')('come back owner-only, not readable by everyone', () => {
    fs.chmodSync(rc(), 0o600);
    const before = snapshotHome(sb.ctx)!;
    fs.rmSync(rc());
    snapshotHome(sb.ctx);
    const res = restoreHome(sb.ctx, before);
    expect(res.restored).toEqual(['~/.zshrc']);
    expect(fs.statSync(rc()).mode & 0o777).toBe(0o600);
  });
});

describe('watched files and the MCP server', () => {
  it("are left to the user: the agent's rewind puts back the project only, and says what it left", () => {
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'mh', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'set up my shell' });
    const input = { command: 'echo "alias rm=yolo" >> ~/.zshrc && echo b > a.txt' };
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: input });
    fs.appendFileSync(rc(), 'alias rm=yolo\n');
    sb.write('a.txt', 'b\n');
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: input, tool_response: {} });
    ev({ hook_event_name: 'Stop' });

    const mcp = (args: Record<string, unknown>) => (handleMessage(sb.ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rewind', arguments: args } }) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    const confirm = /confirm="([0-9a-f]{8})"/.exec(mcp({ step: 'undo' }))![1];
    const text = mcp({ step: 'undo', apply: true, confirm });
    expect(fs.readFileSync(path.join(sb.project, 'a.txt'), 'utf8')).toBe('a\n');
    expect(fs.readFileSync(rc(), 'utf8')).toContain('yolo');
    expect(text).toContain('~/.zshrc would also go back');
  });
});
