// Sets up the example session the README demo is recorded from:
//
//   eval "$(node scripts/demo-setup.mjs)"
//
// It creates a throwaway project and a private Zerostel data folder in the
// temp directory, then plays one agent turn through the real hook handler:
// the "agent" removes old code with rm -rf and breaks the tests. Nothing
// outside those two folders is touched. The printed lines point ZEROSTEL_DIR
// at the demo data, cd into the project and define a `zerostel` alias.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('run npm run build first');
  process.exit(1);
}

const base = path.join(os.tmpdir(), 'zerostel-demo');
fs.rmSync(base, { recursive: true, force: true });
const data = path.join(base, 'data');
const project = path.join(base, 'shop-api');
const env = { ...process.env, ZEROSTEL_DIR: data };

const files = {
  'package.json': '{\n  "name": "shop-api",\n  "scripts": { "test": "node --test" }\n}\n',
  'src/app.ts': "import { login } from './legacy/auth';\nimport { session } from './legacy/session';\n\nexport function start() {\n  return session(login());\n}\n",
  'src/legacy/auth.ts': 'export function login() {\n  return { user: "demo" };\n}\n',
  'src/legacy/session.ts': 'export function session(u: object) {\n  return { ...u, id: 1 };\n}\n',
  'src/legacy/tokens.ts': 'export const TTL = 3600;\n',
  'src/cart.ts': 'export const cart: string[] = [];\n',
  'test/app.test.ts': "import { start } from '../src/app';\n",
};
for (const [rel, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), text);
}

const transcript = path.join(base, 'transcript.jsonl');
fs.writeFileSync(transcript, '');
const session = 'demo-' + Date.now().toString(36);

function hook(payload) {
  const r = spawnSync(process.execPath, [cli, 'hook', 'claude-code'], { input: JSON.stringify({ session_id: session, cwd: project, transcript_path: transcript, ...payload }), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let n = 0;
function tool(name, input, { change, response = {}, fail = false, ms = 400 } = {}) {
  const id = `toolu_${++n}`;
  hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input });
  change?.();
  sleep(ms);
  hook({ hook_event_name: fail ? 'PostToolUseFailure' : 'PostToolUse', tool_name: name, tool_use_id: id, tool_input: input, tool_response: response, ...(fail ? { error: response.stderr } : {}) });
}

hook({ hook_event_name: 'SessionStart', source: 'startup' });
hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Remove the old auth code, we use the new session module now' });
tool('Bash', { command: 'npm test' }, { response: { stdout: '✔ 12 tests passed' }, ms: 1800 });
tool('Read', { file_path: path.join(project, 'src/app.ts') }, { ms: 100 });
tool('Edit', { file_path: path.join(project, 'src/app.ts'), old_string: "import { login } from './legacy/auth';\n", new_string: '' }, {
  change: () => fs.writeFileSync(path.join(project, 'src/app.ts'), "import { session } from './legacy/session';\n\nexport function start() {\n  return session({ user: 'demo' });\n}\n"),
  ms: 200,
});
tool('Bash', { command: 'rm -rf src/legacy' }, { change: () => fs.rmSync(path.join(project, 'src/legacy'), { recursive: true }), ms: 150 });
tool('Bash', { command: 'npm test' }, { response: { stderr: "Error: Cannot find module './legacy/session'" }, fail: true, ms: 1600 });
fs.appendFileSync(
  transcript,
  JSON.stringify({ type: 'assistant', requestId: 'req_1', message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 18240, output_tokens: 2310, cache_read_input_tokens: 96500, cache_creation_input_tokens: 4100 } } }) + '\n',
);
hook({ hook_event_name: 'Stop' });

// for `eval` in bash: point at the demo data, go to the project, and make `zerostel` the local build
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
console.log(`export ZEROSTEL_DIR=${q(data)}`);
console.log(`cd ${q(project)}`);
console.log(`alias zerostel=${q(`node ${cli}`)}`);
