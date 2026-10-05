import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS, antigravity, copilot, gemini, opencode } from '../src/agents/adapters.js';
import { handleHook } from '../src/agents/hooks.js';
import { applyPlan, hookEntry, hookStatus, planInstall, planUninstall, shArg } from '../src/install.js';
import { openProject } from '../src/store/project.js';
import { listSessions, loadSession } from '../src/store/session.js';
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
