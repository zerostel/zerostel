import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../src/agents/adapters.js';
import { handleHook, patchFiles, toolKind } from '../src/agents/hooks.js';
import { STARTER } from '../src/guard/policy.js';
import { applyPlan, planInstall, planUninstall } from '../src/install.js';
import { openProject } from '../src/store/project.js';
import { findSession, listSessions, loadSession } from '../src/store/session.js';
import { sandbox, type Sandbox } from './helpers.js';

// Gaps a security review found between what the rules say and what the guard saw.

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sb.ctx.dataDir, 'policy.json'), JSON.stringify(STARTER));
});
afterEach(() => sb.cleanup());

const key = () => path.join(sb.root, '.ssh', 'id_ed25519');

describe('the guard sees every path a tool call names', () => {
  it('reads rename targets and indented headers in a patch', () => {
    const patch = ['*** Begin Patch', '*** Update File: src/a.ts', `*** Move to: ${key()}`, '  *** Delete File: b.ts', '*** End Patch'].join('\n');
    expect(patchFiles(patch)).toEqual(['src/a.ts', key(), 'b.ts']);
    const res = handleHook('codex', { session_id: 'p', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'x', tool_input: { command: patch } }, sb.ctx);
    expect(res.decision?.action).toBe('deny');
  });

  it('reads the files of a patch sent as a plain string (Copilot CLI edits)', () => {
    // captured from Copilot CLI 1.0.91: tool "Edit", tool_input a patch body, not an object
    const patch = `*** Begin Patch\n*** Update File: ${key()}\n@@\n-a\n+b\n*** End Patch\n`;
    const res = handleHook('copilot', { session_id: 'cp', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: patch }, sb.ctx);
    expect(res.decision?.action).toBe('deny');
    // and an ordinary one is recorded as the patch it is
    sb.write('notes.md', 'a');
    const ok = `*** Begin Patch\n*** Update File: notes.md\n@@\n-a\n+b\n*** End Patch\n`;
    handleHook('copilot', { session_id: 'cp', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: ok }, sb.ctx);
    sb.write('notes.md', 'b');
    handleHook('copilot', { session_id: 'cp', cwd: sb.project, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: ok, tool_result: { result_type: 'success', text_result_for_llm: 'Modified 1 file(s)' } }, sb.ctx);
    const s = loadSession(findSession(openProject(sb.project, sb.ctx), 'cp')!);
    expect(s.steps.filter((x) => x.type === 'tool').map((x) => [x.summary, x.files.map((f) => f.path)])).toEqual([['Patch notes.md', ['notes.md']]]);
  });

  it('reads path arguments whatever the agent calls them', () => {
    // a tool no table knows, with an argument name no table lists
    const res = handleHook('antigravity', { conversationId: 'a', workspacePaths: [sb.project], stepIdx: 1, toolCall: { name: 'new_tool', args: { DestinationFile: key() } } }, sb.ctx, 'PreToolUse');
    expect(res.decision?.action).toBe('deny');
  });

  it('reads a location under any argument name, file: URLs included', () => {
    // an MCP tool whose path argument is called source, uri or location
    const call = (args: Record<string, unknown>) =>
      handleHook('claude-code', { session_id: 'm', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'mcp__files__read', tool_use_id: 'm1', tool_input: args }, sb.ctx).decision?.action;
    expect(call({ source: key() })).toBe('deny');
    expect(call({ uri: pathToFileURL(key()).href })).toBe('deny');
    expect(call({ location: '~/.ssh/id_ed25519' })).toBe('deny');
    expect(call({ options: { from: [key()] } })).toBe('deny');
    // a URL or a plain word is not a path
    expect(call({ source: 'https://example.com/.ssh/id_ed25519', name: 'id_ed25519' })).toBeUndefined();
  });

  it("doesn't mistake text that mentions a path for one the tool opens", () => {
    const res = handleHook('claude-code', { session_id: 't', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: path.join(sb.project, 'notes.md'), content: `keys live in ${key()}` } }, sb.ctx);
    expect(res.decision).toBeUndefined();
  });

  it('checks the arguments as sent as well as after renaming', () => {
    // Cursor's Grep: file_path is renamed to path; a payload with both must not hide one
    const res = handleHook('cursor', { conversation_id: 'k', cursor_version: '3', workspace_roots: [sb.project], hook_event_name: 'preToolUse', tool_name: 'Grep', tool_use_id: 'g', tool_input: { pattern: 'x', path: sb.project, file_path: key() } }, sb.ctx);
    expect(res.decision?.action).toBe('deny');
  });

  it('treats a shell tool as one in any spelling', () => {
    expect(toolKind('bash')).toBe('shell');
    const res = handleHook('copilot', { session_id: 'c', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'cat ~/.aws/credentials' } }, sb.ctx);
    expect(res.decision?.action).toBe('deny');
  });

  it('protects Zerostel and agent folders that an environment variable moved', () => {
    const moved = { ...sb.ctx, dataDir: path.join(sb.root, 'elsewhere', 'zs'), claudeDir: path.join(sb.root, 'elsewhere', 'claude') };
    fs.mkdirSync(moved.dataDir, { recursive: true });
    fs.writeFileSync(path.join(moved.dataDir, 'policy.json'), JSON.stringify(STARTER));
    const pre = (file: string, id: string) =>
      handleHook('claude-code', { session_id: 'm', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: id, tool_input: { file_path: file } }, moved);
    expect(pre(path.join(moved.dataDir, 'audit.key'), '1').decision?.action).toBe('deny');
    expect(pre(path.join(moved.claudeDir, 'settings.json'), '2').decision?.action).toBe('ask');
  });
});

describe('answers', () => {
  it('reach the agent before anything is recorded', () => {
    const heard: string[] = [];
    const res = handleHook('claude-code', { session_id: 'd', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r', tool_input: { file_path: key() } }, sb.ctx, undefined, {
      onDecision: (r) => {
        heard.push(r.decision!.action);
        // nothing of this call is in the log yet
        const ref = listSessions(openProject(sb.project, sb.ctx)).find((x) => x.id === 'd');
        expect(ref ? loadSession(ref).steps.length : 0).toBe(0);
      },
    });
    expect(heard).toEqual(['deny']);
    expect(res.decision?.action).toBe('deny');
  });

  it('an ask an agent cannot pose is a block: recorded as one, with no snapshot', () => {
    sb.write('.env', 'A=1');
    handleHook('codex', { session_id: 'q', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'e', tool_input: { command: '*** Begin Patch\n*** Update File: .env\n*** End Patch' } }, sb.ctx);
    const s = loadSession(findSession(openProject(sb.project, sb.ctx), 'q')!);
    expect(s.steps.map((x) => [x.type, x.guard])).toEqual([['guard', 'deny']]);
  });
});

describe('hooks removed during a session', () => {
  it('are noticed by the next hook call and written into the log', () => {
    const ctx = { ...sb.ctx, platform: 'linux' as const };
    applyPlan(planInstall(ctx, claudeCode));
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'h', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    applyPlan(planUninstall(ctx, claudeCode));
    ev({ hook_event_name: 'Stop' });
    const s = loadSession(findSession(openProject(sb.project, sb.ctx), 'h')!);
    const flagged = s.steps.filter((x) => x.type === 'hooks');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.summary).toMatch(/removed from .*settings\.json/);
  });
});
