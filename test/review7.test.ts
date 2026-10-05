import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opencode } from '../src/agents/adapters.js';
import { handleHook } from '../src/agents/hooks.js';
import { normalizePath, STARTER, withMovedFolders } from '../src/guard/policy.js';
import { sandbox, type Sandbox } from './helpers.js';

// Findings from an independent security review of the guard, the agent plugins and install.

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sb.ctx.dataDir, 'policy.json'), JSON.stringify(STARTER));
});
afterEach(() => sb.cleanup());

const pre = (tool: string, tool_input: Record<string, unknown>, id: string) =>
  handleHook('claude-code', { session_id: 'r7', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input }, sb.ctx).decision;

describe('K-01: what goes unchecked is not let through', () => {
  it('asks about a call that names more paths than the rules look at', () => {
    const many = Array.from({ length: 1_200 }, (_, i) => path.join(sb.project, `f${i}.txt`));
    expect(pre('Read', { paths: many }, 'k1')).toMatchObject({ action: 'ask', reason: expect.stringMatching(/too much to check/) });
    expect(pre('Read', { paths: many.slice(0, 10) }, 'k2')).toBeUndefined();
  });

  it('asks about a command too long to read through, and still blocks one it can', () => {
    expect(pre('Bash', { command: `echo ${'a'.repeat(300_000)}` }, 'k3')).toMatchObject({ action: 'ask' });
    expect(pre('Bash', { command: `echo ${'a'.repeat(100_000)} && cat ~/.aws/credentials` }, 'k4')).toMatchObject({ action: 'deny' });
  });

  it('reads paths nested inside the arguments, and bare file names in commands', () => {
    const key = path.join(sb.root, '.ssh', 'id_ed25519');
    expect(pre('MultiEdit', { edits: [{ file_path: key, old_string: 'a', new_string: 'b' }] }, 'k5')).toMatchObject({ action: 'deny' });
    fs.mkdirSync(sb.root + '/.ssh', { recursive: true });
    const cmd = handleHook('claude-code', { session_id: 'r7', cwd: path.join(sb.root, '.ssh'), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'k6', tool_input: { command: 'cat id_ed25519.pub' } }, sb.ctx, undefined, { projectDir: sb.project });
    expect(cmd.decision?.action).toBe('deny');
  });
});

describe('K-02: a plugin keeps a deny it already has', () => {
  it("doesn't wait for the hook to finish recording before acting on its answer", async () => {
    // a stand-in for the hook: answers at once, then keeps busy, as recording would
    const fake = path.join(sb.root, 'slow-hook.mjs');
    fs.writeFileSync(fake, `process.stdin.resume().on('end', () => { process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'nope' })); setTimeout(() => {}, 8000); });`);
    const file = path.join(sb.root, 'plugin.mjs');
    fs.writeFileSync(file, opencode.render!({ argv: [process.execPath, fake], unix: () => '', powershell: () => '' }));
    const mod = (await import(pathToFileURL(file).href)) as { Zerostel: (o: { directory: string }) => Promise<Record<string, (...a: unknown[]) => Promise<void>>> };
    const hooks = await mod.Zerostel({ directory: sb.project });
    const t = Date.now();
    await expect(hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'ls' } })).rejects.toThrow('nope');
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});

describe('K-03: a new file under a linked folder', () => {
  it('is checked where it will really land', () => {
    const ssh = path.join(sb.root, '.ssh');
    fs.mkdirSync(ssh, { recursive: true });
    fs.symlinkSync(ssh, path.join(sb.project, 'keys'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(pre('Write', { file_path: path.join(sb.project, 'keys', 'authorized_keys2'), content: 'x' }, 'k7')).toMatchObject({ action: 'deny' });
  });
});

describe('K-04 and long Windows paths', () => {
  it('moves a rule to a folder that differs only in case', () => {
    const moved = withMovedFolders({ rules: [{ action: 'deny', paths: ['~/.zerostel/**'] }] }, [['~/.zerostel', '/home/me/.Zerostel']], '/home/me');
    expect(moved.rules[0]!.paths).toContain('/home/me/.Zerostel/**');
  });

  // Windows path rules need Windows path handling underneath
  it.skipIf(process.platform !== 'win32')('keeps the server of a \\\\?\\UNC\\ path', () => {
    const call = { home: 'C:\\Users\\me', cwd: 'C:\\proj', platform: 'win32' as const };
    expect(normalizePath('\\\\?\\UNC\\server\\share\\x.txt', call)[0]).toMatch(/^\/\/server\/share\/x\.txt$/);
    expect(normalizePath('\\\\?\\C:\\Users\\me\\.ssh\\id', call)[0]).toMatch(/^C:\/Users\/me\/\.ssh\/id$/i);
  });
});

describe('K-03, follow-up: a path too deep to resolve', () => {
  it('is asked about rather than let through', () => {
    const deep = path.join(sb.project, ...Array.from({ length: 300 }, (_, i) => `d${i}`), 'f.txt');
    expect(pre('Write', { file_path: deep, content: 'x' }, 'k8')).toMatchObject({ action: 'ask', reason: expect.stringMatching(/too deep/) });
    expect(pre('Write', { file_path: path.join(sb.project, 'a', 'b', 'new.txt'), content: 'x' }, 'k9')).toBeUndefined();
  });
});

describe('home and project spelled one way, files resolved another', () => {
  it('matches rules against the real home folder as well as the spelled one', () => {
    // like a CI runner whose home is given by its 8.3 short name (RUNNER~1): here, a link to it
    const realHome = path.join(sb.root, 'real-home');
    fs.mkdirSync(path.join(realHome, '.ssh'), { recursive: true });
    const linkHome = path.join(sb.root, 'home-link');
    fs.symlinkSync(realHome, linkHome, process.platform === 'win32' ? 'junction' : 'dir');
    const ctx = { ...sb.ctx, home: linkHome };
    const res = handleHook('claude-code', { session_id: 'r8', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'h1', tool_input: { file_path: path.join(realHome, '.ssh', 'id_ed25519') } }, ctx);
    expect(res.decision?.action).toBe('deny');
  });
});
