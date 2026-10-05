import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode, codex, copilot, opencode } from '../src/agents/adapters.js';
import { applyPlan, exePath, hookEntry, hookStatus, installBin, launch, planInstall, planUninstall, shArg } from '../src/install.js';
import { sandbox, type Sandbox } from './helpers.js';

// The standalone executable (scripts/standalone.mjs) has Node inside: hooks
// run it directly instead of node + the copied bundle.

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const linux = () => ({ ...sb.ctx, platform: 'linux' as const });
const win = () => ({ ...sb.ctx, platform: 'win32' as const });

describe('standalone executable', () => {
  it('is what every kind of hook runs, with nothing looked up on PATH', () => {
    const l = launch(linux(), '/usr/bin/node', true);
    expect(l).toEqual({ exe: exePath(linux()), args: [] });
    expect(hookEntry(linux(), claudeCode, '/usr/bin/node', undefined, l).command).toBe(`${shArg(exePath(linux()))} hook claude-code`);

    const w = launch(win(), 'C:\\node\\node.exe', true);
    expect(w.exe).toMatch(/zerostel\.exe$/);
    const exec = hookEntry(win(), opencode, 'C:\\node\\node.exe', undefined, w);
    expect(exec.args).toEqual(['hook', 'opencode']);
    expect(exec.command).toMatch(/zerostel\.exe$/);
    expect(hookEntry(win(), claudeCode, 'C:\\node\\node.exe', undefined, w).command).toMatch(/zerostel-hook\.cmd claude-code$/);
    expect(hookEntry(win(), copilot, 'C:\\node\\node.exe', undefined, w).command).toMatch(/^& '.*zerostel\.exe' hook copilot$/);
    expect(hookEntry(win(), codex, 'C:\\node\\node.exe', undefined, w).command).toMatch(/zerostel-hook\.cmd codex$/);
  });

  it('copies itself next to a shim that names it, and replaces an older copy', () => {
    const fake = path.join(sb.root, 'zerostel-build.exe');
    fs.writeFileSync(fake, 'v1');
    const dest = installBin(win(), { standalone: true, source: fake });
    expect(dest).toBe(exePath(win()));
    expect(fs.readFileSync(dest, 'utf8')).toBe('v1');
    const shim = fs.readFileSync(path.join(path.dirname(dest), 'zerostel-hook.cmd'), 'utf8');
    expect(shim).toBe('@echo off\r\n"%~dp0zerostel.exe" hook %*\r\n');
    fs.writeFileSync(fake, 'v2');
    installBin(win(), { standalone: true, source: fake });
    expect(fs.readFileSync(dest, 'utf8')).toBe('v2');
    expect(fs.readdirSync(path.dirname(dest)).filter((n) => n.includes('.new-'))).toEqual([]);
  });

  it('counts as installed and healthy, and uninstall knows the files it wrote', () => {
    const ctx = sb.ctx; // this machine: installBin checks the folder permissions for real
    const fake = path.join(sb.root, 'zerostel-build');
    fs.writeFileSync(fake, 'bin');
    installBin(ctx, { standalone: true, source: fake });
    const l = launch(ctx, '/usr/bin/node', true);
    applyPlan(planInstall(ctx, claudeCode, (event) => hookEntry(ctx, claudeCode, '/usr/bin/node', event, l)));
    expect(hookStatus(ctx, claudeCode)).toMatchObject({ installed: true, healthy: true });

    applyPlan(planInstall(ctx, copilot, undefined, '/usr/bin/node', l));
    expect(hookStatus(ctx, copilot)).toMatchObject({ installed: true, healthy: true });
    expect(planUninstall(ctx, copilot).remove).toBe(true);

    const plugin = planInstall(ctx, opencode, undefined, '/usr/bin/node', l).after;
    expect(plugin).toContain(`const ARGV = ${JSON.stringify([exePath(ctx)])};`);
  });
});
