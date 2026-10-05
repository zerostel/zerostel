import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProject, unsafeRoot } from '../src/store/project.js';
import { changes, diffText, restore, snapshot } from '../src/store/shadow.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe('shadow repo', () => {
  it('snapshots and restores deletes, edits and new files', () => {
    sb.write('src/a.ts', 'export const a = 1;\n');
    sb.write('src/b.ts', 'export const b = 2;\n');
    sb.write('README.md', '# hi\n');
    const p = openProject(sb.project, sb.ctx);
    const s1 = snapshot(p, 'start');
    expect(s1.created).toBe(true);

    // what an agent might do through a shell
    fs.rmSync(path.join(sb.project, 'src'), { recursive: true });
    sb.write('README.md', '# broken\n');
    sb.write('junk.txt', 'junk\n');

    const s2 = snapshot(p, 'after');
    const c = changes(p, s1.sha, s2.sha);
    expect(c.map((x) => `${x.status} ${x.path}`)).toEqual(['M README.md', 'A junk.txt', 'D src/a.ts', 'D src/b.ts']);

    const r = restore(p, s1.sha);
    expect(r.created.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r.deleted).toEqual(['junk.txt']);
    expect(r.modified).toEqual(['README.md']);
    expect(sb.read('src/a.ts')).toBe('export const a = 1;\n');
    expect(sb.read('README.md')).toBe('# hi\n');
    expect(sb.read('junk.txt')).toBeNull();

    // the restore itself can be undone
    restore(p, r.from);
    expect(sb.read('README.md')).toBe('# broken\n');
    expect(sb.read('src/a.ts')).toBeNull();
  });

  it('does not create a commit when nothing changed', () => {
    sb.write('a.txt', 'x');
    const p = openProject(sb.project, sb.ctx);
    const a = snapshot(p, 'one');
    const b = snapshot(p, 'two');
    expect(b.sha).toBe(a.sha);
    expect(b.created).toBe(false);
  });

  it('respects .gitignore but still backs up small ignored files like .env', () => {
    sb.write('.gitignore', 'node_modules/\n.env\nbuild/\n');
    sb.write('.env', 'API_URL=http://localhost\n');
    sb.write('node_modules/x/index.js', 'big');
    sb.write('build/out.js', 'built');
    sb.write('app.js', 'ok');
    const p = openProject(sb.project, sb.ctx);
    const s1 = snapshot(p, 'start');
    const files = changes(p, null, s1.sha).map((c) => c.path);
    expect(files).toEqual(['.env', '.gitignore', 'app.js']);

    fs.rmSync(path.join(sb.project, '.env'));
    restore(p, s1.sha);
    expect(sb.read('.env')).toBe('API_URL=http://localhost\n');
  });

  it('never touches the project own .git', () => {
    fs.mkdirSync(path.join(sb.project, '.git'));
    fs.writeFileSync(path.join(sb.project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    sb.write('a.txt', '1');
    const p = openProject(sb.project, sb.ctx);
    const s1 = snapshot(p, 'start');
    expect(changes(p, null, s1.sha).map((c) => c.path)).toEqual(['a.txt']);
    sb.write('a.txt', '2');
    restore(p, s1.sha);
    expect(fs.readFileSync(path.join(sb.project, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    expect(p.dir.startsWith(sb.ctx.dataDir)).toBe(true);
  });

  it('keeps bytes exact (CRLF, binary)', () => {
    const bin = Buffer.from([0, 1, 2, 255, 13, 10]);
    fs.writeFileSync(path.join(sb.project, 'win.txt'), 'a\r\nb\r\n');
    fs.writeFileSync(path.join(sb.project, 'img.bin'), bin);
    const p = openProject(sb.project, sb.ctx);
    const s = snapshot(p, 'start');
    fs.writeFileSync(path.join(sb.project, 'win.txt'), 'changed');
    fs.rmSync(path.join(sb.project, 'img.bin'));
    restore(p, s.sha);
    expect(fs.readFileSync(path.join(sb.project, 'win.txt'), 'utf8')).toBe('a\r\nb\r\n');
    expect(fs.readFileSync(path.join(sb.project, 'img.bin')).equals(bin)).toBe(true);
  });

  it('restores only selected paths', () => {
    sb.write('a.txt', 'a1');
    sb.write('dir/b.txt', 'b1');
    const p = openProject(sb.project, sb.ctx);
    const s = snapshot(p, 'start');
    sb.write('a.txt', 'a2');
    sb.write('dir/b.txt', 'b2');
    const r = restore(p, s.sha, { only: ['dir'] });
    expect(r.modified).toEqual(['dir/b.txt']);
    expect(sb.read('a.txt')).toBe('a2');
    expect(sb.read('dir/b.txt')).toBe('b1');
  });

  it('dry run changes nothing', () => {
    sb.write('a.txt', 'a1');
    const p = openProject(sb.project, sb.ctx);
    const s = snapshot(p, 'start');
    sb.write('a.txt', 'a2');
    const r = restore(p, s.sha, { dryRun: true });
    expect(r.modified).toEqual(['a.txt']);
    expect(sb.read('a.txt')).toBe('a2');
  });

  it('produces a readable diff', () => {
    sb.write('a.txt', 'one\n');
    const p = openProject(sb.project, sb.ctx);
    const s1 = snapshot(p, 'start');
    sb.write('a.txt', 'two\n');
    const s2 = snapshot(p, 'edit');
    const d = diffText(p, s1.sha, s2.sha);
    expect(d).toContain('-one');
    expect(d).toContain('+two');
  });

  it('refuses to treat home or a drive root as a project', () => {
    expect(unsafeRoot(sb.ctx.home, sb.ctx)).toBe('the home directory');
    expect(unsafeRoot(path.parse(sb.project).root, sb.ctx)).toBe('a drive or filesystem root');
    expect(unsafeRoot(sb.project, sb.ctx)).toBeNull();
  });
});
