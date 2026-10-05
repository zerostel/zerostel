import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ackFor, antigravity, copilot, cursor, gemini, opencode } from '../src/agents/adapters.js';
import { handleHook } from '../src/agents/hooks.js';
import { STARTER } from '../src/guard/policy.js';
import { applyPlan, planInstall } from '../src/install.js';
import { openProject } from '../src/store/project.js';
import { listSessions, loadSession } from '../src/store/session.js';
import { defaultCtx } from '../src/util/paths.js';
import { sandbox, type Sandbox } from './helpers.js';

// Payload details of the experimental agents, checked against their docs and
// source: what each one sends, and what it expects back.

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

function steps(agent: string) {
  const ref = listSessions(openProject(sb.project, sb.ctx)).find((r) => r.agent === agent)!;
  return loadSession(ref).steps;
}

const writePolicy = (policy: unknown) => {
  fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sb.ctx.dataDir, 'policy.json'), JSON.stringify(policy));
};

describe('Cursor', () => {
  const ev = (e: Record<string, unknown>) => handleHook('cursor', { conversation_id: 'k1', cursor_version: '3.9', workspace_roots: [sb.project], cwd: '', ...e }, sb.ctx);

  it('answers preToolUse with nothing, since "{}" would fail its schema and "allow" could skip its own approval', () => {
    expect(ackFor(cursor, { hook_event_name: 'preToolUse' })).toBeUndefined();
    expect(ackFor(cursor, { hook_event_name: 'beforeSubmitPrompt' })).toBe('{"continue":true}');
    expect(ackFor(cursor, { hook_event_name: 'postToolUse' })).toBe('{}');
    expect(planInstall({ ...sb.ctx, platform: 'linux' }, cursor).after).toContain('"sessionEnd"');
  });

  it('maps outputs, durations, MCP names and the search folder', () => {
    sb.write('a.txt', '1');
    ev({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_use_id: 's1', tool_input: { command: 'echo 2 > a.txt', cwd: '' } });
    sb.write('a.txt', '2');
    ev({ hook_event_name: 'postToolUse', tool_name: 'Shell', tool_use_id: 's1', tool_input: { command: 'echo 2 > a.txt' }, tool_output: '{"output":"","exitCode":0}', duration: 812.4 });
    ev({ hook_event_name: 'preToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'TODO', file_path: path.join(sb.project, 'src') } });
    ev({ hook_event_name: 'preToolUse', tool_name: 'MCP:github:create_issue', tool_use_id: 'm1', tool_input: {} });
    const s = steps('cursor');
    expect(s.map((x) => x.summary)).toEqual(['$ echo 2 > a.txt', 'Grep "TODO" in src', 'MCP github › create_issue']);
    expect(s[0]!.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('records a failed tool, but not a call it was told to block', () => {
    ev({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_use_id: 'f1', tool_input: { command: 'false' } });
    ev({ hook_event_name: 'postToolUseFailure', tool_name: 'Shell', tool_use_id: 'f1', tool_input: { command: 'false' }, error_message: 'exit 1', failure_type: 'error' });
    ev({ hook_event_name: 'postToolUseFailure', tool_name: 'Shell', tool_use_id: 'f2', tool_input: { command: 'rm x' }, error_message: 'blocked', failure_type: 'permission_denied' });
    const s = steps('cursor');
    expect(s.map((x) => [x.summary, x.ok])).toEqual([['$ false', false]]);
  });
});

describe('Antigravity', () => {
  const ev = (event: string, e: Record<string, unknown>) => handleHook('antigravity', { conversationId: 'a1', workspacePaths: [sb.project], ...e }, sb.ctx, event);

  it('starts a turn at the first model call and ends it only when fully idle', () => {
    ev('PreInvocation', { invocationNum: 0, initialNumSteps: 0 });
    ev('PreInvocation', { invocationNum: 1, initialNumSteps: 2 });
    ev('Stop', { fullyIdle: false });
    ev('Stop', { fullyIdle: true, executionNum: 0 });
    expect(steps('antigravity').map((x) => [x.type, x.summary])).toEqual([['prompt', 'New turn'], ['turn', expect.any(String)]]);
    const cfg = JSON.parse(planInstall({ ...sb.ctx, platform: 'linux' }, antigravity).after);
    expect(cfg.zerostel.PreInvocation[0].command).toMatch(/ hook antigravity PreInvocation$/);
    // nothing on stdout: agy reads `{}` on PreToolUse as a denial
    expect(ackFor(antigravity, {})).toBeUndefined();
  });

  it('marks a tool that failed', () => {
    ev('PreToolUse', { stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } });
    ev('PostToolUse', { stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, error: 'exit status 1' });
    expect(steps('antigravity').map((x) => [x.summary, x.ok])).toEqual([['$ npm test', false]]);
  });

  it('unwraps JSON-quoted arguments, so path rules still see the path', () => {
    writePolicy(STARTER);
    const key = path.join(sb.root, '.ssh', 'id_ed25519');
    const res = ev('PreToolUse', { stepIdx: 2, toolCall: { name: 'view_file', args: { AbsolutePath: JSON.stringify(key) } } });
    expect(res.decision?.action).toBe('deny');
  });
});

describe('Copilot CLI', () => {
  const ev = (e: Record<string, unknown>) => handleHook('copilot', { session_id: 'c1', cwd: sb.project, ...e }, sb.ctx);

  it('reads tool_result, and records failures', () => {
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_result: { result_type: 'failure', text_result_for_llm: '1 failed' } });
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'boom' });
    expect(steps('copilot').map((x) => [x.summary, x.ok])).toEqual([['$ npm test', false], ['$ ls', false]]);
    expect(planInstall({ ...sb.ctx, platform: 'linux' }, copilot).after).toContain('"PostToolUseFailure"');
  });

  it('answers a rule in both the documented and the nested form', () => {
    const out = JSON.parse(copilot.decide!({ action: 'deny', reason: 'credentials', rule: 1 }));
    expect(out).toMatchObject({ permissionDecision: 'deny', hookSpecificOutput: { permissionDecision: 'deny' } });
    // "ask" isn't tested in Copilot's headless mode yet, so it blocks with an explanation
    expect(JSON.parse(copilot.decide!({ action: 'ask', reason: 'force push', rule: 3 })).permissionDecisionReason).toMatch(/go-ahead/);
  });

  it('follows COPILOT_HOME', () => {
    const ctx = { ...sb.ctx, copilotDir: path.join(sb.root, 'elsewhere'), platform: 'linux' as const };
    applyPlan(planInstall(ctx, copilot));
    expect(fs.existsSync(path.join(sb.root, 'elsewhere', 'hooks', 'zerostel.json'))).toBe(true);
    // a test home never picks up the real environment
    expect(defaultCtx({ home: sb.root }).copilotDir).toBe(path.join(sb.root, '.copilot'));
  });
});

describe('Gemini CLI', () => {
  it('always prints an answer, so stray stderr never reaches the user', () => {
    expect(ackFor(gemini, { hook_event_name: 'AfterTool' })).toBe('{}');
  });

  it('knows the subagent tool', () => {
    handleHook('gemini', { session_id: 'g1', cwd: sb.project, hook_event_name: 'BeforeTool', tool_name: 'invoke_agent', tool_input: { description: 'review the diff' } }, sb.ctx);
    expect(steps('gemini').map((x) => x.summary)).toEqual(['Subagent: review the diff']);
  });
});

describe('opencode', () => {
  const ev = (e: Record<string, unknown>) => handleHook('opencode', { session_id: 'o1', cwd: sb.project, ...e }, sb.ctx);

  it('checks apply_patch against path rules (GPT models edit with it)', () => {
    writePolicy(STARTER);
    const patch = `*** Begin Patch\n*** Add File: ${path.join(sb.root, '.ssh', 'authorized_keys')}\n+ssh-ed25519 AAAA\n*** End Patch`;
    const res = ev({ event: 'pre', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: { patchText: patch } });
    expect(res.decision?.action).toBe('deny');
  });

  it("doesn't store the text of an edit twice", () => {
    sb.write('x.ts', 'a');
    const input = { filePath: path.join(sb.project, 'x.ts'), oldString: 'a', newString: 'b' };
    ev({ event: 'pre', tool_name: 'edit', tool_use_id: 'e1', tool_input: input });
    sb.write('x.ts', 'b');
    ev({ event: 'post', tool_name: 'edit', tool_use_id: 'e1', tool_input: input });
    const raw = fs.readFileSync(listSessions(openProject(sb.project, sb.ctx))[0]!.file, 'utf8');
    expect(raw).not.toContain('oldString');
    expect(raw).not.toContain('newString');
  });

  it('runs the hook without blocking, forwards a deny as a thrown error, and leaves out synthetic parts', async () => {
    // a stand-in for the zerostel bin: echoes what it got, denies "pre"
    const fake = path.join(sb.root, 'fake-hook.mjs');
    const log = path.join(sb.root, 'got.jsonl');
    fs.writeFileSync(
      fake,
      [
        `import fs from 'node:fs';`,
        `let s = '';`,
        `process.stdin.on('data', (d) => (s += d)).on('end', () => {`,
        `  const p = JSON.parse(s);`,
        `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(p) + '\\n');`,
        `  process.stdout.write(p.event === 'pre' ? JSON.stringify({ decision: 'deny', reason: 'nope' }) : '{}');`,
        `});`,
      ].join('\n'),
    );
    const file = path.join(sb.root, 'plugin.mjs');
    fs.writeFileSync(file, opencode.render!({ argv: [process.execPath, fake], unix: () => '', powershell: () => '' }));
    const mod = (await import(pathToFileURL(file).href)) as { Zerostel: (o: { directory: string; worktree: string }) => Promise<Record<string, (...a: unknown[]) => Promise<void>>> };
    const hooks = await mod.Zerostel({ directory: sb.project, worktree: '/' });
    await expect(hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'ls' } })).rejects.toThrow('nope');
    await hooks['chat.message']!({ sessionID: 's' }, { parts: [{ type: 'text', text: 'fix it' }, { type: 'text', text: 'FILE DUMP', synthetic: true }] });
    await hooks.event!({ event: { type: 'session.status', properties: { sessionID: 's', status: { type: 'idle' } } } });
    // the end of a turn isn't waited for (opencode run exits right after it): give it a moment
    const lines = () => fs.readFileSync(log, 'utf8').trim().split('\n');
    for (let i = 0; i < 100 && lines().length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    const got = lines().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(got.map((g) => g.event)).toEqual(['pre', 'prompt', 'stop']);
    expect(got[1]!.prompt).toBe('fix it');
    // outside a git repository opencode's worktree is "/": the directory is the project
    expect(got.every((g) => g.cwd === sb.project)).toBe(true);
  });
});
