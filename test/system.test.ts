import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { applyRestore, stepTarget, undoTarget } from '../src/commands/rewind.js';
import { evaluate, STARTER } from '../src/guard/policy.js';
import { openProject } from '../src/store/project.js';
import { findSession, loadSession } from '../src/store/session.js';
import { managersTouched, touchesUserEnv, undoCommands, type EnvValue, type SystemProbe } from '../src/system/probe.js';
import { sandbox, type Sandbox } from './helpers.js';

// A pretend machine: global npm packages and a Windows user environment in memory.
function fakeSystem() {
  const npm: Record<string, string> = { typescript: '5.5.0' };
  const env: Record<string, EnvValue> = { PATH: { type: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\bin' } };
  const probe: SystemProbe = {
    packages: (m) => (m === 'npm' ? { ...npm } : null),
    userEnv: {
      read: () => JSON.parse(JSON.stringify(env)),
      set: (name, v) => void (env[name] = v),
      remove: (name) => void delete env[name],
    },
  };
  return { npm, env, probe };
}

let sb: Sandbox;
let sys: ReturnType<typeof fakeSystem>;
beforeEach(() => {
  sb = sandbox();
  sys = fakeSystem();
  sb.ctx.system = sys.probe;
  sb.ctx.platform = 'win32';
  sb.write('a.txt', 'a\n');
});
afterEach(() => sb.cleanup());

function shell(id: string, command: string, effect: () => void) {
  const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 's', cwd: sb.project, ...e }, sb.ctx);
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command } });
  effect();
  ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: {} });
}

describe('things outside any project', () => {
  it('spots commands that change global packages or the user environment', () => {
    expect(managersTouched('npm install -g typescript')).toEqual(['npm']);
    expect(managersTouched('npm i typescript --global')).toEqual(['npm']);
    expect(managersTouched('npm install typescript')).toEqual([]);
    expect(managersTouched('python -m pip install requests')).toEqual(['pip']);
    expect(managersTouched('brew upgrade')).toEqual(['brew']);
    expect(touchesUserEnv('setx API_URL http://x')).toBe(true);
    expect(touchesUserEnv('[Environment]::SetEnvironmentVariable("A","1","User")')).toBe(true);
    expect(touchesUserEnv('echo hi')).toBe(false);
  });

  it('records global package changes with the commands that would undo them, and says so on rewind', () => {
    handleHook('claude-code', { session_id: 's', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'tools' }, sb.ctx);
    shell('n1', 'npm install -g typescript@5.6.2 eslint', () => {
      sys.npm.typescript = '5.6.2';
      sys.npm.eslint = '9.0.0';
    });
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    const step = s.steps.find((x) => x.type === 'packages')!;
    expect(step.summary).toMatch(/npm -g: \+eslint 9\.0\.0, typescript 5\.5\.0 → 5\.6\.2/);
    expect(step.undo).toEqual(['npm uninstall -g eslint', 'npm install -g typescript@5.5.0']);
    const plan = applyRestore(p, s.ref, stepTarget(s, s.steps.find((x) => x.type === 'tool')!.n), { dryRun: true, ctx: sb.ctx });
    expect(plan.packages?.[0]?.undo).toEqual(step.undo);
    expect(sys.npm.eslint).toBe('9.0.0'); // never run for you
  });

  it('puts Windows user environment variables back on rewind, and undoing the rewind restores them again', () => {
    handleHook('claude-code', { session_id: 's', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'env' }, sb.ctx);
    shell('e1', 'setx API_URL http://localhost:9000 && setx PATH C:\\tools', () => {
      sys.env.API_URL = { type: 'REG_SZ', value: 'http://localhost:9000' };
      sys.env.PATH = { type: 'REG_SZ', value: 'C:\\tools' };
    });
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    const envStep = s.steps.find((x) => x.type === 'userenv')!;
    expect(envStep.summary).toBe('User environment: API_URL, PATH');
    expect(JSON.stringify(envStep)).not.toContain('localhost:9000'); // values stay out of the step

    const t = stepTarget(s, s.steps.find((x) => x.type === 'tool')!.n);
    expect(applyRestore(p, s.ref, t, { dryRun: true, ctx: sb.ctx }).env).toEqual(['API_URL', 'PATH']);
    expect(sys.env.API_URL).toBeDefined();
    applyRestore(p, s.ref, t, { ctx: sb.ctx });
    expect(sys.env.API_URL).toBeUndefined();
    expect(sys.env.PATH).toEqual({ type: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\bin' });

    const again = loadSession(findSession(p)!);
    applyRestore(p, again.ref, undoTarget(again)!, { ctx: sb.ctx });
    expect(sys.env.API_URL?.value).toBe('http://localhost:9000');
    expect(sys.env.PATH?.value).toBe('C:\\tools');
  });

  it('leaves the machine alone in tests unless a fake is given', () => {
    const fresh = sandbox();
    try {
      expect(fresh.ctx.system).toBeNull();
    } finally {
      fresh.cleanup();
    }
  });

  it('starter rules ask before installing globally, changing settings or deploying', () => {
    const call = (command: string) => evaluate(STARTER, { tool: 'Bash', paths: [], command, writes: true, root: sb.project, cwd: sb.project, home: sb.root, platform: 'linux' });
    for (const c of ['sudo rm -rf /opt/x', 'npm install -g typescript', 'pip install --user requests', 'setx PATH x', 'terraform apply', 'npm publish', 'psql -c "DROP TABLE users"'])
      expect(call(c)?.action, c).toBe('ask');
    expect(call('npm install typescript')).toBeNull();
    expect(undoCommands('pip', { added: { a: '1' }, removed: { b: '2' }, changed: {} })).toEqual(['pip uninstall -y a', 'pip install b==2']);
  });
});
