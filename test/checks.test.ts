import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { agentCheckResult, checkKind, checkStatuses, failingStreaks, renderChecks, testsTouched } from '../src/commands/checks.js';
import { handleMessage } from '../src/mcp/server.js';
import { renderReport } from '../src/report/html.js';
import { openProject } from '../src/store/project.js';
import { findSession, loadSession } from '../src/store/session.js';
import { snapshot } from '../src/store/shadow.js';
import { renderTimeline } from '../src/view/timeline.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.write('src/app.ts', 'export const x = 1;\n');
  sb.write('test/app.test.ts', 'test("x", () => {});\n');
  sb.write('test/old.test.ts', 'test("old", () => {});\n');
});
afterEach(() => sb.cleanup());

const ev = (e: Record<string, unknown>, agent = 'claude-code') => handleHook(agent, { session_id: 'c1', cwd: sb.project, ...e }, sb.ctx);
let n = 0;
function shell(command: string, opts: { fail?: boolean; effect?: () => void; response?: Record<string, unknown>; agent?: string } = {}) {
  const id = `t${++n}`;
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command } }, opts.agent);
  opts.effect?.();
  ev({ hook_event_name: opts.fail ? 'PostToolUseFailure' : 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: opts.response ?? {} }, opts.agent);
}
function edit(file: string, content: string) {
  const id = `e${++n}`;
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: path.join(sb.project, file) } });
  sb.write(file, content);
  ev({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: path.join(sb.project, file) }, tool_response: {} });
}
const session = () => loadSession(findSession(openProject(sb.project, sb.ctx))!);

describe('which commands are checks', () => {
  it('knows tests, type checks, linters and builds, and nothing else', () => {
    expect(checkKind('npm test')).toBe('test');
    expect(checkKind('cd web && pnpm run test -- --run')).toBe('test');
    expect(checkKind('CI=1 npx vitest run test/app.test.ts')).toBe('test');
    expect(checkKind('python -m pytest -q')).toBe('test');
    expect(checkKind('go test ./...')).toBe('test');
    expect(checkKind('./gradlew clean test')).toBe('test');
    expect(checkKind('npx tsc --noEmit')).toBe('typecheck');
    expect(checkKind('npm run lint')).toBe('lint');
    expect(checkKind('cargo build --release')).toBe('build');
    // a build and a test in one: the test is what says the most
    expect(checkKind('npm run build && npm test')).toBe('test');
    for (const other of ['ls -la', 'git status', 'echo test', 'cat test/app.test.ts', 'rm -rf test', 'npm install', 'testing.sh']) expect(checkKind(other), other).toBeNull();
  });

  it("takes an agent's report of the result only when it actually reports one", () => {
    expect(agentCheckResult('codex', false, { exit_code: 1 }, '')).toBe(false);
    expect(agentCheckResult('codex', false, { exit_code: 0 }, '')).toBe(true);
    expect(agentCheckResult('codex', false, {}, 'Exit code 2')).toBe(false);
    expect(agentCheckResult('claude-code', true, {}, '')).toBe(false);
    expect(agentCheckResult('claude-code', false, {}, '')).toBe(true);
    // no failure event and nothing in the output: unknown, not "passed"
    expect(agentCheckResult('codex', false, {}, 'all good')).toBeUndefined();
  });
});

describe('checks tied to the code they ran against', () => {
  it('says a pass is out of date once the code changes after it', () => {
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'fix x' });
    edit('src/app.ts', 'export const x = 2;\n');
    shell('npm test');
    const p = openProject(sb.project, sb.ctx);
    let st = checkStatuses(p, session(), snapshot(p, 'now').sha);
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ name: 'npm test', kind: 'test', latest: { ok: true, by: 'agent' }, freshness: { state: 'current' } });
    // the agent edits again after testing: the old pass doesn't cover this
    edit('src/app.ts', 'export const x = 3;\n');
    st = checkStatuses(p, session(), snapshot(p, 'now').sha);
    expect(st[0]!.freshness.state).toBe('stale');
    expect(st[0]!.freshness.state === 'stale' && st[0]!.freshness.files.map((f) => f.path)).toEqual(['src/app.ts']);
    const text = renderChecks(p, session(), snapshot(p, 'now').sha).join('\n');
    expect(text).toMatch(/passed at #\d+ \(as the agent reported it\)/);
    expect(text).toMatch(/out of date: 1 file changed since \(src\/app\.ts\)/);
  });

  it('notices a check that passed and then failed, and tests that were deleted', () => {
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'refactor' });
    shell('npm test');
    edit('src/app.ts', 'export const x = "broken";\n');
    shell('npm test', { fail: true });
    shell('rm test/old.test.ts', { effect: () => fs.rmSync(path.join(sb.project, 'test', 'old.test.ts')) });
    const p = openProject(sb.project, sb.ctx);
    const now = snapshot(p, 'now').sha;
    const [st] = checkStatuses(p, session(), now);
    expect(st!.latest.ok).toBe(false);
    expect(st!.passedBefore?.ok).toBe(true);
    expect(testsTouched(p, session(), now).map((f) => `${f.path}:${f.status}`)).toEqual(['test/old.test.ts:D']);
    const text = renderChecks(p, session(), now).join('\n');
    expect(text).toMatch(/passed at #\d+, failing since/);
    expect(text).toMatch(/Test files changed in this session: test\/old\.test\.ts \(deleted\)/);
    // and the timeline marks the runs
    const log = renderTimeline(session(), { width: 140 }).join('\n');
    expect(log).toMatch(/✓ test passed/);
    expect(log).toMatch(/✗ test failed/);
  });

  it('notices an agent going in circles on a failing check', () => {
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'make the tests pass' });
    for (let i = 0; i < 4; i++) {
      edit('src/app.ts', `export const x = ${10 + i};\n`);
      shell('npm test', { fail: true });
    }
    const s = session();
    expect(failingStreaks(s)).toEqual([expect.objectContaining({ name: 'npm test', count: 4 })]);
    const p = openProject(sb.project, sb.ctx);
    expect(renderChecks(p, s, null).join('\n')).toMatch(/npm test failed 4 times in a row \(#\d+ to #\d+\): the agent may be going in circles/);
    // a pass ends the streak
    shell('npm test');
    expect(failingStreaks(session())).toEqual([]);
  });

  it("doesn't call an unreported result a pass", () => {
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'codex');
    shell('npm test', { agent: 'codex' });
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p, 'c1')!);
    expect(checkStatuses(p, s, null)[0]!.latest.ok).toBeUndefined();
    expect(renderChecks(p, s, null).join('\n')).toMatch(/result not reported by the agent/);
  });

  it('go into the report, without the command in the shared version', () => {
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    shell('npm test -- --secret-flag');
    edit('src/app.ts', 'export const x = 5;\n');
    const p = openProject(sb.project, sb.ctx);
    const full = renderReport(p, session());
    expect(full).toMatch(/<b>Checks<\/b>[\s\S]*<code>npm test -- --secret-flag<\/code>: passed at <a href="#s\d+">#\d+<\/a>; <span class="warn">out of date<\/span>: 1 file changed after it ran/);
    const shared = renderReport(p, session(), { share: true });
    expect(shared).toMatch(/<b>Checks<\/b>[\s\S]*test: passed/);
    expect(shared).not.toMatch(/secret-flag/);
  });

  it('are there for the agent too, through MCP', () => {
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    shell('npx tsc --noEmit');
    edit('src/app.ts', 'export const x = 4;\n');
    const res = handleMessage(sb.ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'checks', arguments: {} } }) as { result: { content: { text: string }[] } };
    expect(res.result.content[0]!.text).toMatch(/npx tsc --noEmit[\s\S]*out of date/);
  });
});
