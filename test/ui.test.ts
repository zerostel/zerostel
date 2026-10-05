import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { openProject } from '../src/store/project.js';
import { startUi, type UiServer } from '../src/ui/server.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
let ui: UiServer;
beforeEach(async () => {
  sb = sandbox();
  ui = await startUi(sb.ctx);
});
afterEach(async () => {
  await ui.close();
  sb.cleanup();
});

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// raw requests, so tests can send the headers an attacker's page would
function request(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ui.port, path, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${ui.port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const auth = () => ({ 'x-zerostel-token': ui.token });

function record() {
  sb.write('a.txt', 'one\n');
  const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'ui-1', cwd: sb.project, ...e }, sb.ctx);
  ev({ hook_event_name: 'UserPromptSubmit', prompt: 'change <b>a</b>' });
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'rm a.txt' } });
  fs.rmSync(path.join(sb.project, 'a.txt'));
  ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'rm a.txt' } });
  return openProject(sb.project, sb.ctx);
}

describe('zerostel ui security', () => {
  it('listens on loopback only and puts the token in the fragment', () => {
    expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]{20,}$/);
  });

  it('serves the page with a strict CSP and no framing', async () => {
    const r = await request('/');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+'/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.body).not.toContain(ui.token);
    // the page's script is a template inside TypeScript: make sure what comes out still parses
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(r.body)?.[1];
    expect(script).toBeTruthy();
    expect(() => new vm.Script(script!)).not.toThrow();
  });

  it('rejects other Host headers (DNS rebinding)', async () => {
    expect((await request('/', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await request('/api/projects', { headers: { host: `evil.example:${ui.port}`, ...auth() } })).status).toBe(403);
  });

  it('needs the token for every API call', async () => {
    expect((await request('/api/projects')).status).toBe(403);
    expect((await request('/api/projects', { headers: { 'x-zerostel-token': 'nope' } })).status).toBe(403);
    expect((await request('/api/projects', { headers: { 'x-zerostel-token': ui.token.slice(1) } })).status).toBe(403);
    expect((await request('/api/projects', { headers: auth() })).status).toBe(200);
  });

  it('rejects cross-origin and non-JSON writes', async () => {
    const p = record();
    const body = JSON.stringify({ project: p.id, session: 'ui-1', step: 2, dryRun: false });
    const cross = await request('/api/rewind', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json', origin: 'https://evil.example' }, body });
    expect(cross.status).toBe(403);
    const form = await request('/api/rewind', { method: 'POST', headers: { ...auth(), 'content-type': 'text/plain' }, body });
    expect(form.status).toBe(415);
    expect(sb.read('a.txt')).toBeNull();
  });

  it('previews by default and rewinds only when asked', async () => {
    const p = record();
    const post = (extra: Record<string, unknown>) =>
      request('/api/rewind', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json', origin: `http://127.0.0.1:${ui.port}` }, body: JSON.stringify({ project: p.id, session: 'ui-1', step: 2, ...extra }) });
    const preview = JSON.parse((await post({})).body);
    expect(preview.dryRun).toBe(true);
    expect(preview.created).toEqual(['a.txt']);
    expect(sb.read('a.txt')).toBeNull();
    const done = await post({ dryRun: false });
    expect(done.status).toBe(200);
    expect(sb.read('a.txt')).toBe('one\n');
  });

  it('returns data as JSON, never as HTML', async () => {
    const p = record();
    const r = await request(`/api/session?project=${p.id}&session=ui-1`, { headers: auth() });
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(r.body).steps[0].text).toBe('change <b>a</b>');
    expect((await request(`/api/session?project=${p.id}&session=ui`, { headers: auth() })).status).toBe(404);
    expect((await request(`/api/diff?project=${p.id}&session=ui-1&step=-1`, { headers: auth() })).status).toBe(400);
  });

  it('caps request bodies', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(100_000) });
    const r = await request('/api/rewind', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: big }).catch(() => ({ status: 0 }) as Res);
    expect([0, 413]).toContain(r.status);
  });
});
