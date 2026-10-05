import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode, codex, cursor, gemini } from '../src/agents/adapters.js';
import { handleHook } from '../src/agents/hooks.js';
import { commandPaths, evaluate, loadPolicy, pathGlob, STARTER, validate, type Call } from '../src/guard/policy.js';
import { verify } from '../src/store/audit.js';
import { openProject } from '../src/store/project.js';
import { prune } from '../src/store/prune.js';
import { findSession, loadSession, sessionRef } from '../src/store/session.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

function turn(id: string, n = 2) {
  const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: id, cwd: sb.project, ...e }, sb.ctx);
  ev({ hook_event_name: 'UserPromptSubmit', prompt: `task ${id}` });
  for (let i = 0; i < n; i++) {
    const input = { file_path: path.join(sb.project, `f${i}.txt`), content: 'x' };
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: `${id}-${i}`, tool_input: input });
    sb.write(`f${i}.txt`, `${id} ${i}`);
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: `${id}-${i}`, tool_input: input, tool_response: {} });
  }
  ev({ hook_event_name: 'Stop' });
}

const sessionFile = () => findSession(openProject(sb.project, sb.ctx))!.file;
const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

describe('audit chain', () => {
  it('chains every event and verifies an untouched log', () => {
    turn('a');
    const v = verify(sessionFile());
    expect(v.ok).toBe(true);
    expect(v.events).toBeGreaterThan(5);
    expect(v.head).toMatch(/^[0-9a-f]{32}$/);
    expect(lines(sessionFile()).every((l) => typeof JSON.parse(l).chain === 'string')).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(sb.ctx.dataDir, 'audit.key')).mode & 0o077).toBe(0);
  });

  it('notices an edited, removed or reordered line, and lines cut off the end', () => {
    turn('b');
    const file = sessionFile();
    const original = lines(file);

    const edited = [...original];
    const ev = JSON.parse(edited[2]!);
    ev.summary = 'something harmless';
    edited[2] = JSON.stringify(ev);
    fs.writeFileSync(file, edited.join('\n') + '\n');
    expect(verify(file).problems.join(' ')).toMatch(/line 3/);

    fs.writeFileSync(file, original.filter((_, i) => i !== 3).join('\n') + '\n');
    expect(verify(file).ok).toBe(false);

    const swapped = [...original];
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    fs.writeFileSync(file, swapped.join('\n') + '\n');
    expect(verify(file).ok).toBe(false);

    fs.writeFileSync(file, original.slice(0, -1).join('\n') + '\n');
    expect(verify(file).problems.join(' ')).toMatch(/end/);

    fs.writeFileSync(file, original.join('\n') + '\n');
    expect(verify(file).ok).toBe(true);
  });

  it('leaves evidence when lines are cut off and more are appended afterwards', () => {
    turn('t1');
    const file = sessionFile();
    const all = lines(file);
    fs.writeFileSync(file, all.slice(0, -2).join('\n') + '\n');
    handleHook('claude-code', { session_id: 't1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'more' }, sb.ctx);
    const v = verify(file);
    expect(v.status).toBe('broken');
    expect(v.problems.join(' ')).toMatch(/changed outside Zerostel/);
  });

  it('notices a forged head file, a stripped chain and a session swapped for another', () => {
    turn('f1');
    const file = sessionFile();
    const head = file + '.head';
    const original = fs.readFileSync(head, 'utf8');
    fs.writeFileSync(head, original.replace(/ \w+\n$/, ' 0123456789abcdef0123456789abcdef\n'));
    expect(verify(file).problems.join(' ')).toMatch(/head file/);
    fs.writeFileSync(head, original);

    const stripped = lines(file).map((l) => {
      const ev = JSON.parse(l);
      delete ev.chain;
      return JSON.stringify(ev);
    });
    fs.writeFileSync(file, stripped.join('\n') + '\n');
    fs.rmSync(head);
    expect(verify(file).problems.join(' ')).toMatch(/stripped/);

    turn('f2');
    turn('f3');
    const p = openProject(sb.project, sb.ctx);
    const a = findSession(p, 'f2')!.file;
    const b = findSession(p, 'f3')!.file;
    fs.copyFileSync(a, b);
    fs.copyFileSync(a + '.head', b + '.head');
    expect(verify(b).ok).toBe(false);
  });

  it('a hand-added last line without a line ending is caught, and a cut-off write is set aside', () => {
    turn('h1');
    const file = sessionFile();
    fs.appendFileSync(file, JSON.stringify({ e: 'prompt', ts: new Date().toISOString(), id: 'x', text: 'fake' }));
    expect(verify(file).problems.join(' ')).toMatch(/no line ending/);
    // a half-written line is set aside on the next append, and the log keeps verifying
    const cut = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, cut.slice(0, cut.length - 10));
    handleHook('claude-code', { session_id: 'h1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'next' }, sb.ctx);
    const v = verify(file);
    expect(v.notes.join(' ')).toMatch(/set aside/);
    expect(v.ok).toBe(true);
    expect(fs.existsSync(file + '.fragments')).toBe(true);
  });

  it('prune refuses to re-sign a log that does not verify', () => {
    turn('old-p');
    turn('new-p');
    const p = openProject(sb.project, sb.ctx);
    const old = findSession(p, 'old-p')!;
    fs.utimesSync(old.file, new Date(2000, 1, 1), new Date(2000, 1, 1));
    const file = findSession(p, 'new-p')!.file;
    const edited = lines(file);
    const ev = JSON.parse(edited[1]!);
    ev.text = 'edited';
    edited[1] = JSON.stringify(ev);
    fs.writeFileSync(file, edited.join('\n') + '\n');
    expect(() => prune(p, { olderThanDays: 30 })).toThrow(/doesn't verify/);
  });

  it('converts a log from the first chain format after checking it', () => {
    turn('v1');
    const file = sessionFile();
    // rebuild it the way the first version wrote it: fixed starting value, plain "size head" head file
    const k = fs.readFileSync(path.join(sb.ctx.dataDir, 'audit.key'));
    let prev = 'zerostel-audit-v1';
    const v1 = lines(file).map((l) => {
      const { chain: _c, ...rest } = JSON.parse(l);
      const chain = crypto.createHmac('sha256', k).update(prev).update('\n').update(JSON.stringify(rest)).digest('hex').slice(0, 32);
      prev = chain;
      return JSON.stringify({ ...rest, chain });
    });
    fs.writeFileSync(file, v1.join('\n') + '\n');
    fs.writeFileSync(file + '.head', `${fs.statSync(file).size} ${prev}\n`);
    expect(verify(file)).toMatchObject({ ok: true, status: 'intact' });
    handleHook('claude-code', { session_id: 'v1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'after upgrade' }, sb.ctx);
    const v = verify(file);
    expect(v).toMatchObject({ ok: true, status: 'intact' });
    expect(fs.readFileSync(file + '.head', 'utf8')).toMatch(/^v2 /);
  });

  it('accepts older logs from before chaining and keeps chaining after them', () => {
    const p = openProject(sb.project, sb.ctx);
    const file = path.join(p.dir, 'sessions', 'claude-code__old.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ e: 'start', ts: new Date().toISOString(), agent: 'claude-code', session: 'old', cwd: sb.project }) + '\n');
    handleHook('claude-code', { session_id: 'old', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'more' }, sb.ctx);
    const v = verify(file);
    expect(v).toMatchObject({ ok: true, unchained: 1 });
  });

  it('stays valid after prune rewrites snapshot ids', () => {
    turn('old-one');
    turn('new-one');
    const p = openProject(sb.project, sb.ctx);
    const old = loadSession(findSession(p, 'old-one')!);
    fs.utimesSync(old.ref.file, new Date(2000, 1, 1), new Date(2000, 1, 1));
    prune(p, { olderThanDays: 30 });
    expect(verify(findSession(p, 'new-one')!.file).ok).toBe(true);
  });
});

describe('guardrails', () => {
  const writePolicy = (policy: unknown) => {
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'policy.json'), JSON.stringify(policy));
  };
  const pre = (tool: string, tool_input: Record<string, unknown>, id = 't1') =>
    handleHook('claude-code', { session_id: 'g', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input }, sb.ctx);

  it('does nothing without a policy', () => {
    expect(pre('Bash', { command: 'git push --force' })).toEqual({});
  });

  it('blocks a denied path before the tool runs and records it', () => {
    writePolicy(STARTER);
    const res = pre('Read', { file_path: path.join(sb.root, '.ssh', 'id_ed25519') });
    expect(res.decision).toMatchObject({ action: 'deny', rule: 1 });
    const s = loadSession(findSession(openProject(sb.project, sb.ctx))!);
    expect(s.steps.map((x) => x.type)).toEqual(['guard']); // no tool step: it never ran
    expect(s.steps[0]!.guard).toBe('deny');
  });

  it('finds paths and dangerous parts inside shell commands', () => {
    writePolicy(STARTER);
    expect(pre('Bash', { command: 'cat ~/.aws/credentials | head' }, 'a').decision?.action).toBe('deny');
    expect(pre('Bash', { command: 'npm test && git push -f origin main' }, 'b').decision?.action).toBe('ask');
    expect(pre('Bash', { command: 'git push origin main' }, 'c').decision).toBeUndefined();
    expect(pre('Bash', { command: 'echo hi >~/.ssh/authorized_keys' }, 'd').decision?.action).toBe('deny');
  });

  it('asks before writing .env but lets the agent read it', () => {
    writePolicy(STARTER);
    expect(pre('Read', { file_path: path.join(sb.project, '.env') }, 'r').decision).toBeUndefined();
    const res = pre('Edit', { file_path: path.join(sb.project, 'config', '.env.local') }, 'w');
    expect(res.decision?.action).toBe('ask');
    // an ask still lets the call run if the user agrees, so it's recorded as a tool step too
    const s = loadSession(findSession(openProject(sb.project, sb.ctx))!);
    expect(s.steps.map((x) => x.type)).toEqual(['tool', 'guard', 'tool']); // the Read, then the asked-about Edit
  });

  it("asks before an agent switches Zerostel off or edits an agent's hook settings", () => {
    writePolicy(STARTER);
    expect(pre('Bash', { command: 'npx -y zerostel@latest uninstall --agent all' }, 'u').decision?.action).toBe('ask');
    expect(pre('Bash', { command: 'zerostel prune --older-than 0d' }, 'p').decision?.action).toBe('ask');
    expect(pre('Bash', { command: 'zerostel log' }, 'l').decision).toBeUndefined();
    expect(pre('Edit', { file_path: path.join(sb.root, '.claude', 'settings.json') }, 'e1').decision?.action).toBe('ask');
    expect(pre('Write', { file_path: path.join(sb.project, '.claude', 'settings.local.json') }, 'e2').decision?.action).toBe('ask');
    expect(pre('Write', { file_path: path.join(sb.root, '.config', 'opencode', 'plugins', 'zerostel.js') }, 'e3').decision?.action).toBe('ask');
    expect(pre('Read', { file_path: path.join(sb.root, '.claude', 'settings.json') }, 'r1').decision).toBeUndefined();
    // and its own records stay off limits entirely
    expect(pre('Write', { file_path: path.join(sb.ctx.dataDir, 'policy.json') }, 'z').decision?.action).toBe('deny');
  });

  it('reports a broken policy instead of guessing', () => {
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'policy.json'), '{"rules": [{"action": "maybe", "paths": ["x"]}]}');
    expect(loadPolicy(sb.ctx).problem).toMatch(/"action"/);
    const res = pre('Bash', { command: 'git push --force' });
    expect(res.decision).toBeUndefined();
    expect(res.policyProblem).toMatch(/action/);
  });

  it('keeps the last working rules when policy.json breaks', () => {
    writePolicy(STARTER);
    expect(pre('Bash', { command: 'git push -f' }, 'k1').decision?.action).toBe('ask');
    fs.appendFileSync(path.join(sb.ctx.dataDir, 'policy.json'), '\n garbage');
    const res = pre('Bash', { command: 'git push -f' }, 'k2');
    expect(res.decision?.action).toBe('ask');
    expect(res.policyProblem).toMatch(/last working rules/);
  });

  it('still answers when recording fails', () => {
    writePolicy(STARTER);
    // a folder where the session log should be: every write to it fails
    fs.mkdirSync(sessionRef(openProject(sb.project, sb.ctx), 'claude-code', 'g2').file, { recursive: true });
    const res = handleHook('claude-code', { session_id: 'g2', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '~/.ssh/id_rsa' } }, sb.ctx);
    expect(res.decision?.action).toBe('deny');
    expect(res.problem).toMatch(/recording failed/);
  });

  it('sees through the usual ways of spelling a path or chaining a command', () => {
    const home = sb.root;
    const call = (command: string, platform: NodeJS.Platform = 'linux') =>
      evaluate(STARTER, { tool: 'Bash', paths: [], command, writes: true, root: sb.project, cwd: sb.project, home, platform })?.action;
    expect(call('rm -rf ~/.zerostel')).toBe('deny'); // the folder itself, not only what's in it
    expect(call('tar czf x.tgz ~/.ssh')).toBe('deny');
    expect(call('cat $HOME/.aws/credentials')).toBe('deny');
    expect(call('cat ${HOME}/.aws/credentials')).toBe('deny');
    expect(call('true & git push --force')).toBe('ask');
    expect(call('(git push -f)')).toBe('ask');
    expect(call('echo $(git push -f)')).toBe('ask');
    expect(call('Git Push --Force')).toBe('ask');
    if (process.platform === 'win32') {
      const drive = home.slice(0, 1).toLowerCase();
      const rest = home.slice(2).replace(/\\/g, '/');
      expect(call(`cat /${drive}${rest}/.ssh/id_rsa`, 'win32')).toBe('deny'); // Git Bash
      expect(call(`type \\\\?\\${home}\\.ssh\\id_rsa`, 'win32')).toBe('deny');
      expect(call(`type ${home}\\.ssh.\\id_rsa`, 'win32')).toBe('deny');
      expect(call(`type %USERPROFILE%\\.ssh\\id_rsa`, 'win32')).toBe('deny');
    }
  });

  it('matches in linear time, whatever the rule or command', () => {
    const policy = { rules: [{ action: 'ask' as const, commands: ['*curl *http*sh*x*y*z*'] }, { action: 'deny' as const, paths: ['**/a/**/b/**/c/**/d'] }] };
    const t0 = performance.now();
    evaluate(policy, { tool: 'Bash', paths: ['/' + 'a/'.repeat(2000)], command: 'curl http'.repeat(1800), writes: true, root: '/', cwd: '/', home: '/h', platform: 'linux' });
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('validates rules', () => {
    expect(validate({ rules: [{ action: 'deny' }] }).problem).toMatch(/needs/);
    expect(validate({ rules: [{ action: 'deny', paths: [] }] }).problem).toMatch(/non-empty/);
    expect(validate({ rules: [{ action: 'ask', tools: ['mcp__*'] }] }).policy?.rules).toHaveLength(1);
  });

  it('matches tool names, and deny wins over ask', () => {
    const call: Call = { tool: 'mcp__github__delete_repo', paths: [], writes: true, root: sb.project, cwd: sb.project, home: sb.root, platform: 'linux' };
    const policy = { rules: [{ action: 'ask' as const, tools: ['mcp__*'] }, { action: 'deny' as const, tools: ['mcp__github__delete_*'], reason: 'no' }] };
    expect(evaluate(policy, call)).toMatchObject({ action: 'deny', rule: 2 });
  });

  it('path globs: ** crosses folders, * does not', () => {
    expect(pathGlob('/p/**/.env*', false).test('/p/.env')).toBe(true);
    expect(pathGlob('/p/**/.env*', false).test('/p/a/b/.env.local')).toBe(true);
    expect(pathGlob('/p/*.txt', false).test('/p/a/b.txt')).toBe(false);
    expect(pathGlob('/P/*.TXT', true).test('/p/b.txt')).toBe(true);
    expect(commandPaths(`cp "my file.txt" ./out/ && curl https://x.dev/a`)).toEqual(['./out/']);
  });

  it('answers each agent in its own format', () => {
    const deny = { action: 'deny' as const, reason: 'credentials', rule: 1 };
    const ask = { action: 'ask' as const, reason: 'force push', rule: 3 };
    expect(JSON.parse(claudeCode.decide!(ask)).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' });
    expect(JSON.parse(claudeCode.decide!(deny)).hookSpecificOutput.permissionDecision).toBe('deny');
    // Codex can't pause to ask, so it blocks and says the user has to agree
    const cx = JSON.parse(codex.decide!(ask)).hookSpecificOutput;
    expect(cx.permissionDecision).toBe('deny');
    expect(cx.permissionDecisionReason).toMatch(/go-ahead/);
    expect(JSON.parse(cursor.decide!(deny))).toMatchObject({ permission: 'deny' });
    expect(JSON.parse(gemini.decide!(deny))).toMatchObject({ decision: 'deny' });
  });
});

describe('hooked in twice', () => {
  it('records each event once when the plugin and zerostel install both fire', () => {
    const fire = (e: Record<string, unknown>) => {
      handleHook('claude-code', { session_id: 'dup', cwd: sb.project, ...e }, sb.ctx);
      handleHook('claude-code', { session_id: 'dup', cwd: sb.project, ...e }, sb.ctx);
    };
    fire({ hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x1', tool_input: { command: 'ls' } });
    fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x1', tool_input: { command: 'ls' }, tool_response: {} });
    fire({ hook_event_name: 'Stop' });
    // a second identical prompt later is a real prompt, not a duplicate
    handleHook('claude-code', { session_id: 'dup', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, sb.ctx);
    const s = loadSession(findSession(openProject(sb.project, sb.ctx), 'dup')!);
    expect(s.steps.map((x) => x.type)).toEqual(['prompt', 'tool', 'turn', 'prompt']);
  });
});
