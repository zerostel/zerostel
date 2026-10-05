import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook, patchFiles, readTranscriptUsage, stripCd, summarizeTool } from '../src/agents/hooks.js';
import { openProject } from '../src/store/project.js';
import { emptyUsage, findSession, loadSession, summarize } from '../src/store/session.js';
import { restore } from '../src/store/shadow.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

function hook(sbx: Sandbox, ev: Record<string, unknown>) {
  handleHook('claude-code', { session_id: 'sess-1', cwd: sbx.project, transcript_path: path.join(sbx.root, 't.jsonl'), ...ev }, sbx.ctx);
}

function assistantLine(id: string, input: number, output: number) {
  return JSON.stringify({ type: 'assistant', requestId: 'r' + id, message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }) + '\n';
}

describe('Claude Code hooks', () => {
  it('records a session and can rewind a shell delete', () => {
    sb.write('src/legacy/old.ts', 'old\n');
    sb.write('src/app.ts', 'const x = 1;\n');
    fs.writeFileSync(path.join(sb.root, 't.jsonl'), '');

    hook(sb, { hook_event_name: 'SessionStart', source: 'startup' });
    hook(sb, { hook_event_name: 'UserPromptSubmit', prompt: 'remove the legacy folder and bump x' });

    hook(sb, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'a', tool_input: { file_path: path.join(sb.project, 'src/app.ts') } });
    hook(sb, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'a', tool_input: { file_path: path.join(sb.project, 'src/app.ts') }, tool_response: { file: { content: 'const x = 1;' } } });

    hook(sb, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'rm -rf src/legacy' } });
    fs.rmSync(path.join(sb.project, 'src/legacy'), { recursive: true });
    hook(sb, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'rm -rf src/legacy' }, tool_response: { stdout: '', stderr: '', interrupted: false } });

    hook(sb, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'c', tool_input: { file_path: path.join(sb.project, 'src/app.ts'), old_string: '1', new_string: '2' } });
    sb.write('src/app.ts', 'const x = 2;\n');
    hook(sb, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'c', tool_input: { file_path: path.join(sb.project, 'src/app.ts') }, tool_response: { filePath: 'src/app.ts' } });

    fs.appendFileSync(path.join(sb.root, 't.jsonl'), assistantLine('m1', 100, 20) + assistantLine('m1', 100, 20) + assistantLine('m2', 50, 30));
    hook(sb, { hook_event_name: 'Stop' });

    // the user edits a file by hand between turns
    sb.write('notes.md', 'mine\n');
    hook(sb, { hook_event_name: 'UserPromptSubmit', prompt: 'thanks' });
    hook(sb, { hook_event_name: 'Stop' });

    const p = openProject(sb.project, sb.ctx);
    const ref = findSession(p)!;
    expect(ref.id).toBe('sess-1');
    const s = loadSession(ref);
    const view = s.steps.map((x) => `${x.n}:${x.type}:${x.summary}`);
    expect(view).toEqual([
      '1:prompt:remove the legacy folder and bump x',
      '2:tool:Read src/app.ts',
      '3:tool:$ rm -rf src/legacy',
      '4:tool:Edit src/app.ts',
      '0:turn:Turn finished',
      '5:outside:Changes made outside the agent',
      '6:prompt:thanks',
      '0:turn:Turn finished',
    ]);
    const rm = s.steps[2]!;
    expect(rm.files.map((f) => `${f.status} ${f.path}`)).toEqual(['D src/legacy/old.ts']);
    expect(s.steps[3]!.files.map((f) => `${f.status} ${f.path} +${f.added} -${f.deleted}`)).toEqual(['M src/app.ts +1 -1']);
    expect(s.steps[5]!.files.map((f) => f.path)).toEqual(['notes.md']);

    // usage is deduplicated by message id
    expect(s.usage).toEqual({ input: 150, output: 50, cacheRead: 20, cacheWrite: 10 });
    expect(s.steps[4]!.usage?.output).toBe(50);

    const sum = summarize(s);
    expect(sum.filesChanged).toBe(3);
    expect(sum.filesDeleted).toBe(1);
    expect(sum.title).toBe('remove the legacy folder and bump x');

    // rewind to before the first prompt
    restore(p, s.steps[0]!.before!);
    expect(sb.read('src/legacy/old.ts')).toBe('old\n');
    expect(sb.read('src/app.ts')).toBe('const x = 1;\n');
    expect(sb.read('notes.md')).toBeNull();
  });

  it('never stores file contents from Write and redacts secrets in commands', () => {
    hook(sb, { hook_event_name: 'UserPromptSubmit', prompt: 'use key sk-ant-api03-' + 'Ab1Cd2Ef3Gh4'.repeat(4) });
    hook(sb, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w', tool_input: { file_path: path.join(sb.project, 'a.txt'), content: 'SECRET CONTENT' } });
    sb.write('a.txt', 'SECRET CONTENT');
    hook(sb, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w', tool_input: { file_path: path.join(sb.project, 'a.txt') } });
    hook(sb, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'curl -H "Authorization: Bearer ghp_' + 'a1B2c3D4e5'.repeat(4) + '" https://api.github.com' } });

    const p = openProject(sb.project, sb.ctx);
    const raw = fs.readFileSync(findSession(p)!.file, 'utf8');
    expect(raw).not.toContain('SECRET CONTENT');
    expect(raw).not.toContain('Ab1Cd2Ef3Gh4Ab1Cd2');
    expect(raw).not.toContain('a1B2c3D4e5a1B2c3D4e5');
    expect(raw).toContain('[redacted]');
  });

  it('records but does not snapshot when started in the home directory', () => {
    fs.writeFileSync(path.join(sb.root, 'x.txt'), 'x');
    handleHook('claude-code', { session_id: 's2', cwd: sb.root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'z', tool_input: { command: 'ls' } }, sb.ctx);
    const p = openProject(sb.root, sb.ctx);
    const s = loadSession(findSession(p)!);
    expect(s.steps[0]!.summary).toBe('$ ls');
    expect(s.steps[0]!.before).toBeUndefined();
    expect(fs.existsSync(p.repo.gitDir)).toBe(false);
  });

  it('summarizes tools', () => {
    expect(summarizeTool('mcp__github__create_issue', {}, sb.project, sb.root)).toBe('MCP github › create_issue');
    expect(summarizeTool('Grep', { pattern: 'TODO', path: path.join(sb.project, 'src') }, sb.project, sb.root)).toBe('Grep "TODO" in src');
    expect(summarizeTool('Read', { file_path: path.join(sb.root, '.bashrc') }, sb.project, sb.root)).toBe('Read ~/.bashrc');
  });
});

describe('Codex hooks', () => {
  it('records apply_patch edits and Codex token totals', () => {
    sb.write('src/a.ts', 'a\n');
    const tr = path.join(sb.root, 'rollout.jsonl');
    fs.writeFileSync(tr, '');
    const codex = (ev: Record<string, unknown>) =>
      handleHook('codex', { session_id: 'cx-1', cwd: sb.project, transcript_path: tr, model: 'gpt-5.5-codex', ...ev }, sb.ctx);
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/new.ts\n+new\n*** End Patch';

    codex({ hook_event_name: 'UserPromptSubmit', prompt: 'change a' });
    codex({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: { command: patch } });
    sb.write('src/a.ts', 'b\n');
    sb.write('src/new.ts', 'new\n');
    codex({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: { command: patch }, tool_response: 'Success' });
    const usage = (n: number) =>
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: n + 40 } } } }) + '\n';
    fs.appendFileSync(tr, usage(500) + usage(900));
    codex({ hook_event_name: 'Stop' });

    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    expect(s.agent).toBe('codex');
    expect(s.steps[1]!.summary).toBe('Patch src/a.ts, src/new.ts');
    expect(s.steps[1]!.files.map((f) => `${f.status} ${f.path}`)).toEqual(['M src/a.ts', 'A src/new.ts']);
    expect(JSON.stringify(s.steps[1]!.input)).not.toContain('Begin Patch');
    expect(s.usage).toEqual({ input: 800, output: 40, cacheRead: 100, cacheWrite: 0 });
    expect(s.model).toBe('gpt-5.5-codex');
  });

  it('parses patch file names', () => {
    expect(patchFiles('*** Begin Patch\n*** Delete File: x.py\n*** Update File: dir/y.py\n*** End Patch')).toEqual(['x.py', 'dir/y.py']);
  });

  it('reads transcripts incrementally', () => {
    const tr = path.join(sb.root, 't2.jsonl');
    const st = { pending: {}, transcriptOffset: 0, usage: emptyUsage(), seen: [] as string[] };
    fs.writeFileSync(tr, assistantLine('a', 10, 1));
    readTranscriptUsage(tr, st);
    fs.appendFileSync(tr, assistantLine('b', 5, 2) + '{"type":"assistant","message":{"id":"c","usage":{"input_tok');
    readTranscriptUsage(tr, st);
    expect(st.usage.input).toBe(15);
    fs.appendFileSync(tr, 'ens":7,"output_tokens":1}}}\n');
    readTranscriptUsage(tr, st);
    expect(st.usage.input).toBe(22);
  });
});

describe('summaries', () => {
  it('drops a leading cd so the real command stays visible', () => {
    expect(stripCd('cd "D:/github/x" && rm -rf old')).toBe('rm -rf old');
    expect(stripCd("cd '/tmp/a b'; ls")).toBe('ls');
    expect(stripCd('cd src && npm test')).toBe('npm test');
    expect(stripCd('npm test && cd x')).toBe('npm test && cd x');
  });
});

describe('subagents', () => {
  it('marks tool calls made by a subagent', () => {
    handleHook('claude-code', { session_id: 'sa', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' }, agent_type: 'Explore' }, sb.ctx);
    handleHook('claude-code', { session_id: 'sa', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'g2', tool_input: { pattern: 'y' } }, sb.ctx);
    const s = loadSession(findSession(openProject(sb.project, sb.ctx))!);
    expect(s.steps.map((x) => x.subagent)).toEqual(['Explore', undefined]);
  });
});
