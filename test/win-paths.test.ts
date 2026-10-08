import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { evaluate, type Policy } from '../src/guard/policy.js';
import { guardThisProcess, guardWindowsPaths, UNPASSABLE } from '../src/util/win-paths.js';
import { sandbox, type Sandbox } from './helpers.js';

// On Windows, Node aborts the whole process on a path, argument, working folder
// or environment value holding U+10FFFF (libuv's UTF-8 to UTF-16 conversion
// asserts). A tool call naming such a path stopped Zerostel's hook dead before
// the guardrails had answered.

const X = `x${UNPASSABLE}`;

function standIns() {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push(name);
    return args[0];
  };
  const realpathSync = Object.assign(rec('realpathSync'), { native: rec('realpathSync.native') });
  const execFile = Object.assign(rec('execFile'), { [promisify.custom]: rec('execFile.custom') });
  class Stats {}
  const fsMod: Record<string, unknown> = {
    statSync: rec('statSync'), realpathSync, existsSync: () => true, writeFileSync: rec('writeFileSync'), writeSync: rec('writeSync'),
    renameSync: rec('renameSync'), readFile: (_p: unknown, cb: (e: unknown) => void) => cb(null), Stats, constants: { F_OK: 0 },
  };
  const fspMod: Record<string, unknown> = { readFile: async () => 'data', rename: async () => undefined };
  const cpMod: Record<string, unknown> = { spawnSync: rec('spawnSync'), execFile };
  return { calls, fs: fsMod, fsp: fspMod, cp: cpMod, Stats };
}

describe('paths Windows would abort on', () => {
  it('are only a problem on Windows: elsewhere such a path is checked like any other', () => {
    if (process.platform === 'win32') return;
    const sb = sandbox();
    try {
      const policy: Policy = { rules: [{ action: 'deny', paths: ['secrets/**'] }] };
      const call = { tool: 'Read', paths: [`secrets/${X}`], writes: false, root: sb.project, cwd: sb.project, home: sb.root, platform: process.platform };
      expect(evaluate(policy, call)?.action).toBe('deny');
      expect(evaluate(policy, { ...call, paths: [`src/${X}`] })).toBeNull();
    } finally {
      sb.cleanup();
    }
  });

  it('are left alone everywhere but Windows', () => {
    const m = standIns();
    const before = { ...m.fs };
    expect(guardWindowsPaths('linux', m)).toBe(false);
    expect(m.fs).toEqual(before);
  });

  it('become ordinary errors on Windows, in file and process calls alike', async () => {
    const m = standIns();
    expect(guardWindowsPaths('win32', m)).toBe(true);
    type Fn = (...a: unknown[]) => unknown;
    const f = m.fs as unknown as { statSync: Fn; renameSync: Fn; existsSync: Fn; writeFileSync: Fn; writeSync: Fn; readFile: Fn; realpathSync: { native: Fn } };
    expect(() => f.statSync(X)).toThrow(expect.objectContaining({ code: 'EINVAL' }));
    expect(() => f.realpathSync.native(X)).toThrow(/U\+10FFFF/);
    expect(() => f.renameSync('ok', X)).toThrow(/U\+10FFFF/);
    expect(() => f.statSync(Buffer.from(X))).toThrow(/U\+10FFFF/);
    expect(() => f.statSync(new URL(`file:///C:/${encodeURIComponent(X)}`))).toThrow(/U\+10FFFF/);
    // a path that can't be asked about doesn't exist, as far as the caller can tell
    expect(f.existsSync(X)).toBe(false);
    // ordinary paths go through; data is never looked at
    expect(f.statSync('ok')).toBe('ok');
    expect(f.realpathSync.native('ok')).toBe('ok');
    f.writeFileSync('ok', `data ${UNPASSABLE}`);
    f.writeSync(1, `data ${UNPASSABLE}`);
    expect(m.calls).toEqual(['statSync', 'realpathSync.native', 'writeFileSync', 'writeSync']);
    // callbacks get the error; promises reject
    await expect(new Promise((resolve) => f.readFile(X, resolve))).resolves.toMatchObject({ code: 'EINVAL' });
    await expect((m.fsp as unknown as { readFile: (...a: unknown[]) => Promise<unknown>; rename: (...a: unknown[]) => Promise<unknown> }).readFile(X)).rejects.toThrow(/U\+10FFFF/);
    await expect((m.fsp as unknown as { readFile: (...a: unknown[]) => Promise<unknown>; rename: (...a: unknown[]) => Promise<unknown> }).rename('ok', X)).rejects.toThrow(/U\+10FFFF/);
    // programs: arguments, the working folder and the environment
    const c = m.cp as unknown as { spawnSync: Fn; execFile: Record<symbol, Fn> };
    expect(() => c.spawnSync('git', ['status', X])).toThrow(/U\+10FFFF/);
    expect(() => c.spawnSync('git', ['status'], { cwd: X })).toThrow(/U\+10FFFF/);
    expect(() => c.spawnSync('git', ['status'], { env: { A: X } })).toThrow(/U\+10FFFF/);
    expect(c.spawnSync('git', ['status'], { cwd: 'ok' })).toBe('git');
    expect(() => c.execFile[promisify.custom]!('git', [X])).toThrow(/U\+10FFFF/);
    // classes and constants stay as they are, and guarding twice wraps nothing twice
    expect(m.fs.Stats).toBe(m.Stats);
    const once = m.fs.statSync;
    guardWindowsPaths('win32', m);
    expect(m.fs.statSync).toBe(once);
  });
});

describe.runIf(process.platform === 'win32')('on this Windows machine', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox();
    guardThisProcess();
  });
  afterEach(() => sb.cleanup());

  it("Node's own calls throw instead of ending the process", async () => {
    expect(() => fs.statSync(path.join(sb.project, X))).toThrow(/U\+10FFFF/);
    expect(() => fs.realpathSync.native(path.join(sb.project, X))).toThrow(/U\+10FFFF/);
    expect(fs.existsSync(path.join(sb.project, X))).toBe(false);
    await expect(fs.promises.stat(path.join(sb.project, X))).rejects.toThrow(/U\+10FFFF/);
    const { spawnSync } = await import('node:child_process');
    expect(() => spawnSync('git', ['--version', X])).toThrow(/U\+10FFFF/);
  });

  it('make the guardrails ask about a call that names one', () => {
    const policy: Policy = { rules: [{ action: 'deny', paths: ['secrets/**'] }] };
    const call = { tool: 'Read', paths: [`secrets/${X}`], writes: false, root: sb.project, cwd: sb.project, home: sb.root, platform: 'win32' as const };
    // under a denied folder: denied as written, whatever the real path
    expect(evaluate(policy, call)?.action).toBe('deny');
    // elsewhere: asked about, since where it leads can't be looked up
    expect(evaluate(policy, { ...call, paths: [`src/${X}`] })).toMatchObject({ action: 'ask', rule: 0 });
    expect(evaluate(policy, { ...call, tool: 'Bash', paths: [], command: `cat src/${X}` })).toMatchObject({ action: 'ask', rule: 0 });
    // with no rules about paths or commands, there is nothing to ask about
    expect(evaluate({ rules: [{ action: 'deny', tools: ['WebFetch'] }] }, { ...call, paths: [`src/${X}`] })).toBeNull();
  });

  it('a hook still answers for a tool call that names such a path', () => {
    fs.mkdirSync(path.join(sb.root, '.zerostel'), { recursive: true });
    fs.writeFileSync(path.join(sb.root, '.zerostel', 'policy.json'), JSON.stringify({ rules: [{ action: 'deny', commands: ['rm -rf *'] }] }));
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'w1', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'tidy up' });
    const r = ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: `cat ${X}; rm -rf build` } });
    expect(r.decision?.action).toBe('deny');
  });
});
