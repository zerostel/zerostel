import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sleepSync, withLock } from '../util/lock.js';

// Every event line carries `chain`: an HMAC of the previous line's chain and
// this event, keyed by ~/.zerostel/audit.key (readable only by you). The
// first value is derived from the session's file name and from any lines
// written before chaining, so a log can't be swapped with another session's
// or have its older lines changed. Next to the log, `<log>.head` keeps the
// log's size, line count and last chain value, with an HMAC of its own.
//
// Editing, removing, reordering or adding lines, cutting lines off the end
// and stripping the chain all show up in `zerostel verify`. When an append
// finds the log changed behind its back, it records that in the log itself
// before carrying on, so the evidence stays.
//
// What it can't do: stop someone using your own account who reads the key
// and rewrites everything. Keep ~/.zerostel out of the agent's reach with a
// guardrail (the starter policy does).

const V1_GENESIS = 'zerostel-audit-v1';
const keys = new Map<string, Buffer>();

/** ~/.zerostel, from a session file at ~/.zerostel/projects/<id>/sessions/<file>. */
function dataDirOf(sessionFile: string): string {
  return path.dirname(path.dirname(path.dirname(path.dirname(sessionFile))));
}

export function keyFile(dataDir: string): string {
  return path.join(dataDir, 'audit.key');
}

function key(dataDir: string, create: boolean): Buffer | null {
  const file = keyFile(dataDir);
  const cached = keys.get(file);
  if (cached) return cached;
  if (!fs.existsSync(file)) {
    if (!create) return null;
    // write it whole under another name, then link it into place: whoever
    // links first wins, and nobody ever reads a half-written key
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  let k = fs.readFileSync(file);
  for (let i = 0; i < 20 && k.length < 32; i++) {
    sleepSync(25);
    k = fs.readFileSync(file);
  }
  if (k.length < 32) throw new Error(`${file} is damaged (too short); move it away to start a new audit key`);
  keys.set(file, k);
  return k;
}

const mac = (k: Buffer, ...parts: string[]) => crypto.createHmac('sha256', k).update(parts.join('\n')).digest('hex').slice(0, 32);

export function link(k: Buffer, prev: string, body: string): string {
  return crypto.createHmac('sha256', k).update(prev).update('\n').update(body).digest('hex').slice(0, 32);
}

/** Where a log's chain starts: tied to the session and to any lines written before chaining. */
function genesis(k: Buffer, file: string, prefix: string): string {
  return mac(k, 'zerostel-audit-v2', path.basename(file), crypto.createHash('sha256').update(prefix).digest('hex'));
}

/** The JSON text the chain covers: the event without its own chain field. */
function body(ev: Record<string, unknown>): string {
  const { chain: _chain, ...rest } = ev;
  return JSON.stringify(rest);
}

// ---- the head file ----

interface Head {
  v: 1 | 2;
  size: number;
  count: number;
  head: string;
  valid: boolean; // v2: its own HMAC checks out
}

function headFile(file: string): string {
  return file + '.head';
}

function readHead(file: string, k: Buffer | null): Head | null {
  let text: string;
  try {
    text = fs.readFileSync(headFile(file), 'utf8').trim();
  } catch {
    return null;
  }
  const f = text.split(' ');
  if (f[0] === 'v2' && f.length === 5) {
    const [, size, count, head, m] = f as [string, string, string, string, string];
    return { v: 2, size: Number(size), count: Number(count), head, valid: !!k && m === mac(k, 'head', path.basename(file), size, count, head) };
  }
  if (f.length === 2) return { v: 1, size: Number(f[0]), count: -1, head: f[1]!, valid: true };
  return { v: 2, size: -1, count: -1, head: '', valid: false };
}

function writeHead(file: string, k: Buffer, size: number, count: number, head: string): void {
  const tmp = `${headFile(file)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `v2 ${size} ${count} ${head} ${mac(k, 'head', path.basename(file), String(size), String(count), head)}\n`);
  fs.renameSync(tmp, headFile(file));
}

// ---- reading a log ----

interface Line {
  n: number; // 1-based line number
  text: string;
  ev: Record<string, unknown> | null;
}

/** Complete lines, plus whatever follows the last newline (a cut-off write, or something appended by hand). */
function readLines(file: string): { lines: Line[]; tail: string; bytes: number } {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const cut = text.lastIndexOf('\n') + 1;
  const lines: Line[] = [];
  text
    .slice(0, cut)
    .split('\n')
    .forEach((t, i) => {
      if (!t.trim()) return;
      let ev: Record<string, unknown> | null = null;
      try {
        const v = JSON.parse(t);
        if (v && typeof v === 'object' && !Array.isArray(v)) ev = v;
      } catch {
        // not JSON
      }
      lines.push({ n: i + 1, text: t, ev });
    });
  return { lines, tail: text.slice(cut), bytes: Buffer.byteLength(text) };
}

interface Walk {
  ok: boolean;
  problems: string[];
  notes: string[];
  head: string | null; // last chain value
  chained: number;
  unchained: number;
  events: number;
  /** v2: requires every line after the first chained one to be chained */
  legacyPrefix: string;
}

/** Check every chain value from the start of the log. */
function walk(file: string, k: Buffer, lines: Line[], version: 1 | 2): Walk {
  const w: Walk = { ok: true, problems: [], notes: [], head: null, chained: 0, unchained: 0, events: 0, legacyPrefix: '' };
  const fail = (m: string) => {
    w.ok = false;
    if (w.problems.length < 20) w.problems.push(m);
  };
  let prev: string | null = null;
  let firstV: unknown;
  for (const l of lines) {
    if (!l.ev) {
      fail(`line ${l.n} is not a valid event`);
      continue;
    }
    w.events++;
    firstV ??= l.ev.e === 'start' ? l.ev.v ?? 1 : 1;
    if (typeof l.ev.chain !== 'string') {
      if (w.chained) fail(`line ${l.n} has no chain value after chained lines (added by something else?)`);
      else {
        w.unchained++;
        w.legacyPrefix += l.text + '\n';
      }
      continue;
    }
    if (prev === null) prev = version === 1 ? V1_GENESIS : genesis(k, file, w.legacyPrefix);
    w.chained++;
    if (link(k, prev, body(l.ev)) !== l.ev.chain) fail(`line ${l.n} doesn't match the chain: it, or a line before it, was edited, removed or reordered`);
    prev = l.ev.chain;
    if (l.ev.e === 'audit' && typeof l.ev.problem === 'string') fail(`recorded at line ${l.n}: ${l.ev.problem}`);
    if (l.ev.e === 'audit' && typeof l.ev.note === 'string') w.notes.push(`line ${l.n}: ${l.ev.note}`);
  }
  // a session that started with chaining in place must be chained throughout
  if (!w.chained && typeof firstV === 'number' && firstV >= 2 && w.events) fail('this log was recorded with a chain, but has none now: the chain was stripped');
  w.head = prev;
  return w;
}

// ---- writing ----

/** Append one event with its chain value. Safe to call from several processes at once. */
export function appendChained(file: string, ev: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const k = key(dataDirOf(file), true)!;
  withLock(file + '.chain', () => {
    let { head, count } = settle(file, k);
    const plain = { ...(ev as Record<string, unknown>) };
    delete plain.chain;
    const chain = link(k, head, JSON.stringify(plain));
    fs.appendFileSync(file, JSON.stringify({ ...plain, chain }) + '\n');
    head = chain;
    count++;
    writeHead(file, k, fs.statSync(file).size, count, head);
  });
}

/**
 * Bring the log and its head file into agreement before an append, and
 * return where the chain stands. Anything unexpected is written into the log
 * as an `audit` event, so it can't be quietly undone.
 */
function settle(file: string, k: Buffer): { head: string; count: number } {
  const append = (prev: string, ev: Record<string, unknown>) => {
    const chain = link(k, prev, JSON.stringify(ev));
    fs.appendFileSync(file, JSON.stringify({ ...ev, chain }) + '\n');
    return chain;
  };
  let { lines, tail, bytes } = readLines(file);

  // a cut-off last line: keep it if it's a valid next event, otherwise set it aside
  let aside = '';
  if (tail) {
    fs.truncateSync(file, bytes - Buffer.byteLength(tail));
    let kept = false;
    try {
      const ev = JSON.parse(tail);
      if (ev && typeof ev.chain === 'string') {
        fs.appendFileSync(file, tail + '\n');
        kept = true;
      }
    } catch {
      // not an event
    }
    if (!kept) {
      fs.appendFileSync(file + '.fragments', tail + '\n', { mode: 0o600 });
      aside = `set aside ${Buffer.byteLength(tail)} bytes of a cut-off last line (in ${path.basename(file)}.fragments)`;
    }
    ({ lines, bytes } = readLines(file));
  }

  const h = readHead(file, k);
  const chainedLines = lines.filter((l) => typeof l.ev?.chain === 'string').length;
  let state: { head: string; count: number };
  const chained = lines.filter((l) => typeof l.ev?.chain === 'string');
  if (h?.v === 2 && h.valid && h.size === bytes && h.count === chainedLines && lines.length) {
    state = { head: h.head, count: h.count };
  } else if (h?.v === 2 && h.valid && h.count > 0 && h.count < chainedLines && chained[h.count - 1]?.ev?.chain === h.head && walk(file, k, lines, 2).ok) {
    // a crash between writing a line and updating the head: the extra lines carry on the chain correctly
    const w = walk(file, k, lines, 2);
    state = { head: w.head!, count: w.chained };
  } else if (!h && !chainedLines) {
    // a new log, or one written before chaining existed
    state = { head: genesis(k, file, lines.map((l) => l.text + '\n').join('')), count: 0 };
  } else if (h?.v === 1) {
    // first append since the chain format changed: check the old chain, then re-sign it in the new one
    const old = walk(file, k, lines, 1);
    const fine = old.ok && old.head === h.head && h.size === bytes;
    const rewritten = rechain(file, lines.map((l) => l.text));
    fs.writeFileSync(file, rewritten.join('\n') + '\n');
    const w = walk(file, k, readLines(file).lines, 2);
    state = { head: w.head!, count: w.chained };
    if (!fine) state.head = append(state.head, { e: 'audit', ts: new Date().toISOString(), problem: 'the log did not match its old-format chain when it was converted' }), state.count++;
  } else {
    // the head file is missing, forged or out of step: the log changed outside Zerostel
    const w = walk(file, k, lines, 2);
    const expected = h?.valid ? `${h.size} bytes ending in ${h.head.slice(0, 8)}` : h ? 'a head file that does not check out' : 'no head file';
    state = { head: w.head ?? genesis(k, file, w.legacyPrefix), count: w.chained };
    state.head = append(state.head, { e: 'audit', ts: new Date().toISOString(), problem: `the log changed outside Zerostel: expected ${expected}, found ${bytes} bytes` });
    state.count++;
  }
  if (aside) {
    state.head = append(state.head, { e: 'audit', ts: new Date().toISOString(), note: aside });
    state.count++;
  }
  return state;
}

/** Recompute the chain after Zerostel itself rewrote lines (prune renames snapshot ids). Run verify first. */
export function rechain(file: string, lineTexts: string[]): string[] {
  const k = key(dataDirOf(file), true)!;
  let prev: string | null = null;
  let prefix = '';
  return lineTexts.map((line) => {
    if (!line.trim()) return line;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (typeof ev.chain !== 'string') {
        if (prev === null) prefix += line + '\n';
        return line; // from before chaining; left as it was
      }
      prev ??= genesis(k, file, prefix);
      const chain = link(k, prev, body(ev));
      prev = chain;
      return JSON.stringify({ ...ev, chain });
    } catch {
      return line;
    }
  });
}

/** After rewriting a log, record where its chain now ends. */
export function refreshHead(file: string): void {
  if (!fs.existsSync(file)) return;
  const k = key(dataDirOf(file), true)!;
  withLock(file + '.chain', () => {
    const { lines, bytes } = readLines(file);
    const w = walk(file, k, lines, 2);
    if (w.head) writeHead(file, k, bytes, w.chained, w.head);
  });
}

// ---- checking ----

export interface Verification {
  /** intact: every chained line checks out; unchecked: no chain to check (recorded before chaining); broken */
  status: 'intact' | 'unchecked' | 'broken';
  ok: boolean;
  events: number;
  /** events written before chaining existed; their content is still covered through the chain's start */
  unchained: number;
  head: string | null;
  problems: string[];
  notes: string[];
}

export function verify(file: string): Verification {
  const k = key(dataDirOf(file), false);
  const res: Verification = { status: 'intact', ok: true, events: 0, unchained: 0, head: null, problems: [], notes: [] };
  const run = () => {
    const { lines, tail } = readLines(file);
    if (tail) {
      let ev = null;
      try {
        ev = JSON.parse(tail);
      } catch {
        // a cut-off write
      }
      if (ev) res.problems.push('the last line has no line ending: it was added by something other than Zerostel');
      else res.notes.push('the last line was cut off (an interrupted write); the next event sets it aside');
    }
    const hasChain = lines.some((l) => typeof l.ev?.chain === 'string');
    const h = readHead(file, k);
    if (!k) {
      res.events = lines.length;
      if (hasChain) res.problems.push('the audit key (~/.zerostel/audit.key) is missing, so nothing can be checked');
      return;
    }
    const w = walk(file, k, lines, h?.v === 1 ? 1 : 2);
    Object.assign(res, { events: w.events, unchained: w.unchained, head: w.head });
    res.problems.push(...w.problems);
    res.notes.push(...w.notes);
    if (h?.v === 1) res.notes.push('older chain format; converted on the next event');
    if (!w.chained) return;
    if (!h) res.problems.push('the head file is missing, so lines removed from the end would not be noticed');
    else if (!h.valid) res.problems.push("the head file doesn't check out: it was edited or replaced");
    else if (h.head !== w.head || (h.v === 2 && h.count !== w.chained)) res.problems.push('the log ends at a different point than recorded: lines were removed from the end or added by something else');
  };
  if (fs.existsSync(file)) withLock(file + '.chain', run, { timeoutMs: 5_000 });
  res.ok = !res.problems.length;
  res.status = !res.ok ? 'broken' : res.head ? 'intact' : 'unchecked';
  return res;
}
