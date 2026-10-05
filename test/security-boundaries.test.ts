import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openProject } from '../src/store/project.js';
import { changes, diffText, head, restore, snapshot, snapshotsPaused, SnapshotSkipped } from '../src/store/shadow.js';
import { writeFileAtomic } from '../src/util/files.js';
import { ensurePrivateDir } from '../src/util/paths.js';
import { runtimeSecurityChecks } from '../src/commands/doctor.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); });
afterEach(() => { vi.restoreAllMocks(); sb.cleanup(); });

describe('explicit snapshot privacy exclusions', () => {
  it.each(['{"exclude": [".env"],', '{"exclude": ".env"}'])('stops snapshots instead of ignoring invalid privacy settings: %s', (raw) => {
    sb.write('.env', 'SYNTHETIC_PRIVATE=do-not-capture\n');
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), raw);
    const p = openProject(sb.project, sb.ctx);
    expect(() => snapshot(p, 'invalid config')).toThrow(/privacy settings/);
    expect(fs.existsSync(path.join(p.repo.gitDir, 'HEAD'))).toBe(false);
  });

  it('does not force-add an excluded ignored secret', () => {
    sb.write('.gitignore', '.env\n');
    sb.write('.env', 'SYNTHETIC_PRIVATE=do-not-capture\n');
    sb.write('app.ts', 'safe\n');
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), JSON.stringify({ exclude: ['.env'] }));
    const p = openProject(sb.project, sb.ctx);
    const snap = snapshot(p, 'privacy').sha;
    expect(changes(p, null, snap).map(c => c.path)).not.toContain('.env');
    expect(changes(p, null, snap).map(c => c.path)).toContain('app.ts');
  });

  it('leaves previously tracked excluded content out of new snapshots', () => {
    sb.write('private.txt', 'old private\n');
    sb.write('app.ts', 'safe\n');
    const first = openProject(sb.project, sb.ctx);
    snapshot(first, 'before exclude');
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), JSON.stringify({ exclude: ['private.txt'] }));
    const p = openProject(sb.project, sb.ctx);
    const next = snapshot(p, 'after exclude').sha;
    expect(changes(p, null, next).map(c => c.path)).not.toContain('private.txt');
  });

  it('applies Git glob exclusions to small ignored files', () => {
    sb.write('.gitignore', '*.private\n');
    sb.write('one.private', 'secret\n');
    sb.write('ok.txt', 'safe\n');
    fs.mkdirSync(sb.ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(sb.ctx.dataDir, 'config.json'), JSON.stringify({ exclude: ['**/*.private'] }));
    const p = openProject(sb.project, sb.ctx);
    expect(changes(p, null, snapshot(p, 'glob').sha).map(c => c.path)).toEqual(['.gitignore', 'ok.txt']);
  });
});

describe('restore protects hard link targets', () => {
  it('does not change an outside file linked to a restored project file', () => {
    sb.write('app.txt', 'original\n');
    const p = openProject(sb.project, sb.ctx);
    const before = snapshot(p, 'before').sha;
    const outside = path.join(sb.root, 'outside.txt');
    fs.writeFileSync(outside, 'outside must remain\n');
    fs.unlinkSync(path.join(sb.project, 'app.txt'));
    fs.linkSync(outside, path.join(sb.project, 'app.txt'));
    restore(p, before);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside must remain\n');
    expect(sb.read('app.txt')).toBe('original\n');
  });
});

describe('report output cannot overwrite linked outside files', () => {
  it('replaces a hard link without changing the outside inode', () => {
    const outside = path.join(sb.root, 'victim.txt');
    fs.writeFileSync(outside, 'keep');
    const report = path.join(sb.project, 'report.html');
    fs.linkSync(outside, report);
    writeFileAtomic(report, '<html>report</html>', { projectRoot: sb.project });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(sb.read('report.html')).toBe('<html>report</html>');
  });

  it.skipIf(process.platform === 'win32')('replaces a symlink without following its target', () => {
    const outside = path.join(sb.root, 'victim.txt');
    fs.writeFileSync(outside, 'keep');
    const report = path.join(sb.project, 'report.html');
    fs.symlinkSync(outside, report);
    writeFileAtomic(report, 'report', { projectRoot: sb.project });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(fs.lstatSync(report).isSymbolicLink()).toBe(false);
  });

  it('refuses a linked project folder used as an output directory', () => {
    const outside = path.join(sb.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(sb.project, 'reports'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => writeFileAtomic(path.join(sb.project, 'reports', 'report.html'), 'private', { projectRoot: sb.project })).toThrow(/linked/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('creates private reports even under a public output folder', () => {
    const report = path.join(sb.project, 'report.html');
    writeFileAtomic(report, 'private', { projectRoot: sb.project });
    expect(fs.statSync(report).mode & 0o777).toBe(0o600);
  });
});

describe('Windows linked-directory scan fails closed', () => {
  it.skipIf(process.platform !== 'win32')('does not stage files after a filesystem safety inspection fails', () => {
    sb.write('bucket/safe.txt', 'safe');
    const p = openProject(sb.project, sb.ctx);
    const read = fs.readdirSync.bind(fs);
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, opts: unknown) => {
      if (path.resolve(String(dir)) === path.join(sb.project, 'bucket')) throw Object.assign(new Error('read denied'), {code: 'EACCES'});
      return read(dir, opts as any);
    }) as typeof fs.readdirSync);
    expect(() => snapshot(p, 'incomplete scan')).toThrow(SnapshotSkipped);
    expect(head(p)).toBeNull();
    expect(snapshotsPaused(p)).toMatch(/could not read/);
  });

  it.skipIf(process.platform !== 'win32')('scans dependency folders when a project re-includes them', () => {
    sb.write('.gitignore', '!bucket/node_modules/\n!bucket/node_modules/**\n');
    sb.write('bucket/safe.txt', 'safe');
    const outside = path.join(sb.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'private.txt'), 'SYNTHETIC_OUTSIDE_SECRET');
    fs.mkdirSync(path.join(sb.project, 'bucket', 'node_modules'));
    fs.symlinkSync(outside, path.join(sb.project, 'bucket', 'node_modules', 'leak'), 'junction');
    const p = openProject(sb.project, sb.ctx);
    const paths = changes(p, null, snapshot(p, 'reincluded').sha).map(c => c.path);
    expect(paths).not.toContain('bucket/node_modules/leak/private.txt');
    expect(paths).toContain('bucket/safe.txt');
  });

  it.skipIf(process.platform !== 'win32')('pauses before staging when a directory exceeds the scan budget', () => {
    const bucket = path.join(sb.project, 'bucket');
    fs.mkdirSync(bucket);
    fs.writeFileSync(path.join(bucket, 'safe.txt'), 'safe');
    const p = openProject(sb.project, sb.ctx);
    const read = fs.readdirSync.bind(fs);
    const entries = Array.from({ length: 100001 }, (_, i) => ({ name: `${i}.pad`, isSymbolicLink: () => false, isDirectory: () => false } as fs.Dirent));
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, opts: unknown) => path.resolve(String(dir)) === bucket ? entries : read(dir, opts as any)) as typeof fs.readdirSync);
    expect(() => snapshot(p, 'scan')).toThrow(SnapshotSkipped);
    expect(snapshotsPaused(p)).toMatch(/safety scan/);
    expect(head(p)).toBeNull();
  });
});

describe('private storage permissions', () => {
  it.skipIf(process.platform === 'win32')('does not continue when private permissions cannot be applied', () => {
    const dir = path.join(sb.root, 'public-store');
    fs.mkdirSync(dir, { mode: 0o755 });
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => { throw new Error('permission denied'); });
    expect(() => ensurePrivateDir(dir)).toThrow(/permission denied/);
  });

  it.skipIf(process.platform === 'win32')('checks that the filesystem actually applied private permissions', () => {
    const dir = path.join(sb.root, 'public-store');
    fs.mkdirSync(dir, { mode: 0o755 });
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    expect(() => ensurePrivateDir(dir)).toThrow(/owner-only/);
  });
});

describe('known runtime advisories', () => {
  it('warns for the affected installed Git for Windows branch', () => {
    expect(runtimeSecurityChecks('v22.23.3', '2.48.1.windows.1', 'win32')).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'git-security', message: expect.stringContaining('CVE-2025-48384') })]));
    expect(runtimeSecurityChecks('v22.23.3', '2.48.2.windows.1', 'win32').some(c => c.message.includes('CVE-2025-48384'))).toBe(false);
  });
  it('accepts other patched branches and does not guess distro backport status', () => {
    for (const v of ['2.43.7.windows.1', '2.47.3.windows.1', '2.50.1.windows.1', '2.51.0.windows.1']) expect(runtimeSecurityChecks('v22.23.3', v, 'win32').some(c => c.message.includes('CVE-2025-48384'))).toBe(false);
    expect(runtimeSecurityChecks('v22.23.3', '2.53.0.windows.2', 'win32')[0]?.message).toContain('CVE-2026-32631');
    expect(runtimeSecurityChecks('v22.23.3', '2.53.0.windows.3', 'win32')).toEqual([]);
    expect(runtimeSecurityChecks('v22.23.3', '2.43.0', 'linux')).toEqual([]);
  });
  it('flags an end-of-life Node or one before the verified security release', () => {
    expect(runtimeSecurityChecks('v20.20.2', null, 'linux')[0]?.message).toMatch(/end-of-life/);
    expect(runtimeSecurityChecks('v22.20.0', null, 'win32')[0]?.message).toMatch(/security fixes/);
    expect(runtimeSecurityChecks('v22.23.3', null, 'linux')).toEqual([]);
    expect(runtimeSecurityChecks('v24.18.1', null, 'linux')).toEqual([]);
    expect(runtimeSecurityChecks('v26.0.0', null, 'linux')[0]?.message).toMatch(/security fixes/);
  });
});

describe('project store identity', () => {
  it('refuses another root even if a short project id selects its store', () => {
    const p = openProject(sb.project, sb.ctx);
    fs.mkdirSync(p.dir, {recursive: true});
    fs.writeFileSync(path.join(p.dir, 'project.json'), JSON.stringify({root: path.join(sb.root, 'different')}));
    expect(() => openProject(sb.project, sb.ctx)).toThrow(/different root/);
    expect(() => snapshot(p, 'stale project handle')).toThrow(/different root/);
    expect(fs.existsSync(path.join(p.repo.gitDir, 'HEAD'))).toBe(false);
  });

  it('accepts a second path to the same physical project', () => {
    const p = openProject(sb.project, sb.ctx);
    snapshot(p, 'first');
    const alias = path.join(sb.root, 'alias');
    fs.symlinkSync(sb.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const other = openProject(alias, sb.ctx);
    // The readable slug can differ, so test canonical metadata validation directly.
    fs.mkdirSync(other.dir, {recursive: true});
    fs.writeFileSync(path.join(other.dir, 'project.json'), JSON.stringify({root: sb.project}));
    expect(() => openProject(alias, sb.ctx)).not.toThrow();
  });
});

describe('untrusted Git execution settings', () => {
  it('ignores inherited Git settings and repository filters during snapshot, diff and restore', () => {
    const marker = path.join(sb.root, 'executed.txt');
    const script = path.join(sb.root, 'malicious.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`;
    const config = path.join(sb.root, 'hostile.gitconfig');
    fs.writeFileSync(config, `[filter "audit"]\n clean = ${JSON.stringify(command)}\n smudge = ${JSON.stringify(command)}\n[diff "audit"]\n textconv = ${JSON.stringify(command)}\n[diff]\n external = ${JSON.stringify(command)}\n`);
    const overrides: Record<string, string> = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: command };
    if (process.platform === 'win32') {
      for (const k of Object.keys(overrides)) { overrides[k.toLowerCase()] = overrides[k]!; delete overrides[k]; }
    }
    const saved = Object.fromEntries(Object.keys(overrides).map(k => [k, process.env[k]]));
    try {
      Object.assign(process.env, overrides);
      sb.write('.gitattributes', '* filter=audit diff=audit\n');
      sb.write('app.txt', 'before\n');
      const p = openProject(sb.project, sb.ctx);
      const before = snapshot(p, 'before').sha;
      sb.write('app.txt', 'after\n');
      const after = snapshot(p, 'after').sha;
      expect(diffText(p, before, after)).toContain('+after');
      restore(p, before);
      expect(sb.read('app.txt')).toBe('before\n');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
