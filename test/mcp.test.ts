import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { rewindTarget } from '../src/commands/rewind.js';
import { handleMessage } from '../src/mcp/server.js';
import { openProject } from '../src/store/project.js';
import { findSession, loadSession } from '../src/store/session.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.write('keep.txt', 'original\n');
  // one turn: the agent deletes keep.txt with a shell command
  const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'm', cwd: sb.project, ...e }, sb.ctx);
  ev({ hook_event_name: 'UserPromptSubmit', prompt: 'tidy up' });
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm keep.txt' } });
  fs.rmSync(path.join(sb.project, 'keep.txt'));
  ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm keep.txt' }, tool_response: {} });
  ev({ hook_event_name: 'Stop' });
});
afterEach(() => sb.cleanup());

const call = (name: string, args: Record<string, unknown> = {}, id = 1) => {
  const res = handleMessage(sb.ctx, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: res.result.content[0]!.text, isError: !!res.result.isError };
};

describe('MCP server', () => {
  it('speaks the handshake and lists its tools', () => {
    const init = handleMessage(sb.ctx, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as { result: Record<string, unknown> };
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'zerostel' } });
    expect(handleMessage(sb.ctx, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = handleMessage(sb.ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['checkpoint', 'timeline', 'rewind', 'verify', 'check_policy']);
    expect(handleMessage(sb.ctx, { jsonrpc: '2.0', id: 3, method: 'nope' })).toMatchObject({ error: { code: -32601 } });
    // requests without an id are notifications: no answer, whatever the method
    expect(handleMessage(sb.ctx, { jsonrpc: '2.0', method: 'tools/list' })).toBeNull();
    const odd = handleMessage(sb.ctx, { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '1999-01-01' } }) as { result: { protocolVersion: string } };
    expect(odd.result.protocolVersion).toBe('2025-06-18');
  });

  it('previews a rewind without touching files, and applies it only when asked', () => {
    const preview = call('rewind', { step: '0' });
    expect(preview.text).toMatch(/preview/);
    expect(preview.text).toMatch(/keep\.txt/);
    expect(sb.read('keep.txt')).toBeNull();
    const done = call('rewind', { step: '0', apply: true });
    expect(done.text).toMatch(/done/);
    expect(sb.read('keep.txt')).toBe('original\n');
    // the rewind is in the timeline and can be undone
    expect(call('timeline').text).toMatch(/point zero/);
    call('rewind', { step: 'undo', apply: true });
    expect(sb.read('keep.txt')).toBeNull();
  });

  it('saves checkpoints, verifies the log and reports tool errors as results', () => {
    sb.write('new.txt', 'x');
    expect(call('checkpoint', { message: 'before refactor' }).text).toMatch(/Saved as step #\d+/);
    expect(call('verify').text).toMatch(/Log intact/);
    expect(call('rewind', { step: '99' })).toMatchObject({ isError: true });
    expect(call('check_policy', { command: 'git push --force' }).text).toMatch(/No guardrail rules/);
  });
});

describe('point zero', () => {
  it('rewind 0 goes back to the first snapshot of the session', () => {
    const s = loadSession(findSession(openProject(sb.project, sb.ctx))!);
    const t = rewindTarget(s, '0');
    expect(t.label).toMatch(/point zero/);
    expect(t.snap).toBe(s.steps[0]!.before);
    expect(rewindTarget(s, 'zero').snap).toBe(t.snap);
    expect(() => rewindTarget(s, 'x')).toThrow(/not a step number/);
  });
});
