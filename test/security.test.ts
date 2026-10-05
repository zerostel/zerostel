import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProject } from '../src/store/project.js';
import { handleHook } from '../src/agents/hooks.js';
import { claudeCode } from '../src/agents/adapters.js';
import { redact } from '../src/detect/secrets.js';
import { applyPlan, planInstall, shQuote } from '../src/install.js';
import { findSession, loadSession } from '../src/store/session.js';
import { assertRev, blockingParent, changes, restore, snapshot, snapshotsPaused, SnapshotSkipped, validRel } from '../src/store/shadow.js';
import { comspec, findExecutable } from '../src/util/exec.js';
import { gitPath } from '../src/util/git.js';
import { clean } from '../src/util/term.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// junctions work on Windows without admin rights; elsewhere a dir symlink
function linkDir(target: string, at: string) {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('restore never reaches outside the project', () => {
  it('does not follow a symlinked folder that replaced a real one', () => {
    sb.write('data/Documents', 'old notes\n');
    const p = openProject(sb.project, sb.ctx);
    const before = snapshot(p, 'start').sha;

    // later, "data" becomes an ignored link to a folder outside the project
    const outside = path.join(sb.root, 'outside');
    fs.mkdirSync(path.join(outside, 'Documents'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'Documents', 'precious.txt'), 'keep me');
    fs.rmSync(path.join(sb.project, 'data'), { recursive: true });
    sb.write('.gitignore', 'data\n');
    linkDir(outside, path.join(sb.project, 'data'));

    const r = restore(p, before);
    expect(fs.readFileSync(path.join(outside, 'Documents', 'precious.txt'), 'utf8')).toBe('keep me');
    expect(r.failed.map((f) => f.path)).toContain('data/Documents');

    // now .gitignore is gone, so the link itself is in the pre-restore snapshot
    const r2 = restore(p, before, { only: ['data'] });
    expect(fs.existsSync(path.join(outside, 'Documents', 'precious.txt'))).toBe(true);
    if (process.platform === 'win32') {
      // junctions are never snapshotted, so the link is left alone
      expect(r2.failed.map((f) => f.path)).toEqual(['data/Documents']);
    } else {
      // git keeps the symlink itself, so it can be removed and a real folder put back
      expect(r2.failed).toEqual([]);
      expect(fs.lstatSync(path.join(sb.project, 'data')).isSymbolicLink()).toBe(false);
      expect(sb.read('data/Documents')).toBe('old notes\n');
    }
  });

  it('does not delete through a symlinked parent', () => {
    const p = openProject(sb.project, sb.ctx);
    const empty = snapshot(p, 'empty').sha;
    sb.write('dir/file.txt', 'tracked\n');
    snapshot(p, 'with file');
    // swap the real folder for a link to an outside folder holding a same-named file
    const outside = path.join(sb.root, 'outside2');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'file.txt'), 'not yours');
    fs.rmSync(path.join(sb.project, 'dir'), { recursive: true });
    sb.write('.gitignore', 'dir\n');
    linkDir(outside, path.join(sb.project, 'dir'));
    restore(p, empty);
    expect(fs.readFileSync(path.join(outside, 'file.txt'), 'utf8')).toBe('not yours');
  });
});

describe('snapshots stay inside the project', () => {
  it('does not copy what a linked folder points at, whatever .gitignore says', () => {
    const outside = path.join(sb.root, 'private');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'credentials'), 'secret');
    sb.write('app.js', 'ok');
    sb.write('.gitignore', '!link\n!link/**\n');
    linkDir(outside, path.join(sb.project, 'link'));
    fs.mkdirSync(path.join(sb.project, 'newdir'));
    linkDir(outside, path.join(sb.project, 'newdir', 'nested'));

    const p = openProject(sb.project, sb.ctx);
    const s = snapshot(p, 'start').sha;
    const files = changes(p, null, s).map((c) => c.path);
    expect(files.filter((f) => f.includes('credentials'))).toEqual([]);
    expect(files).toContain('app.js');
  });
});

describe('restore never deletes what it cannot bring back', () => {
  it('leaves an ignored folder alone even when a file should go there', () => {
    sb.write('cache', 'a file once\n');
    const p = openProject(sb.project, sb.ctx);
    const before = snapshot(p, 'start').sha;
    fs.rmSync(path.join(sb.project, 'cache'));
    sb.write('.gitignore', 'cache/\n');
    sb.write('cache/big.bin', 'not in any snapshot');

    const r = restore(p, before);
    expect(r.failed.map((f) => f.path)).toEqual(['cache']);
    expect(sb.read('cache/big.bin')).toBe('not in any snapshot');
  });

  it('replaces a folder when everything in it is backed up', () => {
    sb.write('thing', 'file\n');
    const p = openProject(sb.project, sb.ctx);
    const before = snapshot(p, 'start').sha;
    fs.rmSync(path.join(sb.project, 'thing'));
    sb.write('thing/a.txt', 'tracked');
    const r = restore(p, before);
    expect(r.failed).toEqual([]);
    expect(sb.read('thing')).toBe('file\n');
    // and the folder comes back on undo
    restore(p, r.from);
    expect(sb.read('thing/a.txt')).toBe('tracked');
  });
});

describe('file names are data', () => {
  it('treats glob characters in --only literally', () => {
    sb.write('[ab].txt', 'one\n');
    sb.write('a.txt', 'two\n');
    const p = openProject(sb.project, sb.ctx);
    const before = snapshot(p, 'start').sha;
    sb.write('[ab].txt', 'changed\n');
    sb.write('a.txt', 'changed\n');
    restore(p, before, { only: ['[ab].txt'] });
    expect(sb.read('[ab].txt')).toBe('one\n');
    expect(sb.read('a.txt')).toBe('changed\n');
  });

  it('rejects anything that is not a snapshot hash', () => {
    expect(() => assertRev('--output=/tmp/x')).toThrow(/not a snapshot id/);
    expect(() => assertRev('HEAD')).toThrow();
    expect(assertRev('4b825dc642cb6eb9a060e54bf8d69288fbee4904')).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    const p = openProject(sb.project, sb.ctx);
    expect(() => restore(p, '-q')).toThrow(/not a snapshot id/);
  });

  it('rejects paths that could climb out of the project', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:x', 'a//b', './a', '']) expect(validRel(bad, 'linux')).toBe(false);
    expect(validRel('a\\..\\x', 'win32')).toBe(false);
    expect(validRel('src/app.ts', 'win32')).toBe(true);
  });

  it('finds the first parent that is not a real folder', () => {
    fs.mkdirSync(path.join(sb.project, 'a', 'b'), { recursive: true });
    expect(blockingParent(sb.project, 'a/b/c.txt')).toBeNull();
    sb.write('f', 'x');
    expect(blockingParent(sb.project, 'f/g.txt')).toBe('f');
    linkDir(path.join(sb.root), path.join(sb.project, 'l'));
    expect(blockingParent(sb.project, 'l/x/y.txt')).toBe('l');
  });
});

describe('terminal output', () => {
  it('strips escape codes from untrusted text but keeps our colours', () => {
    const evil = 'ok\x1b]52;c;ZXZpbA==\x07\x1b[2J\x1b]0;title\x07\r\u202enot\x9b31m';
    const cleaned = clean(evil);
    expect(cleaned).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/);
    expect(cleaned).toContain('ok');
    expect(clean('\x1b[31mred\x1b[39m')).toBe('\x1b[31mred\x1b[39m');
  });
});

describe('private data', () => {
  it.skipIf(process.platform === 'win32')('keeps ~/.zerostel readable only by its owner', () => {
    fs.mkdirSync(sb.ctx.dataDir, { mode: 0o755 });
    openProject(sb.project, sb.ctx);
    expect(fs.statSync(sb.ctx.dataDir).mode & 0o777).toBe(0o700);
  });

  it('quotes hook paths for sh', () => {
    expect(shQuote("/home/o'neil/$(x)")).toBe(String.raw`'/home/o'\''neil/$(x)'`);
  });

  it('pauses snapshots instead of stalling every tool call', () => {
    sb.write('a.txt', '1');
    const p = openProject(sb.project, sb.ctx);
    snapshot(p, 'start');
    fs.writeFileSync(path.join(p.dir, 'paused.json'), JSON.stringify({ at: Date.now(), reason: 'too big' }));
    expect(snapshotsPaused(p)).toBe('too big');
    expect(() => snapshot(p, 'again')).toThrow(SnapshotSkipped);
    // the hook still records the step, just without a snapshot
    handleHook('claude-code', { session_id: 'big', cwd: sb.project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'make' } }, sb.ctx);
    const s = loadSession(findSession(p)!);
    expect(s.steps[0]!.summary).toBe('$ make');
    expect(s.steps[0]!.before).toBeUndefined();
  });
});

describe('disk use', () => {
  it('leaves new files over the size cap out of snapshots', () => {
    sb.write('small.txt', 'ok');
    fs.writeFileSync(path.join(sb.project, 'huge.bin'), Buffer.alloc(26 * 1024 * 1024));
    const p = openProject(sb.project, sb.ctx);
    const s = snapshot(p, 'start').sha;
    expect(changes(p, null, s).map((c) => c.path)).toEqual(['small.txt']);
  });
});

describe('config excludes win over everything else', () => {
  it('keeps excluded files out even when they are small ignored files or were captured before', () => {
    sb.write('.gitignore', '.env\n');
    sb.write('.env', 'API=private\n');
    sb.write('notes.txt', 'private\n');
    sb.write('app.ts', 'ok\n');
    const first = openProject(sb.project, sb.ctx);
    expect(changes(first, null, snapshot(first, 'a').sha).map((c) => c.path)).toEqual(expect.arrayContaining(['.env', 'notes.txt']));
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), JSON.stringify({ exclude: ['.env', '**/notes.txt'] }));
    const p = openProject(sb.project, sb.ctx);
    const files = changes(p, null, snapshot(p, 'b').sha).map((c) => c.path);
    expect(files).not.toContain('.env');
    expect(files).not.toContain('notes.txt');
    expect(files).toContain('app.ts');
  });
});

describe('redaction', () => {
  it('stays fast on long inputs built to make the patterns backtrack', () => {
    for (const s of ['a.'.repeat(100_000), 'sk-'.repeat(70_000), 'eyJ'.repeat(70_000), 'token'.repeat(40_000), 'x://' + 'a'.repeat(200_000)]) {
      const t0 = performance.now();
      redact(s);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });

  it('masks values in structured tool input without breaking it', () => {
    const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'j', cwd: sb.project, ...e }, sb.ctx);
    const tool_input = { headers: { auth: 'token=abcdefghijklmnop"x' }, list: ['password=hunter22'] };
    ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__api__call', tool_use_id: 't1', tool_input });
    ev({ hook_event_name: 'PostToolUse', tool_name: 'mcp__api__call', tool_use_id: 't1', tool_input, tool_response: {} });
    const s = loadSession(findSession(openProject(sb.project, sb.ctx))!);
    const st = s.steps.find((x) => x.type === 'tool')!;
    const text = JSON.stringify(st.input);
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('hunter22');
  });

  it('ignores tool and event names that are Object.prototype keys', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(() => handleHook('gemini', { session_id: 'p', cwd: sb.project, hook_event_name: 'BeforeTool', tool_name: name, tool_input: {} }, sb.ctx)).not.toThrow();
      expect(() => handleHook('claude-code', { session_id: 'p', cwd: sb.project, hook_event_name: name }, sb.ctx)).not.toThrow();
    }
  });

  it('masks short passwords, bearer tokens and URL credentials', () => {
    const text = [
      'PASSWORD=tiny123',
      'curl -H "Authorization: Bearer abcdefghijklmnopqr" https://api.example',
      'mysql --password=hunter22 -u root',
      'postgres://app:s3cretpw@db.internal:5432/app',
      'token: ' + 'Zq9'.repeat(6),
    ].join('\n');
    const out = redact(text);
    for (const leak of ['tiny123', 'abcdefghijklmnopqr', 'hunter22', 's3cretpw', 'Zq9Zq9Zq9Zq9']) expect(out).not.toContain(leak);
    expect(out).toContain('db.internal:5432');
    expect(redact('PASSWORD=${DB_PASSWORD}')).toBe('PASSWORD=${DB_PASSWORD}');
  });

  it('masks real values that only contain a placeholder word, and leaves real placeholders alone', () => {
    for (const leak of ['examplepass99', 'your-key-0123456789abc', 'Sxxxxxxyyyyyyy123456', 'dummyvault-8f3k2m9q1z']) {
      expect(redact(`password=${leak}`)).not.toContain(leak);
      expect(redact(`api_key=${leak}`)).not.toContain(leak);
    }
    for (const kept of ['your-api-key-here', 'sk-xxxxxxxxxxxxxxxxxxxxxxxx', '<YOUR_TOKEN>', 'changeme', 'example_token_value']) {
      expect(redact(`api_key=${kept}`)).toContain(kept);
    }
  });
});

describe('install backups', () => {
  it.skipIf(process.platform === 'win32')('are never more readable than the original', () => {
    const file = path.join(sb.ctx.claudeDir, 'settings.json');
    fs.mkdirSync(sb.ctx.claudeDir, { recursive: true });
    fs.writeFileSync(file, '{"env":{"KEY":"x"}}', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    applyPlan(planInstall({ ...sb.ctx, platform: 'linux' }, claudeCode));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file + '.zerostel.bak').mode & 0o777).toBe(0o600);
  });
});

describe('programs are found on PATH, never in the project', () => {
  it.skipIf(process.platform !== 'win32')('the Scoop launcher runs the real node, not one in the current folder', () => {
    const bin = path.join(sb.root, 'scoop');
    fs.mkdirSync(bin);
    fs.copyFileSync(path.resolve('scripts', 'zerostel.cmd'), path.join(bin, 'zerostel.cmd'));
    fs.writeFileSync(path.join(bin, 'cli.js'), 'console.log("REAL " + process.argv.slice(2).join(" "))\n');
    for (const f of ['node.bat', 'node.cmd']) fs.writeFileSync(path.join(sb.project, f), '@echo HIJACKED\r\n');
    const env = { ...process.env };
    // a normal shell doesn't have it (and the copied name may be upper case)
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[k];
    const r = spawnSync(comspec(), ['/d', '/s', '/c', `""${path.join(bin, 'zerostel.cmd')}" log"`], { cwd: sb.project, env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
    expect(r.stdout + r.stderr).toContain('REAL log');
    expect(r.stdout).not.toContain('HIJACKED');
  });

  it('ignores the current directory and relative PATH entries', () => {
    const abs = path.join(sb.root, 'bin');
    fs.mkdirSync(abs);
    const name = process.platform === 'win32' ? 'zstool.exe' : 'zstool';
    fs.writeFileSync(path.join(abs, name), '', { mode: 0o755 });
    fs.writeFileSync(path.join(sb.project, name), '', { mode: 0o755 });
    // "\Users\..." without a drive counts as absolute to Node on Windows but depends on the current drive
    const driveRelative = process.platform === 'win32' ? [sb.project.replace(/^[A-Za-z]:/, '')] : [];
    const env = { PATH: ['.', 'relative', ...driveRelative, abs].join(path.delimiter), PATHEXT: '.EXE;.CMD' };
    // PATHEXT is upper case and Windows file names ignore case
    expect(findExecutable('zstool', env)?.toLowerCase()).toBe(path.join(abs, name).toLowerCase());
    expect(findExecutable('nothere', env)).toBeNull();
  });

  it('skips node_modules/.bin and folders inside the current project on PATH', () => {
    const name = process.platform === 'win32' ? 'zstool2.exe' : 'zstool2';
    const real = path.join(sb.root, 'realbin');
    const bins = path.join(sb.project, 'node_modules', '.bin');
    const tools = path.join(sb.project, 'tools');
    for (const d of [real, bins, tools]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, name), '', { mode: 0o755 });
    }
    const env = { PATH: [bins, tools, real].join(path.delimiter), PATHEXT: '.EXE;.CMD' };
    expect(findExecutable('zstool2', env, process.platform, sb.project)?.toLowerCase()).toBe(path.join(real, name).toLowerCase());
    // from somewhere else, a project's own tools folder is just another PATH entry (node_modules never is)
    expect(findExecutable('zstool2', env, process.platform, path.parse(sb.root).root)?.toLowerCase()).toBe(path.join(tools, name).toLowerCase());
  });

  it('snapshots with the real git even when the project ships its own', () => {
    // junk "programs" that would fail loudly (or leave a marker) if started
    for (const f of ['git.exe', 'git.cmd', 'git.bat', 'git']) fs.writeFileSync(path.join(sb.project, f), '@echo off\r\necho pwned> pwned.txt\r\n');
    sb.write('a.txt', '1');
    const p = openProject(sb.project, sb.ctx);
    const s = snapshot(p, 'x').sha;
    expect(changes(p, null, s).map((c) => c.path)).toContain('a.txt');
    expect(fs.existsSync(path.join(sb.project, 'pwned.txt'))).toBe(false);
    expect(path.isAbsolute(gitPath()!)).toBe(true);
    expect(path.dirname(gitPath()!)).not.toBe(sb.project);
  });
});
