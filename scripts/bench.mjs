// How much Zerostel adds to an agent session, measured on generated projects.
//
//   npm run build && node scripts/bench.mjs            # small and medium
//   node scripts/bench.mjs --large                     # adds a 50,000-file project
//
// Every hook call runs the built CLI as its own process, the way an agent runs
// it, so Node's startup is included. Everything happens in a temp folder with
// its own home folder; the real agent configs are never read or written.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('dist/cli.js is missing; run `npm run build` first');
  process.exit(2);
}

const sizes = [
  { name: 'small', files: 1_000, kb: 8, ignored: 0 },
  { name: 'medium', files: 10_000, kb: 8, ignored: 20_000 },
  ...(process.argv.includes('--large') ? [{ name: 'large', files: 50_000, kb: 5, ignored: 50_000 }] : []),
];

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zerostel-bench-')));
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ZEROSTEL_DIR: path.join(tmp, 'zs'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CODEX_HOME: path.join(home, '.codex'),
  COPILOT_HOME: path.join(home, '.copilot'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  GEMINI_CLI_HOME: home,
  DSH_HOME: path.join(home, '.dsh'),
  NO_COLOR: '1',
};

// Random text, so the snapshots compress about as well as source code does
// (a repeated block would make the store look far smaller than it is).
function fill(dir, count, kb) {
  for (let i = 0; i < count; i++) {
    const sub = path.join(dir, `d${Math.floor(i / 200)}`);
    if (i % 200 === 0) fs.mkdirSync(sub, { recursive: true });
    const words = crypto.randomBytes(kb * 512).toString('base64').replace(/[+/=]/g, ' ');
    fs.writeFileSync(path.join(sub, `f${i}.ts`), `// ${i}\n${words}\n`);
  }
}

function du(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? du(p) : e.isFile() ? fs.statSync(p).size : 0;
  }
  return n;
}

function hook(proj, payload) {
  const t = performance.now();
  const r = spawnSync(process.execPath, [cli, 'hook', 'claude-code'], { input: JSON.stringify({ cwd: proj, ...payload }), env: { ...env, CLAUDE_PROJECT_DIR: proj }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return performance.now() - t;
}

function zerostel(proj, args) {
  const t = performance.now();
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return performance.now() - t;
}

// until the background worker has taken the project's first snapshot
function waitForBaseline(name) {
  const t = performance.now();
  for (;;) {
    const dir = fs.existsSync(path.join(env.ZEROSTEL_DIR, 'projects')) ? fs.readdirSync(path.join(env.ZEROSTEL_DIR, 'projects')).find((d) => d.startsWith(name)) : undefined;
    if (dir) {
      const p = path.join(env.ZEROSTEL_DIR, 'projects', dir);
      const r = spawnSync('git', ['--git-dir', path.join(p, 'snapshots.git'), 'rev-parse', '-q', '--verify', 'HEAD'], { encoding: 'utf8' });
      if (r.status === 0 && !fs.existsSync(path.join(p, 'baseline.json'))) return performance.now() - t;
    }
    if (performance.now() - t > 30 * 60_000) throw new Error('the first snapshot never finished');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (x) => `${Math.round(x)} ms`;
const mb = (x) => `${(x / 1e6).toFixed(1)} MB`;

const rows = [];
try {
  // Node's own start, to tell it apart from Zerostel's work
  const bare = median(Array.from({ length: 5 }, () => {
    const t = performance.now();
    spawnSync(process.execPath, ['-e', '0']);
    return performance.now() - t;
  }));

  for (const s of sizes) {
    const proj = path.join(tmp, s.name);
    fs.mkdirSync(proj, { recursive: true });
    fill(path.join(proj, 'src'), s.files, s.kb);
    if (s.ignored) fill(path.join(proj, 'node_modules'), s.ignored, 2);
    fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n');
    spawnSync('git', ['init', '-q'], { cwd: proj });
    const projectBytes = du(path.join(proj, 'src'));
    const session = `bench-${s.name}`;
    const target = path.join(proj, 'src', 'd0', 'f0.ts');

    // the session opens: the first snapshot starts in the background
    const start = hook(proj, { session_id: session, hook_event_name: 'SessionStart', source: 'startup' });
    const first = start + waitForBaseline(s.name);
    const prompt = hook(proj, { session_id: session, hook_event_name: 'UserPromptSubmit', prompt: 'refactor' });
    const reads = [];
    const edits = [];
    for (let i = 0; i < 10; i++) {
      reads.push(hook(proj, { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: `r${i}`, tool_input: { file_path: target } }));
      hook(proj, { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: `r${i}`, tool_input: { file_path: target }, tool_response: {} });
      const pre = hook(proj, { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: `e${i}`, tool_input: { file_path: target } });
      fs.appendFileSync(target, `// edit ${i}\n`);
      const post = hook(proj, { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: `e${i}`, tool_input: { file_path: target }, tool_response: {} });
      edits.push(pre + post);
    }
    hook(proj, { session_id: session, hook_event_name: 'Stop' });
    const log = zerostel(proj, ['log', '--session', session]);
    const rewind = zerostel(proj, ['rewind', '0', '--session', session, '-y']);

    const shadow = fs.readdirSync(path.join(env.ZEROSTEL_DIR, 'projects')).find((d) => d.startsWith(s.name));
    rows.push({
      project: `${s.name}: ${s.files.toLocaleString('en')} files, ${mb(projectBytes)}${s.ignored ? ` (+ ${s.ignored.toLocaleString('en')} ignored)` : ''}`,
      'session start hook': ms(start),
      'first snapshot (background)': ms(first),
      'prompt': ms(prompt),
      'read, no snapshot': ms(median(reads)),
      'edit, before + after': ms(median(edits)),
      'log': ms(log),
      'rewind to point zero': ms(rewind),
      'snapshots on disk': shadow ? mb(du(path.join(env.ZEROSTEL_DIR, 'projects', shadow))) : '?',
    });
  }

  console.log(`\nZerostel bench · ${os.platform()} ${os.arch()} · node ${process.version} · ${os.cpus()[0]?.model ?? ''}`);
  console.log(`a bare \`node -e 0\` takes ${ms(bare)} here; every hook call includes one\n`);
  const keys = Object.keys(rows[0] ?? {});
  console.log(`| ${keys.join(' | ')} |\n|${keys.map(() => '---').join('|')}|`);
  for (const r of rows) console.log(`| ${keys.map((k) => r[k]).join(' | ')} |`);
} finally {
  if (process.env.KEEP_BENCH) console.log(`kept ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
