import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { runDoctor } from '../src/commands/doctor.js';
import { applyRestore, stepTarget } from '../src/commands/rewind.js';
import { loadConfig } from '../src/config.js';
import { renderReport } from '../src/report/html.js';
import { openProject } from '../src/store/project.js';
import { prune } from '../src/store/prune.js';
import { findSession, listSessions, loadSession, regressions } from '../src/store/session.js';
import { changes, coverage, coverageNote, snapshot } from '../src/store/shadow.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

function session(id: string, edits: [string, string][]) {
  const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: id, cwd: sb.project, ...e }, sb.ctx);
  ev({ hook_event_name: 'UserPromptSubmit', prompt: `secret plan ${id}` });
  edits.forEach(([file, text], i) => {
    const input = { command: `printf private-arg-${id} > ${file}` };
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `${id}-${i}`, tool_input: input });
    sb.write(file, text);
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: `${id}-${i}`, tool_input: input, tool_response: { stdout: `private-output-${id}` } });
  });
  ev({ hook_event_name: 'Stop' });
}

describe('report --share', () => {
  it('leaves prompts, commands, output and diffs out of the file entirely', () => {
    sb.write('app.js', 'let a = 1;\n');
    session('s1', [['app.js', 'let a = 2; // private-diff\n']]);
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    const full = renderReport(p, s);
    expect(full).toContain('secret plan s1');
    expect(full).toContain('private-arg-s1');
    const shared = renderReport(p, s, { share: true });
    for (const leak of ['secret plan', 'private-arg', 'private-output', 'private-diff']) expect(shared).not.toContain(leak);
    expect(shared).toContain('Shell command');
    expect(shared).toContain('app.js');
    expect(shared).toContain('Shared version');
  });

  it('says when tokens were not captured instead of showing 0', () => {
    session('s2', [['a.txt', 'x']]);
    const p = openProject(sb.project, sb.ctx);
    const html = renderReport(p, loadSession(findSession(p)!));
    expect(html).toContain('not captured');
  });
});

describe('passed earlier, failed later', () => {
  it('flags the same command going from passing to failing, not every failure', () => {
    sb.write('app.js', 'ok\n');
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'r1', cwd: sb.project, ...e }, sb.ctx);
    const bash = (id: string, command: string, fail: boolean, edit?: [string, string]) => {
      ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command } });
      if (edit) sb.write(...edit);
      ev({ hook_event_name: fail ? 'PostToolUseFailure' : 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: {} });
    };
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'fix it' });
    bash('a', 'npm test', false);
    bash('b', 'grep -r nothing .', true); // failed, but never passed: not a regression
    bash('c', 'sed -i s/ok/broken/ app.js', false, ['app.js', 'broken\n']);
    bash('d', 'npm test', true);
    ev({ hook_event_name: 'Stop' });

    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    const regs = regressions(s);
    expect(regs).toHaveLength(1);
    expect(regs[0]!.command).toBe('npm test');
    expect(regs[0]!.changed.map((x) => x.summary)).toEqual(['$ sed -i s/ok/broken/ app.js']);

    const html = renderReport(p, s);
    expect(html).toContain('Passed earlier, failed later');
    expect(html).toContain(`passed at #${regs[0]!.passed.n}`);
    const shared = renderReport(p, s, { share: true });
    expect(shared).toContain('Passed earlier, failed later');
    expect(shared).not.toContain('npm test');
  });
});

describe('prune', () => {
  it('drops old sessions, keeps the snapshots newer ones need, and rewinds still work', () => {
    session('old', [['a.txt', 'old-1'], ['a.txt', 'old-2']]);
    session('new', [['a.txt', 'new-1'], ['b.txt', 'new-2']]);
    const p = openProject(sb.project, sb.ctx);
    const oldRef = listSessions(p).find((r) => r.id === 'old')!;
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    fs.utimesSync(oldRef.file, longAgo, longAgo);

    const dry = prune(p, { olderThanDays: 30, dryRun: true });
    expect(dry.sessionsRemoved.map((r) => r.id)).toEqual(['old']);
    expect(fs.existsSync(oldRef.file)).toBe(true);

    const r = prune(p, { olderThanDays: 30 });
    expect(r.snapshotsAfter).toBeLessThan(r.snapshotsBefore);
    expect(listSessions(p).map((x) => x.id)).toEqual(['new']);

    // the kept session points at rewritten snapshots that still restore
    const s = loadSession(findSession(p, 'new')!);
    applyRestore(p, s.ref, stepTarget(s, 1));
    expect(sb.read('a.txt')).toBe('old-2');
    expect(sb.read('b.txt')).toBeNull();
    const after = loadSession(findSession(p, 'new')!);
    expect(changes(p, after.steps[1]!.before!, after.steps[1]!.after!).map((f) => f.path)).toEqual(['a.txt']);
  });

  it('keeps the latest snapshot even with no sessions left', () => {
    sb.write('a.txt', '1');
    const p = openProject(sb.project, sb.ctx);
    const s = snapshot(p, 'only').sha;
    const r = prune(p, { olderThanDays: 0 });
    expect(r.snapshotsAfter).toBe(1);
    expect(changes(p, null, snapshot(p, 'again').sha).map((f) => f.path)).toEqual(['a.txt']);
    void s;
  });
});

describe('config', () => {
  it('reads config.json and reports problems', () => {
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), JSON.stringify({ maxFileMB: 1, exclude: ['data/**'], nope: true, retentionDays: -1 }));
    const { config, problems } = loadConfig(sb.ctx);
    expect(config.maxFileMB).toBe(1);
    expect(config.exclude).toEqual(['data/**']);
    expect(config.retentionDays).toBe(30);
    expect(problems.join(' ')).toMatch(/unknown key "nope"/);
    expect(problems.join(' ')).toMatch(/retentionDays/);
  });

  it('applies exclude patterns to snapshots', () => {
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), JSON.stringify({ exclude: ['data/**', '*.sqlite'] }));
    sb.write('data/big.csv', '1,2');
    sb.write('db.sqlite', 'x');
    sb.write('src/app.js', 'ok');
    const p = openProject(sb.project, sb.ctx);
    expect(changes(p, null, snapshot(p, 's').sha).map((f) => f.path)).toEqual(['src/app.js']);
  });
});

describe('doctor', () => {
  it('reports git, hooks and the project without crashing', () => {
    const checks = runDoctor(sb.ctx, { agentVersions: false });
    expect(checks.find((c) => c.area === 'git')?.level).toBe('ok');
    expect(checks.some((c) => c.area === 'project')).toBe(true);
    expect(checks.every((c) => !c.message.includes(sb.ctx.home) || c.message.includes('~'))).toBe(true);
  });
});

describe('coverage', () => {
  it('names nested repos, ignored folders and files over the size limit', () => {
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), JSON.stringify({ maxFileMB: 1 }));
    sb.write('.gitignore', 'config/\nnode_modules/\n');
    sb.write('config/local.env', 'X=1');
    sb.write('node_modules/x/index.js', '');
    sb.write('vendor/lib/file.txt', 'inner');
    execFileSync('git', ['init', '-q'], { cwd: path.join(sb.project, 'vendor/lib') });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: path.join(sb.project, 'vendor/lib') });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: path.join(sb.project, 'vendor/lib') });
    fs.writeFileSync(path.join(sb.project, 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    const p = openProject(sb.project, sb.ctx);
    snapshot(p, 's');
    const cov = coverage(p);
    expect(cov.nested).toEqual(['vendor/lib']);
    expect(cov.ignoredDirs).toEqual(['config/']);
    expect(cov.tooLarge).toEqual(['big.bin']);
    expect(coverageNote(cov)).toMatch(/nested git repos \(vendor\/lib\).*ignored folders \(config\/\).*over the size limit \(big\.bin\)/);
  });
});

describe('prune leaves text alone', () => {
  it('only rewrites snapshot fields, not 40-hex strings in prompts', () => {
    session('old', [['a.txt', '1']]);
    const p = openProject(sb.project, sb.ctx);
    const oldRef = listSessions(p).find((r) => r.id === 'old')!;
    const tip = loadSession(oldRef).steps[1]!.after!;
    // a later session whose prompt quotes a snapshot id as plain text
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'new', cwd: sb.project, ...e }, sb.ctx);
    ev({ hook_event_name: 'UserPromptSubmit', prompt: `look at ${tip}` });
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    fs.utimesSync(oldRef.file, longAgo, longAgo);
    prune(p, { olderThanDays: 30 });
    const s = loadSession(findSession(p, 'new')!);
    expect(s.steps[0]!.text).toBe(`look at ${tip}`);
  });
});
