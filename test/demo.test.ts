import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRestore, undoTarget } from '../src/commands/rewind.js';
import { runDemo } from '../src/commands/demo.js';
import { openProject } from '../src/store/project.js';
import { findSession, loadSession } from '../src/store/session.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
let demo = '';
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  sb.cleanup();
  if (demo) fs.rmSync(path.dirname(demo), { recursive: true, force: true });
});

describe('zerostel demo', () => {
  it('plays a turn into a throwaway project that undo can fix', () => {
    const log = console.log;
    console.log = () => {};
    try {
      demo = runDemo(sb.ctx);
    } finally {
      console.log = log;
    }
    expect(fs.existsSync(path.join(demo, 'src/legacy'))).toBe(false);
    const p = openProject(demo, sb.ctx);
    const s = loadSession(findSession(p)!);
    expect(s.steps.filter((x) => x.type === 'tool')).toHaveLength(5);
    applyRestore(p, s.ref, undoTarget(s)!);
    expect(fs.readFileSync(path.join(demo, 'src/legacy/session.ts'), 'utf8')).toContain('session');
  });
});
