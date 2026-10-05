import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { openProject } from '../src/store/project.js';
import { findSession, loadSession } from '../src/store/session.js';
import { BaselinePending, baselineRunning, needsBaseline, snapshot, takeBaseline, trackedPaths } from '../src/store/shadow.js';
import { sandbox, type Sandbox } from './helpers.js';

// A big project's first snapshot can take minutes (on Windows, a virus
// scanner reads every file along with git). It's staged in chunks that
// survive a timeout, and finished by a background worker.

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  for (let i = 0; i < 60; i++) sb.write(`src/f${i}.ts`, `export const n = ${i};\n`);
});
afterEach(() => sb.cleanup());

const marker = (p: { dir: string }) => path.join(p.dir, 'baseline.json');

describe('first snapshot', () => {
  it('hands over when it runs out of time, and the worker finishes it', () => {
    const p = openProject(sb.project, sb.ctx);
    expect(needsBaseline(p)).toBe(true);
    expect(() => snapshot(p, 'first', { firstBudgetMs: 0 })).toThrow(BaselinePending);
    const snap = takeBaseline(p, 'point zero');
    expect(snap?.created).toBe(true);
    expect(needsBaseline(p)).toBe(false);
    expect([...trackedPaths(p, snap!.sha)].filter((f) => f.startsWith('src/'))).toHaveLength(60);
    expect(fs.existsSync(marker(p))).toBe(false);
    // after that, snapshots are the usual quick ones
    sb.write('src/f0.ts', 'changed\n');
    expect(snapshot(p, 'next', { firstBudgetMs: 0 }).created).toBe(true);
  });

  it('stages a first snapshot in chunks until it is done', () => {
    const p = openProject(sb.project, sb.ctx);
    // with no time left nothing is staged; with time, chunk after chunk until all of it is
    expect(() => snapshot(p, 'first', { firstBudgetMs: 0, chunk: 10 })).toThrow(BaselinePending);
    const done = snapshot(p, 'first', { firstBudgetMs: 60_000, chunk: 10 });
    expect([...trackedPaths(p, done.sha)].filter((f) => f.startsWith('src/'))).toHaveLength(60);
  });

  it("doesn't race a worker that is already at it", () => {
    const p = openProject(sb.project, sb.ctx);
    needsBaseline(p);
    fs.writeFileSync(marker(p), JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(baselineRunning(p)).toBe(true);
    expect(() => snapshot(p, 'first')).toThrow(BaselinePending);
    // a marker from a process that's gone, or from long ago, doesn't count
    fs.writeFileSync(marker(p), JSON.stringify({ pid: process.pid, at: Date.now() - 31 * 60_000 }));
    expect(baselineRunning(p)).toBe(false);
  });

  it('starts the worker when a session opens, and records steps meanwhile', () => {
    const started: string[] = [];
    const startBaseline = (root: string) => started.push(root);
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'b1', cwd: sb.project, ...e }, sb.ctx, undefined, { startBaseline });
    ev({ hook_event_name: 'SessionStart', source: 'startup' });
    expect(started).toEqual([openProject(sb.project, sb.ctx).root]);
    // the worker is busy: hooks don't wait for it, and the steps are still there
    const p = openProject(sb.project, sb.ctx);
    fs.writeFileSync(marker(p), JSON.stringify({ pid: process.pid, at: Date.now() }));
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'e', tool_input: { file_path: path.join(sb.project, 'src', 'f1.ts') } });
    expect(started).toHaveLength(1);
    const s = loadSession(findSession(openProject(sb.project, sb.ctx), 'b1')!);
    expect(s.steps.map((x) => x.type)).toEqual(['prompt', 'tool']);
    expect(s.steps[0]!.before).toBeUndefined();
  });
});
