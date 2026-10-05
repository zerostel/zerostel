import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyRestore, stepTarget, undoTarget } from '../commands/rewind.js';
import { sessionHeader, sessionJson } from '../commands/more.js';
import { listProjects, openProject, type Project } from '../store/project.js';
import { findSession, listSessions, loadSession } from '../store/session.js';
import { diffText } from '../store/shadow.js';
import type { Ctx } from '../util/paths.js';
import { VERSION } from '../version.js';
import { page } from './page.js';

// A local web UI that can rewind files is exactly what a malicious web page
// would love to reach. So:
//  - it listens on 127.0.0.1 only, on a random port by default
//  - every API call needs a random per-run token in a custom header, which a
//    cross-site page can't send without a CORS preflight we never approve
//  - the Host header must be our own address (blocks DNS rebinding)
//  - writes also need JSON and, when the browser sends one, our own Origin
//  - the page can't be framed and only runs its own nonce'd script

export interface UiServer {
  url: string; // includes the token
  port: number;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  });
  res.end(data);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function projectById(ctx: Ctx, id: unknown): Project {
  if (typeof id !== 'string') throw new HttpError(400, 'project is required');
  const found = listProjects(ctx).find((p) => p.id === id);
  if (!found) throw new HttpError(404, 'no such project');
  return openProject(found.root, ctx);
}

function sessionOf(p: Project, id: unknown) {
  if (typeof id !== 'string') throw new HttpError(400, 'session is required');
  const ref = findSession(p, id);
  if (!ref || ref.id !== id) throw new HttpError(404, 'no such session');
  return loadSession(ref);
}

function stepNumber(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'step must be a positive integer');
  return n;
}

export function startUi(ctx: Ctx, opts: { port?: number; host?: string } = {}): Promise<UiServer> {
  const token = crypto.randomBytes(24).toString('base64url');
  const host = opts.host ?? '127.0.0.1';
  let port = 0;

  const server = http.createServer(async (req, res) => {
    try {
      // DNS rebinding: the browser sends the attacker's host name here
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(String(req.headers.host ?? ''))) return send(res, 403, { error: 'wrong host' });
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (req.method === 'GET' && url.pathname === '/') {
        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
        return send(res, 200, page(nonce, VERSION), 'text/html; charset=utf-8', { 'Content-Security-Policy': csp });
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      // every API call carries the token in a header a cross-site page can't set
      if (!same(String(req.headers['x-zerostel-token'] ?? ''), token)) return send(res, 403, { error: 'missing or wrong token' });
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedHosts.map((h) => `http://${h}`).includes(origin)) return send(res, 403, { error: 'cross-origin request' });

      if (req.method === 'GET') {
        const q = url.searchParams;
        switch (url.pathname) {
          case '/api/projects':
            return send(res, 200, listProjects(ctx).map((p) => ({ id: p.id, root: p.root, sessions: listSessions(openProject(p.root, ctx)).length })));
          case '/api/sessions': {
            const p = projectById(ctx, q.get('project'));
            return send(res, 200, listSessions(p).map((r) => sessionHeader(loadSession(r))));
          }
          case '/api/session': {
            const p = projectById(ctx, q.get('project'));
            return send(res, 200, sessionJson(sessionOf(p, q.get('session'))));
          }
          case '/api/diff': {
            const p = projectById(ctx, q.get('project'));
            const s = sessionOf(p, q.get('session'));
            const st = s.steps.find((x) => x.n === stepNumber(q.get('step')));
            if (!st) throw new HttpError(404, 'no such step');
            const text = st.before && st.after && st.before !== st.after ? diffText(p, st.before, st.after) : '';
            return send(res, 200, { diff: text.length > 2_000_000 ? text.slice(0, 2_000_000) + '\n… truncated' : text });
          }
        }
        return send(res, 404, { error: 'not found' });
      }

      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
        const body = await readBody(req);
        const p = projectById(ctx, body.project);
        const s = sessionOf(p, body.session);
        const dryRun = body.dryRun !== false;
        let target;
        try {
          if (url.pathname === '/api/rewind') target = stepTarget(s, stepNumber(body.step), body.after === true);
          else if (url.pathname === '/api/undo') target = undoTarget(s) ?? undefined;
          else return send(res, 404, { error: 'not found' });
        } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message);
        }
        if (!target) return send(res, 200, { nothing: true });
        const r = applyRestore(p, s.ref, target, { dryRun, ctx });
        return send(res, 200, { label: target.label, dryRun: r.dryRun, created: r.created, modified: [...r.modified, ...(r.home?.restored ?? []), ...(r.env ?? []).map((n) => `%${n}%`)], deleted: r.deleted, failed: r.failed });
      }
      return send(res, 405, { error: 'method not allowed' });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/#t=${token}`,
        port,
        token,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
