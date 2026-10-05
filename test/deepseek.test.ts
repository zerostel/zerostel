import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deepseek } from '../src/agents/adapters.js';
import { handleHook } from '../src/agents/hooks.js';
import { applyPlan, hookStatus, planInstall, planUninstall } from '../src/install.js';
import { openProject } from '../src/store/project.js';
import { listSessions, loadSession } from '../src/store/session.js';
import { sandbox, type Sandbox } from './helpers.js';

// DeepSeek Harness: a plugin in ~/.zerostel/bin, registered by a marked block
// in the home-level patch ~/.dsh/cordis.patch.yml.

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const linux = () => ({ ...sb.ctx, platform: 'linux' as const });
const patchFile = () => path.join(sb.ctx.dshHome, 'cordis.patch.yml');
const pluginFile = () => path.join(sb.ctx.dataDir, 'bin', 'deepseek-plugin.mjs');

describe('DeepSeek Harness install', () => {
  it('adds a plugin and one marked block, and takes both away again', () => {
    applyPlan(planInstall(linux(), deepseek));
    const text = fs.readFileSync(patchFile(), 'utf8');
    expect(text).toContain('- insert:\n    - id: zerostel\n');
    expect(text).toContain(`name: '${pluginFile().replace(/\\/g, '/')}'`);
    expect(fs.readFileSync(pluginFile(), 'utf8')).toMatch(/export function apply\(ctx\)/);
    expect(hookStatus(linux(), deepseek).installed).toBe(true);

    // installing again replaces the block rather than adding a second one
    applyPlan(planInstall(linux(), deepseek));
    expect(fs.readFileSync(patchFile(), 'utf8').match(/id: zerostel/g)).toHaveLength(1);

    // the file held only Zerostel's block, so it goes, and the plugin with it
    applyPlan(planUninstall(linux(), deepseek));
    expect(fs.existsSync(patchFile())).toBe(false);
    expect(fs.existsSync(pluginFile())).toBe(false);
  });

  it("keeps the user's own patch steps as they were", () => {
    const mine = "# my settings\n- patch:\n    id: llm\n    config:\n      model: 'deepseek-v4-pro'\n";
    fs.mkdirSync(sb.ctx.dshHome, { recursive: true });
    fs.writeFileSync(patchFile(), mine);
    applyPlan(planInstall(linux(), deepseek));
    expect(fs.readFileSync(patchFile(), 'utf8').startsWith(mine.trimEnd() + '\n\n# >>> zerostel')).toBe(true);
    applyPlan(planUninstall(linux(), deepseek));
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(mine);
  });

  it("won't edit a patch file that isn't a list, or whose block has lost its end", () => {
    fs.mkdirSync(sb.ctx.dshHome, { recursive: true });
    fs.writeFileSync(patchFile(), 'insert: []\n');
    expect(() => planInstall(linux(), deepseek)).toThrow(/not a YAML list/);
    const start = '# >>> zerostel: added by `zerostel install`, removed by `zerostel uninstall`';
    fs.writeFileSync(patchFile(), `${start}\n- insert: []\n- patch:\n    id: mine\n`);
    expect(() => planUninstall(linux(), deepseek)).toThrow(/without its/);
    fs.writeFileSync(patchFile(), `${start}\n- insert: []\n# <<< zerostel\n${start}\n- insert: []\n# <<< zerostel\n`);
    expect(() => planUninstall(linux(), deepseek)).toThrow(/more than one/);
  });

  it("leaves the user's lines alone even when they look like Zerostel's markers", () => {
    fs.mkdirSync(sb.ctx.dshHome, { recursive: true });
    const mine = '# >>> zerostel-like notes of my own\n- patch:\n    id: mine\n# <<< zerostel-like\n';
    fs.writeFileSync(patchFile(), mine);
    applyPlan(planInstall(linux(), deepseek));
    applyPlan(planUninstall(linux(), deepseek));
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(mine);
  });
});

describe('DeepSeek Harness plugin', () => {
  it('forwards each step, blocks on a deny, and skips the result of a blocked call', async () => {
    // a stand-in for the zerostel bin: logs what it got, denies the "secret" read
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
        `  process.stdout.write(p.event === 'pre' && p.tool_input?.file_path === 'secret.txt' ? JSON.stringify({ decision: 'deny', reason: 'nope' }) : '{}');`,
        `});`,
      ].join('\n'),
    );
    const file = path.join(sb.root, 'plugin.mjs');
    fs.writeFileSync(file, deepseek.companion!.render({ argv: [process.execPath, fake], unix: () => '', powershell: () => '' }));
    const mod = (await import(pathToFileURL(file).href)) as { name: string; apply: (ctx: unknown) => void };
    expect(mod.name).toBe('zerostel');

    const on: Record<string, (...a: unknown[]) => unknown> = {};
    mod.apply({ on: (event: string, fn: (...a: unknown[]) => unknown) => (on[event] = fn) });
    const agent = { session: { header: { id: 'dsh-1', cwd: sb.project } } };
    const next = async () => ({ kind: 'allow' });
    await on['agent/pre-step']!({ agent, messages: [{ content: [{ type: 'text', text: 'tidy up' }] }] }, async () => ({ kind: 'enter' }));
    expect(await on['tools/pre-execute']!({ agent, name: 'read', callId: 'c1', arguments: { file_path: 'secret.txt' } }, next)).toEqual({ kind: 'deny', reason: 'nope' });
    await on['tools/post-execute']!({ agent, name: 'read', callId: 'c1', arguments: { file_path: 'secret.txt' } }, { isError: true, content: [{ type: 'text', text: 'Error: nope' }] }, next);
    expect(await on['tools/pre-execute']!({ agent, name: 'pwsh', callId: 'c2', arguments: { command: 'npm test' } }, next)).toEqual({ kind: 'allow' });
    await on['tools/post-execute']!({ agent, name: 'pwsh', callId: 'c2', arguments: { command: 'npm test' } }, { isError: true, content: [{ type: 'text', text: '1 failed' }] }, next);
    await on['agent/turn-stopping']!({ agent });

    const got = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(got.map((g) => g.event)).toEqual(['prompt', 'pre', 'pre', 'post-fail', 'stop']);
    expect(got[0]).toMatchObject({ prompt: 'tidy up', session_id: 'dsh-1', cwd: sb.project });
    expect(got[3]).toMatchObject({ tool_name: 'pwsh', tool_response: '1 failed' });
  });

  it("maps dsh's tool names, so summaries and rules work", () => {
    const ev = (e: Record<string, unknown>) => handleHook('deepseek', { session_id: 'd2', cwd: sb.project, ...e }, sb.ctx);
    ev({ event: 'prompt', prompt: 'run the tests' });
    ev({ event: 'pre', tool_name: 'pwsh', tool_use_id: 'a', tool_input: { command: 'npm test', description: 'tests' } });
    ev({ event: 'post-fail', tool_name: 'pwsh', tool_use_id: 'a', tool_input: { command: 'npm test' }, tool_response: '1 failed' });
    const ref = listSessions(openProject(sb.project, sb.ctx)).find((r) => r.agent === 'deepseek')!;
    expect(loadSession(ref).steps.map((s) => [s.summary, s.ok])).toEqual([['run the tests', undefined], ['$ npm test', false]]);
  });
});
