import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { applyRestore, rewindTarget, undoTarget } from '../src/commands/rewind.js';
import { openProject } from '../src/store/project.js';
import { append, findSession, loadSession, newId, now } from '../src/store/session.js';
import { restore, snapshot, trackedPaths } from '../src/store/shadow.js';
import { withLock } from '../src/util/lock.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// A file git can see but not read, as when another program holds it locked.
// Returns the undo. Null where that can't be arranged (root ignores modes).
function unreadable(file: string): (() => void) | null {
  if (process.platform === 'win32') {
    const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
    if (spawnSync(icacls, [file, '/deny', '*S-1-1-0:(RD)'], { windowsHide: true }).status !== 0) return null;
    return () => void spawnSync(icacls, [file, '/remove:d', '*S-1-1-0'], { windowsHide: true });
  }
  if (process.getuid?.() === 0) return null;
  fs.chmodSync(file, 0);
  return () => fs.chmodSync(file, 0o644);
}

describe('a rewind never destroys what it has no copy of', () => {
  it('leaves files alone whose latest version git could not copy', (ctx) => {
    const p = openProject(sb.project, sb.ctx);
    sb.write('app.js', 'v1\n');
    const s1 = snapshot(p, 'T1');
    sb.write('app.js', 'v2\n');
    sb.write('extra.js', 'v2\n');
    snapshot(p, 'T2');
    // the user's latest work, which the pre-rewind snapshot can't read
    sb.write('app.js', 'v3 USER\n');
    sb.write('extra.js', 'v3 USER\n');
    const undo = [unreadable(path.join(sb.project, 'app.js')), unreadable(path.join(sb.project, 'extra.js'))];
    if (undo.includes(null)) {
      undo.forEach((u) => u?.());
      ctx.skip();
    }
    let r: ReturnType<typeof restore>;
    try {
      r = restore(p, s1.sha);
    } finally {
      undo.forEach((u) => u!());
    }
    expect(r.failed.map((f) => f.path).sort()).toEqual(['app.js', 'extra.js']);
    expect(sb.read('app.js')).toBe('v3 USER\n');
    expect(sb.read('extra.js')).toBe('v3 USER\n');
  });

  it('copies files a .gitattributes encoding would make git give up on', () => {
    const p = openProject(sb.project, sb.ctx);
    sb.write('.gitattributes', '*.ps1 working-tree-encoding=UTF-16LE-BOM\n');
    sb.write('app.js', 'v1\n');
    const s1 = snapshot(p, 'T1');
    // plain UTF-8 with an odd byte count: git can't treat it as UTF-16
    sb.write('install.ps1', 'echo hi!\n');
    sb.write('app.js', 'v2 USER\n');
    const s2 = snapshot(p, 'T2');
    expect(s2.incomplete).toBeUndefined();
    expect(s2.created).toBe(true);
    restore(p, s1.sha);
    expect(sb.read('app.js')).toBe('v1\n');
    restore(p, s2.sha);
    expect(sb.read('app.js')).toBe('v2 USER\n');
    expect(sb.read('install.ps1')).toBe('echo hi!\n');
  });

  it("doesn't overwrite a file that snapshots leave out (config exclude)", () => {
    const p = openProject(sb.project, sb.ctx);
    sb.write('notes/plan.txt', 'v1\n');
    const s1 = snapshot(p, 'T1');
    p.config.exclude = ['notes/**'];
    sb.write('notes/plan.txt', 'v2 USER\n');
    snapshot(p, 'T2');
    const preview = restore(p, s1.sha, { dryRun: true });
    expect(preview.created).toEqual([]);
    expect(preview.failed.map((f) => f.path)).toEqual(['notes/plan.txt']);
    restore(p, s1.sha);
    expect(sb.read('notes/plan.txt')).toBe('v2 USER\n');
  });

  it("doesn't overwrite a new file too large to snapshot", () => {
    const p = openProject(sb.project, sb.ctx);
    p.config.maxFileMB = 0.001; // about 1 KB
    sb.write('data.csv', 'a,b\n1,2\n');
    const s1 = snapshot(p, 'T1');
    fs.rmSync(path.join(sb.project, 'data.csv'));
    snapshot(p, 'T2');
    const big = 'x,y\n'.repeat(1000);
    sb.write('data.csv', big);
    const r = restore(p, s1.sha);
    expect(r.failed.map((f) => f.path)).toEqual(['data.csv']);
    expect(sb.read('data.csv')).toBe(big);
  });
});

describe('a snapshotted file replaced by a link', () => {
  it("doesn't pull what the link points at into the next snapshot", () => {
    const outside = path.join(sb.root, 'private');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'id_ed25519'), 'secret');
    const p = openProject(sb.project, sb.ctx);
    sb.write('docs', 'a plain file\n');
    snapshot(p, 'T1');
    fs.rmSync(path.join(sb.project, 'docs'));
    fs.symlinkSync(outside, path.join(sb.project, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    const s2 = snapshot(p, 'T2');
    expect([...trackedPaths(p, s2.sha)].filter((f) => f.startsWith('docs/'))).toEqual([]);
  });
});

describe('a rewind cut short', () => {
  it('can still be undone: the state before it is recorded first', () => {
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'cut', cwd: sb.project, ...e }, sb.ctx);
    sb.write('a.txt', 'v1\n');
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'edit' });
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: path.join(sb.project, 'a.txt') } });
    sb.write('a.txt', 'v2\n');
    ev({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: path.join(sb.project, 'a.txt') }, tool_response: {} });
    const p = openProject(sb.project, sb.ctx);
    const ref = findSession(p)!;
    // what applyRestore writes before it touches a file; the process dies after it
    const before = snapshot(p, 'before').sha;
    append(ref, { e: 'rewinding', ts: now(), id: newId(), from: before, label: 'Rewind to point zero' });
    const s = loadSession(ref);
    expect(s.steps.at(-1)!.summary).toMatch(/cut short/);
    expect(undoTarget(s)!.snap).toBe(before);
  });

  it('shows up once when it finishes', () => {
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'ok', cwd: sb.project, ...e }, sb.ctx);
    sb.write('a.txt', 'v1\n');
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'edit' });
    sb.write('a.txt', 'v2\n');
    ev({ hook_event_name: 'Stop' });
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    applyRestore(p, s.ref, rewindTarget(s, '0'));
    const after = loadSession(s.ref).steps.filter((x) => x.type === 'restore');
    expect(after).toHaveLength(1);
    expect(after[0]!.summary).not.toMatch(/cut short/);
    expect(sb.read('a.txt')).toBe('v1\n');
  });
});

describe('locks', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerostel-lock-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('takes over at once from a process that has exited', () => {
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const file = path.join(dir, 'lock');
    fs.writeFileSync(file, `${gone.stdout} ${os.hostname()} x`);
    const t = Date.now();
    expect(withLock(file, () => 'mine', { timeoutMs: 3000 })).toBe('mine');
    expect(Date.now() - t).toBeLessThan(2000);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never breaks into a lock whose owner is still running, however old", () => {
    const file = path.join(dir, 'lock');
    fs.writeFileSync(file, `${process.ppid} ${os.hostname()} x`);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(file, old, old);
    expect(() => withLock(file, () => 'mine', { timeoutMs: 300 })).toThrow(/timed out/);
    expect(fs.readFileSync(file, 'utf8')).toContain(String(process.ppid));
  });

  it("doesn't remove a lock that someone else holds by the time it lets go", () => {
    const file = path.join(dir, 'lock');
    withLock(file, () => fs.writeFileSync(file, 'someone else'));
    expect(fs.readFileSync(file, 'utf8')).toBe('someone else');
  });
});
