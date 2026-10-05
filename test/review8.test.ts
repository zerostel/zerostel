import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { checkName, checkStatuses, renderChecks, resultMasked } from '../src/commands/checks.js';
import { checkHandoff, renderHandoff } from '../src/commands/handoff.js';
import { applyRestore, changedByOthers, rewindTarget } from '../src/commands/rewind.js';
import { evaluate, normalizePath } from '../src/guard/policy.js';
import { openProject } from '../src/store/project.js';
import { append, findSession, loadSession, newId, now, sessionRef } from '../src/store/session.js';
import { restore, snapshot } from '../src/store/shadow.js';
import { renderReport } from '../src/report/html.js';
import { sandbox, type Sandbox } from './helpers.js';

// Fixes from the review of checks, handoffs and --keep-others.

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

describe('R8-1: secrets in check commands', () => {
  it('are masked when recorded, and when shown', () => {
    expect(checkName(`GITHUB_TOKEN=${TOKEN} npm test`)).not.toContain(TOKEN);
    expect(checkName(`npm test -- --password=hunter2secret`)).not.toContain('hunter2secret');
    // a long command cut short still has its token masked first
    expect(checkName(`npm test -- ${'x'.repeat(100)} ${TOKEN}`)).not.toMatch(/ghp_a1B2/);
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 's', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: `GITHUB_TOKEN=${TOKEN} npm test` } });
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: `GITHUB_TOKEN=${TOKEN} npm test` }, tool_response: {} });
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    expect(fs.readFileSync(s.ref.file, 'utf8')).not.toContain(TOKEN);
    expect(renderChecks(p, s, null).join('\n')).not.toContain(TOKEN);
    expect(renderHandoff(p, s, null, { version: 't' })).not.toContain(TOKEN);
  });
});

describe('R8-2/3: handoff text', () => {
  it('has no terminal escapes, and no code span a backtick run can end', () => {
    const p = openProject(sb.project, sb.ctx);
    const ref = sessionRef(p, 'claude-code', 'esc');
    const s1 = snapshot(p, 's').sha;
    append(ref, { e: 'start', ts: now(), agent: 'claude-code', session: 'esc', cwd: sb.project });
    append(ref, { e: 'check', ts: now(), id: newId(), name: 'npm test "\x1b]0;PWNED\x07\x1b[2J a``<img src=x onerror=alert(1)>"', kind: 'test', snap: s1, ok: false, by: 'agent' });
    const text = renderHandoff(p, loadSession(ref), s1, { version: 't' });
    expect(text).not.toMatch(/[\x1b\x07]/);
    // the name sits in a span fenced by more backticks than any run inside it
    expect(text).toContain('``` npm test "]0;PWNED[2J a``<img src=x onerror=alert(1)>" ```');
  });
});

describe('R8-4: report --share', () => {
  it("doesn't show the command of a check run with zerostel check", () => {
    const p = openProject(sb.project, sb.ctx);
    const ref = sessionRef(p, 'manual', 'checkpoints');
    const s1 = snapshot(p, 's').sha;
    append(ref, { e: 'start', ts: now(), agent: 'manual', session: 'checkpoints', cwd: sb.project });
    append(ref, { e: 'check', ts: now(), id: newId(), name: './ci.sh --customer AcmeBank --host db-prod-7.internal', kind: 'test', snap: s1, ok: true, by: 'zerostel' });
    const shared = renderReport(p, loadSession(ref), { share: true });
    expect(shared).not.toMatch(/AcmeBank|db-prod-7/);
    expect(shared).toMatch(/Check \(test\)/);
  });
});

describe('R8-5: --keep-others and a file that became a folder', () => {
  const twoSessions = (mine: () => void, theirs: () => void) => {
    const claude = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'mine', cwd: sb.project, ...e }, sb.ctx);
    const codex = (e: Record<string, unknown>) => handleHook('codex', { session_id: 'theirs', cwd: sb.project, ...e }, sb.ctx);
    const run = (ev: typeof claude, id: string, effect: () => void) => {
      ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'x' } });
      effect();
      ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'x' }, tool_response: {} });
    };
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'mine' });
    run(claude, 'm1', mine);
    codex({ hook_event_name: 'UserPromptSubmit', prompt: 'theirs' });
    run(codex, 't1', theirs);
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p, 'mine')!);
    const t = rewindTarget(s, '1');
    return { p, s, t, others: changedByOthers(p, s, t) };
  };

  it('keeps a file inside a folder that replaced a file', () => {
    sb.write('a', 'a file\n');
    const { p, s, t, others } = twoSessions(
      () => {
        fs.rmSync(path.join(sb.project, 'a'));
        sb.write('a/mine.txt', 'mine\n');
      },
      () => sb.write('a/theirs.txt', 'theirs\n'),
    );
    expect(others.get('a/theirs.txt')).toMatch(/Codex/);
    const r = applyRestore(p, s.ref, t, { keep: [...others.keys()] });
    expect(sb.read('a/theirs.txt')).toBe('theirs\n');
    expect(r.failed.map((f) => f.path)).toContain('a');
  });

  it('keeps a file that took the place of a folder', () => {
    sb.write('a/x.txt', 'x\n');
    const { p, s, t, others } = twoSessions(
      () => fs.rmSync(path.join(sb.project, 'a'), { recursive: true }),
      () => sb.write('a', 'their file\n'),
    );
    const r = applyRestore(p, s.ref, t, { keep: [...others.keys()] });
    expect(sb.read('a')).toBe('their file\n');
    expect(r.failed.map((f) => f.path)).toContain('a/x.txt');
  });
});

describe("R8-6: whose change it was", () => {
  it("doesn't blame another session for this session's own edits", () => {
    sb.write('mine.txt', '1\n');
    sb.write('theirs.txt', '1\n');
    const a = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'A', cwd: sb.project, ...e }, sb.ctx);
    const b = (e: Record<string, unknown>) => handleHook('codex', { session_id: 'B', cwd: sb.project, ...e }, sb.ctx);
    const write = (ev: typeof a, id: string, file: string) => {
      ev({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: id, tool_input: { file_path: path.join(sb.project, file) } });
      sb.write(file, `changed by ${id}\n`);
      ev({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: id, tool_input: { file_path: path.join(sb.project, file) }, tool_response: {} });
    };
    a({ hook_event_name: 'UserPromptSubmit', prompt: 'a' });
    b({ hook_event_name: 'UserPromptSubmit', prompt: 'b' });
    write(a, 'a1', 'mine.txt');
    // B's next hook sees A's edit as a change from outside
    write(b, 'b1', 'theirs.txt');
    a({ hook_event_name: 'Stop' });
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p, 'A')!);
    const others = changedByOthers(p, s, rewindTarget(s, '1'));
    expect(others.has('mine.txt')).toBe(false);
    expect(others.get('theirs.txt')).toMatch(/Codex/);
    applyRestore(p, s.ref, rewindTarget(s, '1'), { keep: [...others.keys()] });
    expect(sb.read('mine.txt')).toBe('1\n');
    expect(sb.read('theirs.txt')).toBe('changed by b1\n');
  });
});

describe('R8-7: a check whose exit status is hidden', () => {
  it("isn't counted as passed", () => {
    for (const masked of ['npm test 2>&1 | tail -20', 'npx vitest run || true', 'npm test; echo done', 'npm test & sleep 1', 'npm test && echo ok || echo no'])
      expect(resultMasked(masked), masked).toBe(true);
    for (const real of ['npm test', 'cd web && npm test', 'npm test 2>&1', 'set -o pipefail; npm test | tail', 'npm run build && npm test', 'npm test -- --grep "a|b"'])
      expect(resultMasked(real), real).toBe(false);
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'm', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'npm test 2>&1 | tail -20' } });
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'npm test 2>&1 | tail -20' }, tool_response: {} });
    const p = openProject(sb.project, sb.ctx);
    expect(checkStatuses(p, loadSession(findSession(p)!), null)[0]!.latest.ok).toBeUndefined();
  });
});

describe('a program writing while a rewind runs', () => {
  // another program writes the file just after the rewind has checked it
  const writeAfterCheck = (file: string, content: string) => {
    const real = fs.lstatSync;
    let done = false;
    return vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = real(p, o as fs.StatSyncOptions);
      if (!done && path.resolve(String(p)) === path.resolve(file)) {
        done = true;
        fs.writeFileSync(file, content);
      }
      return st;
    }) as typeof fs.lstatSync);
  };

  it("doesn't delete what was written after the backup", () => {
    sb.write('a.txt', 'a\n');
    const p = openProject(sb.project, sb.ctx);
    const s1 = snapshot(p, 's1').sha;
    sb.write('b.txt', 'b\n');
    snapshot(p, 's2');
    const spy = writeAfterCheck(path.join(sb.project, 'b.txt'), 'written meanwhile, and longer\n');
    try {
      const r = restore(p, s1);
      expect(r.failed.map((f) => f.path)).toEqual(['b.txt']);
    } finally {
      spy.mockRestore();
    }
    expect(sb.read('b.txt')).toBe('written meanwhile, and longer\n');
  });

  it("doesn't overwrite it either", () => {
    sb.write('a.txt', 'v1\n');
    const p = openProject(sb.project, sb.ctx);
    const s1 = snapshot(p, 's1').sha;
    sb.write('a.txt', 'v2\n');
    const spy = writeAfterCheck(path.join(sb.project, 'a.txt'), 'v3, written meanwhile\n');
    try {
      const r = restore(p, s1);
      expect(r.failed.map((f) => f.path)).toEqual(['a.txt']);
    } finally {
      spy.mockRestore();
    }
    expect(sb.read('a.txt')).toBe('v3, written meanwhile\n');
  });
});

describe('R8-UNC: a network path in a tool call', () => {
  it.skipIf(process.platform !== 'win32')("isn't looked up, so checking it can't connect to the server", () => {
    const seen: string[] = [];
    const real = fs.realpathSync.native;
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
      seen.push(String(p));
      return real(p);
    }) as typeof fs.realpathSync.native);
    try {
      const call = { home: sb.root, cwd: sb.project, platform: 'win32' as const };
      expect(normalizePath('\\\\attacker.example\\share\\x.txt', call)).toEqual(['//attacker.example/share/x.txt']);
      expect(normalizePath('//attacker.example/share/x.txt', call)).toEqual(['//attacker.example/share/x.txt']);
      expect(normalizePath('\\\\?\\UNC\\attacker.example\\share\\x', call)).toEqual(['//attacker.example/share/x']);
      expect(seen.filter((p) => /attacker/i.test(p))).toEqual([]);
      // and a rule about it still applies
      const policy = { rules: [{ action: 'deny' as const, paths: ['//attacker.example/**'] }] };
      expect(evaluate(policy, { tool: 'Read', paths: ['\\\\attacker.example\\share\\x.txt'], writes: false, root: sb.project, cwd: sb.project, home: sb.root, platform: 'win32' })?.action).toBe('deny');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('R9: second look at checks, handoffs and --keep-others', () => {
  it('keeps an edit made by hand after the agent finished, before any hook saw it', () => {
    sb.write('a.txt', 'a1\n');
    sb.write('b.txt', 'b1\n');
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'late', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'change a and b' });
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'edit' } });
    sb.write('a.txt', 'a2\n');
    sb.write('b.txt', 'b2\n');
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'edit' }, tool_response: {} });
    ev({ hook_event_name: 'Stop' });
    // the agent is done; you fix b.txt in your editor, and no hook runs after that
    sb.write('b.txt', 'b3, my own fix\n');
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p, 'late')!);
    const t = rewindTarget(s, '1');
    const others = changedByOthers(p, s, t);
    expect(others.get('b.txt')).toBe('edits outside the agent, not recorded yet');
    expect(others.has('a.txt')).toBe(false);
    applyRestore(p, s.ref, t, { keep: [...others.keys()] });
    expect(sb.read('a.txt')).toBe('a1\n');
    expect(sb.read('b.txt')).toBe('b3, my own fix\n');
  });

  it('says every check passed only when every one did, on the code as it is now', () => {
    const p = openProject(sb.project, sb.ctx);
    const ref = sessionRef(p, 'claude-code', 'h');
    append(ref, { e: 'start', ts: now(), agent: 'claude-code', session: 'h', cwd: sb.project });
    append(ref, { e: 'prompt', ts: now(), id: newId(), text: 'look around' });
    const s1 = snapshot(p, 's').sha;
    // no checks, no changes: nothing was confirmed
    const none = renderHandoff(p, loadSession(ref), s1, { version: 't' });
    expect(none).not.toMatch(/passed on the code as it is now/);
    expect(none).toMatch(/nothing has been confirmed/);
    // a pass whose freshness can't be told is not "current"
    append(ref, { e: 'check', ts: now(), id: newId(), name: 'npm test', kind: 'test', snap: s1, ok: true, by: 'agent' });
    const unknown = renderHandoff(p, loadSession(ref), null, { version: 't' });
    expect(unknown).not.toMatch(/Every recorded check passed/);
    expect(unknown).toMatch(/can't tell whether the code changed since/);
    expect(renderHandoff(p, loadSession(ref), s1, { version: 't' })).toMatch(/Every recorded check passed on the code as it is now/);
  });

  it("doesn't count a handoff saved in the project as a change", () => {
    sb.write('a.txt', 'a\n');
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'ho', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    const p = openProject(sb.project, sb.ctx);
    const text = renderHandoff(p, loadSession(findSession(p)!), snapshot(p, 'now').sha, { version: 't' });
    const file = path.join(sb.project, 'handoff.md');
    fs.writeFileSync(file, text);
    expect(checkHandoff(p, text, snapshot(p, 'later').sha, file)).toMatchObject({ ok: true });
    sb.write('a.txt', 'changed\n');
    expect(checkHandoff(p, text, snapshot(p, 'later2').sha, file).ok).toBe(false);
  });

  it('only trusts a pipe under a real set -o pipefail before the check', () => {
    for (const masked of ['npm test | tail # pipefail', 'echo pipefail; npm test | tail', 'npm test --reporter=pipefail | tail', 'npm test | tail; set -o pipefail'])
      expect(resultMasked(masked), masked).toBe(true);
    for (const kept of ['set -o pipefail; npm test | tail -20', 'set -euo pipefail && npm test 2>&1 | tail'])
      expect(resultMasked(kept), kept).toBe(false);
  });
});

describe('guardrails see through zerostel check and run', () => {
  it('match the command inside', () => {
    const policy = { rules: [{ action: 'deny' as const, commands: ['git reset --hard*'] }] };
    const call = (command: string) => evaluate(policy, { tool: 'Bash', paths: [], command, writes: true, root: sb.project, cwd: sb.project, home: sb.root, platform: 'linux' });
    expect(call('zerostel check -- git reset --hard HEAD~3')?.action).toBe('deny');
    expect(call('npx zerostel run -- git reset --hard')?.action).toBe('deny');
    expect(call('zerostel check -- npm test')).toBeNull();
  });
});
