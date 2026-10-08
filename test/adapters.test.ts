import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS, antigravity, claudeCode, copilot, cursor, gemini, GUESTS, opencode } from '../src/agents/adapters.js';
import { handleHook } from '../src/agents/hooks.js';
import { STARTER } from '../src/guard/policy.js';
import { applyPlan, hookEntry, hookStatus, planInstall, planUninstall, shArg } from '../src/install.js';
import { openProject } from '../src/store/project.js';
import { listSessions, loadSession } from '../src/store/session.js';
import { agentName } from '../src/view/timeline.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const linux = () => ({ ...sb.ctx, platform: 'linux' as const });

function steps(agent: string) {
  const p = openProject(sb.project, sb.ctx);
  const ref = listSessions(p).find((r) => r.agent === agent)!;
  return loadSession(ref).steps;
}

describe('adapter registry', () => {
  it('has unique ids and every adapter can describe its install', () => {
    const ids = ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ADAPTERS) {
      const plan = planInstall(linux(), a);
      expect(plan.after.length).toBeGreaterThan(0);
      if (a.layout !== 'owned' && a.layout !== 'block') expect(() => JSON.parse(plan.after)).not.toThrow();
    }
  });

  it('only installs proven agents by default', () => {
    expect(ADAPTERS.filter((a) => !a.experimental).map((a) => a.id)).toEqual(['claude-code', 'codex', 'cursor', 'gemini', 'antigravity', 'copilot', 'opencode']);
  });

  it('leaves plain paths unquoted for agents that split on spaces', () => {
    expect(shArg('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(shArg('/home/a b/node')).toBe("'/home/a b/node'");
    expect(shArg('/x/$(y)')).toBe("'/x/$(y)'");
  });
});

describe('Gemini CLI', () => {
  it('registers millisecond timeouts and records a session', () => {
    applyPlan(planInstall(linux(), gemini));
    const cfg = JSON.parse(fs.readFileSync(path.join(sb.ctx.home, '.gemini', 'settings.json'), 'utf8'));
    expect(cfg.hooks.BeforeTool[0]).toMatchObject({ matcher: '.*', hooks: [{ timeout: 30000 }] });
    expect(hookStatus(linux(), gemini).installed).toBe(true);

    sb.write('a.txt', 'one');
    const ev = (e: Record<string, unknown>) => handleHook('gemini', { session_id: 'g1', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'BeforeAgent', prompt: 'edit a' });
    ev({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'echo two > a.txt' } });
    sb.write('a.txt', 'two');
    ev({ hook_event_name: 'AfterTool', tool_name: 'run_shell_command', tool_input: { command: 'echo two > a.txt' }, tool_response: { llmContent: '' } });
    ev({ hook_event_name: 'BeforeTool', tool_name: 'mcp_github_create_issue', tool_input: { title: 'x' }, mcp_context: { server_name: 'github', tool_name: 'create_issue' } });
    const s = steps('gemini');
    expect(s.map((x) => x.summary)).toEqual(['edit a', '$ echo two > a.txt', 'MCP github › create_issue']);
    expect(s[1]!.files.map((f) => f.path)).toEqual(['a.txt']);
  });
});

describe('Antigravity', () => {
  it('writes one named group and passes the event on the command line', () => {
    applyPlan(planInstall(linux(), antigravity));
    const file = path.join(sb.ctx.home, '.gemini', 'config', 'hooks.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cfg.zerostel.enabled).toBe(true);
    expect(cfg.zerostel.PreToolUse[0].hooks[0].command).toMatch(/ hook antigravity PreToolUse$/);
    expect(cfg.zerostel.Stop[0].command).toMatch(/ hook antigravity Stop$/);
    expect(hookStatus(linux(), antigravity).installed).toBe(true);
    // other groups survive install and uninstall
    cfg.other = { enabled: true, Stop: [{ type: 'command', command: 'echo hi' }] };
    fs.writeFileSync(file, JSON.stringify(cfg));
    applyPlan(planUninstall(linux(), antigravity));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ other: cfg.other });
  });

  it('uses no quotes on Windows', () => {
    const e = hookEntry({ ...sb.ctx, platform: 'win32' }, antigravity, 'C:\\node.exe', 'PreToolUse');
    expect(e.command).toMatch(/zerostel-hook\.cmd antigravity PreToolUse$/);
  });

  it('maps its camelCase payload and pairs pre/post by step', () => {
    sb.write('notes.md', 'a');
    const ev = (event: string, e: Record<string, unknown>) => handleHook('antigravity', { conversationId: 'ag1', workspacePaths: [sb.project], ...e }, sb.ctx, event);
    ev('PreToolUse', { stepIdx: 4, toolCall: { name: 'write_to_file', args: { TargetFile: path.join(sb.project, 'notes.md'), CodeContent: 'b' } } });
    sb.write('notes.md', 'b');
    ev('PostToolUse', { stepIdx: 4, toolCall: { name: 'write_to_file', args: { TargetFile: path.join(sb.project, 'notes.md') } } });
    ev('Stop', {});
    const s = steps('antigravity');
    expect(s[0]!.summary).toBe('Write notes.md');
    expect(s[0]!.files.map((f) => f.path)).toEqual(['notes.md']);
    // without the event name nothing is recorded
    handleHook('antigravity', { conversationId: 'ag2', workspacePaths: [sb.project] }, sb.ctx);
    expect(listSessions(openProject(sb.project, sb.ctx)).map((r) => r.id)).toEqual(['ag1']);
  });
});

describe('Copilot CLI', () => {
  it('owns its own hooks file with bash and powershell commands', () => {
    applyPlan(planInstall(linux(), copilot));
    const file = path.join(sb.ctx.home, '.copilot', 'hooks', 'zerostel.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.PreToolUse[0]).toMatchObject({ type: 'command', timeoutSec: 30 });
    expect(cfg.hooks.PreToolUse[0].bash).toMatch(/ hook copilot$/);
    expect(cfg.hooks.PreToolUse[0].powershell).toMatch(/^& '.*' '.*zerostel\.mjs' hook copilot$/);
    expect(hookStatus(linux(), copilot).installed).toBe(true);
    applyPlan(planUninstall(linux(), copilot));
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(file + '.zerostel.bak')).toBe(false);
  });

  it('keeps a copy when the user added hooks of their own to its file', () => {
    applyPlan(planInstall(linux(), copilot));
    const file = path.join(sb.ctx.home, '.copilot', 'hooks', 'zerostel.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.hooks.Stop = [{ type: 'command', bash: 'echo mine' }];
    fs.writeFileSync(file, JSON.stringify(cfg));
    applyPlan(planUninstall(linux(), copilot));
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(file + '.zerostel.bak', 'utf8')).toContain('echo mine');
  });

  it("uninstall leaves a file with the same name alone if Zerostel didn't write it", () => {
    const file = path.join(sb.ctx.home, '.copilot', 'hooks', 'zerostel.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":1,"hooks":{}}\n');
    const plan = planUninstall(linux(), copilot);
    expect(plan.remove).toBeFalsy();
    expect(plan.warnings.join(' ')).toContain('not written by Zerostel');
    applyPlan(plan);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('reads Claude-format payloads', () => {
    handleHook('copilot', { session_id: 'c1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, sb.ctx);
    expect(steps('copilot').map((x) => x.summary)).toEqual(['hi']);
  });
});

describe('opencode', () => {
  it('writes a plugin that loads and forwards tool calls to the hook', async () => {
    const plan = planInstall(linux(), opencode, undefined, process.execPath);
    applyPlan(plan);
    const file = path.join(sb.ctx.home, '.config', 'opencode', 'plugins', 'zerostel.js');
    expect(fs.existsSync(file)).toBe(true);
    const mod = (await import(pathToFileURL(file).href)) as { Zerostel: (o: { directory: string }) => Promise<Record<string, unknown>> };
    const hooks = await mod.Zerostel({ directory: sb.project });
    expect(Object.keys(hooks).sort()).toEqual(['chat.message', 'event', 'tool.execute.after', 'tool.execute.before']);
    // calling a hook must never throw, even though the bin isn't installed here
    await expect((hooks['tool.execute.before'] as (i: unknown, o: unknown) => Promise<void>)({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} })).resolves.toBeUndefined();
    // nor when the arguments are something JSON can't hold
    const loop: Record<string, unknown> = { n: 10n };
    loop.self = loop;
    await expect((hooks['tool.execute.before'] as (i: unknown, o: unknown) => Promise<void>)({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: loop })).resolves.toBeUndefined();
  });

  it('maps its tool names and arguments', () => {
    sb.write('x.ts', '1');
    const ev = (e: Record<string, unknown>) => handleHook('opencode', { session_id: 'o1', cwd: sb.project, ...e }, sb.ctx);
    ev({ event: 'pre', tool_name: 'edit', tool_use_id: 'k', tool_input: { filePath: path.join(sb.project, 'x.ts') } });
    sb.write('x.ts', '2');
    ev({ event: 'post', tool_name: 'edit', tool_use_id: 'k', tool_input: { filePath: path.join(sb.project, 'x.ts') } });
    const s = steps('opencode');
    expect(s[0]!.summary).toBe('Edit x.ts');
    expect(s[0]!.files.map((f) => f.path)).toEqual(['x.ts']);
  });
});

describe('other agents running Claude Code hooks', () => {
  // captured from Copilot CLI 1.0.91 running a project's .claude/settings.json
  const copilotEnv = (): NodeJS.ProcessEnv => ({ COPILOT_CLI: '1', COPILOT_PROJECT_DIR: sb.project, CLAUDE_PROJECT_DIR: sb.project });
  const fromCopilot = (e: Record<string, unknown>) => ({ session_id: '19511c47', timestamp: '2026-10-08T13:18:08.169Z', cwd: sb.project, ...e });
  const probe = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo zerostel-probe', description: 'Run requested probe command', mode: 'sync', initial_wait: 30 } };
  const probed = { ...probe, hook_event_name: 'PostToolUse', tool_result: { result_type: 'success', text_result_for_llm: 'zerostel-probe\n<shellId: 0 completed with exit code 0>' } };
  const credentials = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat ~/.aws/credentials' } };
  const rules = () => {
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'policy.json'), JSON.stringify(STARTER));
  };
  const agents = () => listSessions(openProject(sb.project, sb.ctx)).map((r) => r.agent);

  it("records a Copilot CLI call once, through Copilot CLI's own hooks", () => {
    applyPlan(planInstall(linux(), copilot));
    rules();
    // Copilot CLI runs both: the project's Claude Code hooks and its own
    for (const e of [{ hook_event_name: 'UserPromptSubmit', prompt: 'run the probe' }, probe, probed]) {
      expect(handleHook('claude-code', fromCopilot(e), sb.ctx, undefined, { env: copilotEnv() })).toEqual({});
      handleHook('copilot', fromCopilot(e), sb.ctx, undefined, { env: copilotEnv() });
    }
    expect(agents()).toEqual(['copilot']);
    expect(steps('copilot').map((x) => x.summary)).toEqual(['run the probe', '$ echo zerostel-probe']);
    // and the rules answer once, from Copilot CLI's hook
    expect(handleHook('claude-code', fromCopilot(credentials), sb.ctx, undefined, { env: copilotEnv() }).decision).toBeUndefined();
    expect(handleHook('copilot', fromCopilot(credentials), sb.ctx, undefined, { env: copilotEnv() }).decision?.action).toBe('deny');
  });

  it("records it as Copilot CLI, answered in its format, when Copilot CLI's own hooks aren't installed", () => {
    for (const e of [probe, probed]) handleHook('claude-code', fromCopilot(e), sb.ctx, undefined, { env: copilotEnv() });
    expect(agents()).toEqual(['copilot']);
    expect(steps('copilot')[0]).toMatchObject({ summary: '$ echo zerostel-probe', ok: true, output: expect.stringContaining('zerostel-probe') });
    rules();
    const res = handleHook('claude-code', fromCopilot(credentials), sb.ctx, undefined, { env: copilotEnv() });
    expect(res.runner).toBe(copilot);
    expect(JSON.parse(res.runner!.decide!(res.decision!))).toMatchObject({ permissionDecision: 'deny' });
  });

  it("doesn't take Copilot CLI's variables alone for Copilot CLI", () => {
    // a Claude Code started from Copilot CLI's shell has COPILOT_CLI=1, but no timestamp in its payloads
    handleHook('claude-code', { session_id: 'cc0', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, sb.ctx, undefined, { env: copilotEnv() });
    expect(agents()).toEqual(['claude-code']);
  });

  it('records an agent Zerostel has no adapter for under its own name, and blocks where a rule asks', () => {
    rules();
    // Continue CLI runs ~/.claude/settings.json with Claude Code's payload
    const env = { CONTINUE_PROJECT_DIR: sb.project, CLAUDE_PROJECT_DIR: sb.project };
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'cn1', cwd: sb.project, ...e }, sb.ctx, undefined, { env });
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'tidy up' });
    const res = ev({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: path.join(sb.project, '.env'), content: 'X=1' } });
    expect(res.runner?.id).toBe('continue');
    expect(res.decision?.action).toBe('ask');
    // it may not know "ask": it's told no, and to get the user's go-ahead
    expect(JSON.parse(res.runner!.decide!(res.decision!)).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining("user's go-ahead") });
    expect(agents()).toEqual(['continue']);
    expect(agentName('continue')).toBe('Continue CLI');
    expect(steps('continue').map((x) => [x.summary, x.guard])).toEqual([
      ['tidy up', undefined],
      ['Write .env', 'deny'],
    ]);
  });

  it('knows Devin, Crush and OpenHands by the variables they set for hooks', () => {
    const cases: [string, NodeJS.ProcessEnv][] = [
      ['devin', { DEVIN_PROJECT_DIR: sb.project }],
      ['crush', { CRUSH: '1', AI_AGENT: 'crush', CRUSH_EVENT: 'PreToolUse' }],
      ['openhands', { OPENHANDS_EVENT_TYPE: 'PreToolUse', OPENHANDS_TOOL_NAME: 'terminal' }],
    ];
    for (const [id, env] of cases) {
      expect(claudeCode.ranBy!({ session_id: 's', hook_event_name: 'PreToolUse' }, env)).toBe(id);
      expect(GUESTS.find((g) => g.id === id)).toMatchObject({ asks: false });
      expect(agentName(id)).not.toBe(id);
    }
    // what Crush puts on everything it starts isn't enough
    expect(claudeCode.ranBy!({ session_id: 's', hook_event_name: 'PreToolUse' }, { CRUSH: '1', AGENT: 'crush', AI_AGENT: 'crush' })).toBeUndefined();
  });

  it("keeps Claude Code's own calls as Claude Code, whatever it inherited", () => {
    // claude started from another agent's hook inherits its variables, and names its own session
    const env = { COPILOT_CLI: '1', CONTINUE_PROJECT_DIR: sb.project, DEVIN_PROJECT_DIR: sb.project, CRUSH_EVENT: 'Stop', OPENHANDS_EVENT_TYPE: 'Stop', CLAUDE_CODE_SESSION_ID: 'cc1' };
    handleHook('claude-code', { session_id: 'cc1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, sb.ctx, undefined, { env });
    expect(agents()).toEqual(['claude-code']);
  });

  it('never takes a call for another agent when Claude Code names the session as its own', () => {
    const inherited = fc.record(
      {
        COPILOT_CLI: fc.constantFrom('1', ''),
        CONTINUE_PROJECT_DIR: fc.string(),
        DEVIN_PROJECT_DIR: fc.string(),
        CRUSH_EVENT: fc.string(),
        OPENHANDS_EVENT_TYPE: fc.string(),
        AI_AGENT: fc.constantFrom('crush', 'claude-code_2-1-293_agent'),
      },
      { requiredKeys: [] },
    );
    // whatever else Claude Code may add to its payload, a timestamp included
    const extra = fc.dictionary(fc.string().filter((k) => k !== 'cursor_version' && k !== 'session_id'), fc.jsonValue(), { maxKeys: 5 });
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), inherited, extra, fc.option(fc.string()), (sid, env, more, timestamp) => {
        const raw = { ...more, ...(timestamp === null ? {} : { timestamp }), session_id: sid, hook_event_name: 'PreToolUse' };
        expect(claudeCode.ranBy!(raw, { ...env, CLAUDE_CODE_SESSION_ID: sid })).toBeUndefined();
      }),
    );
  });

  it("leaves a Cursor call to Cursor's own hooks, and records it as Cursor without them", () => {
    const fromCursor = { conversation_id: 'k1', session_id: 'k1', cursor_version: '3.20', workspace_roots: [sb.project], hook_event_name: 'beforeSubmitPrompt', prompt: 'hello' };
    handleHook('claude-code', fromCursor, sb.ctx);
    expect(agents()).toEqual(['cursor']);
    sb.cleanup();
    sb = sandbox();
    applyPlan(planInstall(linux(), cursor));
    expect(handleHook('claude-code', { ...fromCursor, workspace_roots: [sb.project] }, sb.ctx)).toEqual({});
    expect(fs.existsSync(path.join(sb.ctx.dataDir, 'projects'))).toBe(false);
  });
});
