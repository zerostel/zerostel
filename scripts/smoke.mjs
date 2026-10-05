// End-to-end smoke test of the built CLI on the current OS. Everything runs in
// a temp folder: the home folder itself (HOME, USERPROFILE) and every folder
// an agent can be pointed at point there, so the real agent configs are never
// touched, and the test fails if one of them changes anyway.
//
//   npm run build && node scripts/smoke.mjs
//
// Hooks are invoked the way each agent does on this OS (exec form, cmd /C,
// or $SHELL -lc), with the payloads each agent documents (see src/agents/adapters.ts).

import { spawnSync } from 'node:child_process';
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zerostel-smoke-')));
const proj = path.join(tmp, 'proj');
const outside = path.join(tmp, 'outside');
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ZEROSTEL_DIR: path.join(tmp, 'zs'),
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  CODEX_HOME: path.join(tmp, 'codex'),
  COPILOT_HOME: path.join(home, '.copilot'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  GEMINI_CLI_HOME: home,
  DSH_HOME: path.join(home, '.dsh'),
  NO_COLOR: '1',
};
delete env.CLAUDE_PROJECT_DIR;

// the real configs, as they are now: none of them may change
const realHome = os.homedir();
const watched = [
  '.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.gemini/settings.json', '.gemini/config/hooks.json',
  '.copilot/hooks/zerostel.json', '.config/opencode/plugins/zerostel.js', '.dsh/cordis.patch.yml', '.zerostel',
].map((p) => path.join(realHome, p));
const stamp = (p) => {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'none';
  }
};
const before = new Map(watched.map((p) => [p, stamp(p)]));

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${String(detail).split('\n').join('\n      ')}` : ''}`);
  if (!ok) failed++;
}

function z(args, opts = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const write = (rel, text) => {
  const f = path.join(proj, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (rel) => (fs.existsSync(path.join(proj, rel)) ? fs.readFileSync(path.join(proj, rel), 'utf8') : null);

// Run an installed hook entry exactly as the agent would.
function runHook(agent, entry, payload) {
  const input = JSON.stringify(payload);
  const opts = { input, env, encoding: 'utf8', cwd: proj };
  let r;
  if (entry.args) r = spawnSync(entry.command, entry.args, opts);
  else if (process.platform === 'win32') r = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/C', entry.command], opts);
  else if (agent === 'codex') r = spawnSync(process.env.SHELL || '/bin/sh', ['-lc', entry.command], opts);
  else r = spawnSync('/bin/sh', ['-c', entry.command], opts);
  return r;
}

console.log(`zerostel smoke test · ${process.platform} ${os.release()} · node ${process.version} · ${tmp}\n`);

try {
  fs.mkdirSync(proj, { recursive: true });
  write('src/legacy/a.ts', 'legacy a\n');
  write('src/legacy/b.ts', 'legacy b\n');
  write('src/app.ts', 'const x = 1;\n');
  write('notes 中文 it\'s.md', 'unicode name\n');
  write('.gitignore', 'node_modules/\n.env\n');
  write('.env', 'API_URL=http://localhost\n');

  // install
  const inst = z(['install', '--agent', 'all']);
  check('install exits 0', inst.code === 0, inst.out);
  const claudeCfg = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const codexCfg = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const claudeHook = claudeCfg.hooks.PreToolUse[0].hooks[0];
  const codexHook = codexCfg.hooks.PreToolUse[0].hooks[0];
  // right after install the hooks are configured, but no agent has used them yet
  const fresh = z(['status']).out;
  check('status shows both agents configured, not yet recording', /Claude Code\s+◌ configured/.test(fresh) && /Codex\s+◌ configured/.test(fresh), fresh);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(env.ZEROSTEL_DIR).mode & 0o777;
    check('~/.zerostel is private (0700)', mode === 0o700, mode.toString(8));
  }

  // a Claude Code session, driven through the real hook command
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const base = { session_id: 'smoke-claude', cwd: proj, transcript_path: transcript };
  const calls = [];
  const hook = (p) => calls.push(runHook('claude-code', claudeHook, { ...base, ...p }));
  hook({ hook_event_name: 'SessionStart', source: 'startup' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'remove legacy and change x' });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm -rf src/legacy' } });
  fs.rmSync(path.join(proj, 'src/legacy'), { recursive: true });
  fs.rmSync(path.join(proj, '.env'));
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm -rf src/legacy' }, tool_response: { stdout: '', stderr: '' }, duration_ms: 120 });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: path.join(proj, 'src/app.ts') } });
  write('src/app.ts', 'const x = 2;\n');
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: path.join(proj, 'src/app.ts') }, tool_response: {} });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', requestId: 'r1', message: { id: 'm1', model: 'claude-test', usage: { input_tokens: 100, output_tokens: 20 } } }) + '\n');
  hook({ hook_event_name: 'Stop' });
  check('every hook exits 0 with no stdout', calls.every((r) => r.status === 0 && !r.stdout), calls.map((r) => `${r.status} ${r.stdout} ${r.stderr}`).join('\n'));
  const errLog = path.join(env.ZEROSTEL_DIR, 'errors.log');
  check('no hook errors logged', !fs.existsSync(errLog), fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8') : '');
  const recording = z(['status']).out;
  check('status shows Claude Code recording after its first event', /Claude Code\s+✓ recording · last event/.test(recording), recording);

  const log = z(['log']);
  check('log shows the shell delete (2 legacy files + .env)', /rm -rf src\/legacy/.test(log.out) && /3 deleted/.test(log.out), log.out);
  check('log shows token usage', /120 tokens/.test(log.out), log.out);

  const undo = z(['undo', '--yes']);
  check('undo exits 0', undo.code === 0, undo.out);
  check('undo brings back files deleted by a shell command', read('src/legacy/a.ts') === 'legacy a\n' && read('src/legacy/b.ts') === 'legacy b\n', undo.out);
  check('undo brings back the ignored .env', read('.env') === 'API_URL=http://localhost\n');
  check('undo reverts the edit', read('src/app.ts') === 'const x = 1;\n');
  check('unicode and quotes in file names survive', read("notes 中文 it's.md") === 'unicode name\n');
  const redo = z(['undo', '--yes']);
  check('a second undo undoes the rewind', redo.code === 0 && read('src/legacy/a.ts') === null && read('src/app.ts') === 'const x = 2;\n', redo.out);

  // a Codex session through its hook command
  const cx = { session_id: 'smoke-codex', cwd: proj };
  const cxCalls = [];
  const cxHook = (p) => cxCalls.push(runHook('codex', codexHook, { ...cx, ...p }));
  cxHook({ hook_event_name: 'UserPromptSubmit', prompt: 'patch it' });
  const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const x = 2;\n+const x = 3;\n*** End Patch';
  cxHook({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: { command: patch } });
  write('src/app.ts', 'const x = 3;\n');
  cxHook({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: { command: patch }, tool_response: 'ok' });
  check('codex hooks exit 0 with no stdout', cxCalls.every((r) => r.status === 0 && !r.stdout), cxCalls.map((r) => `${r.status} ${r.stdout} ${r.stderr}`).join('\n'));
  const cxLog = z(['log', '--session', 'smoke-codex']);
  check('codex session recorded the patch', /Patch src\/app\.ts/.test(cxLog.out) && /\+1 −1/.test(cxLog.out), cxLog.out);

  // links must not let a snapshot or rewind reach outside the project
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
  let linked = true;
  try {
    fs.symlinkSync(outside, path.join(proj, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    linked = false;
    console.log(`SKIP  link checks (${e.code})`);
  }
  if (linked) {
    const snap = z(['snapshot', '-m', 'with link']);
    check('snapshot with a linked folder exits 0', snap.code === 0, snap.out);
    const show = z(['log', '--session', 'smoke-codex']);
    check('outside file did not enter the timeline', !/keep\.txt/.test(show.out), show.out);
    z(['rewind', '1', '--session', 'smoke-codex', '--yes']);
    check('outside file untouched after rewind', fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8') === 'outside');
  }

  // run mode
  const run = z(['run', '--', process.execPath, '-e', "require('fs').writeFileSync('made-by-run.txt','hi')"]);
  check('run exits with the command exit code', run.code === 0, run.out);
  check('run recorded the new file', /made-by-run\.txt/.test(z(['log']).out), z(['log']).out);

  // report
  const reportFile = path.join(tmp, 'report.html');
  const rep = z(['report', '--session', 'smoke-claude', '-o', reportFile]);
  const html = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : '';
  check('report written', rep.code === 0 && html.includes('<!doctype html>'), rep.out);
  check('report leaves .env out', !html.includes('API_URL=http://localhost'));

  // audit chain and guardrails
  const ver = z(['verify', '--session', 'smoke-claude']);
  check('verify finds the recorded log intact', ver.code === 0 && /chain intact/.test(ver.out), ver.out);
  const init = z(['policy', 'init']);
  check('policy init writes the starter rules', init.code === 0 && fs.existsSync(path.join(env.ZEROSTEL_DIR, 'policy.json')), init.out);
  const probe = z(['policy', 'test', 'git push --force origin main']);
  check('policy test says a force push asks first', /asks first/.test(probe.out), probe.out);
  // only the path is matched; nothing under ~/.ssh is read
  const blocked = runHook('claude-code', claudeHook, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'g1', tool_input: { file_path: '~/.ssh/id_ed25519' } });
  check('the hook answers a denied call with a deny decision', blocked.status === 0 && /"permissionDecision":"deny"/.test(blocked.stdout), blocked.stdout + blocked.stderr);
  const plain = runHook('claude-code', claudeHook, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'g2', tool_input: { file_path: path.join(proj, 'README.md') } });
  check('an allowed call still gets no output', plain.status === 0 && plain.stdout === '', plain.stdout);
  fs.rmSync(path.join(env.ZEROSTEL_DIR, 'policy.json'));

  // uninstall puts the configs back
  const un = z(['uninstall']);
  const after = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  check('uninstall removes the hooks', un.code === 0 && !after.hooks, un.out);
  const touched = watched.filter((p) => stamp(p) !== before.get(p));
  check('the real agent configs were not touched', touched.length === 0, touched.join('\n'));

} catch (e) {
  check('smoke test ran to the end', false, e.stack);
} finally {
  if (!process.env.KEEP_SMOKE) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}${process.env.KEEP_SMOKE ? ` · kept ${tmp}` : ''}`);
process.exit(failed ? 1 : 0);
