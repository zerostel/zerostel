import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleHook } from '../agents/hooks.js';
import { openProject } from '../store/project.js';
import { findSession, loadSession, regressions } from '../store/session.js';
import type { Ctx } from '../util/paths.js';
import { c, out, selfCommand } from '../util/term.js';
import { renderTimeline } from '../view/timeline.js';

// `zerostel demo`: try Zerostel in thirty seconds without an agent and
// without going near a real project. It makes a throwaway project in the temp
// folder and plays one agent turn into it through the same hook handler the
// agents use: tests pass, a file is edited, a folder is deleted with rm -rf,
// tests fail. Then it shows the timeline and what to try next.

const FILES: Record<string, string> = {
  'package.json': '{\n  "name": "shop-api",\n  "scripts": { "test": "node --test" }\n}\n',
  'src/app.ts': "import { login } from './legacy/auth';\nimport { session } from './legacy/session';\n\nexport function start() {\n  return session(login());\n}\n",
  'src/legacy/auth.ts': "export function login() {\n  return { user: 'demo' };\n}\n",
  'src/legacy/session.ts': 'export function session(u: object) {\n  return { ...u, id: 1 };\n}\n',
  'src/legacy/tokens.ts': 'export const TTL = 3600;\n',
  'src/cart.ts': 'export const cart: string[] = [];\n',
};

/** Returns the example project's folder. */
export function runDemo(ctx: Ctx): string {
  // a fresh folder only this user can read; nothing else is touched
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zerostel-demo-'));
  const project = path.join(base, 'shop-api');
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  }
  const transcript = path.join(base, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const session = 'demo-' + Date.now().toString(36);
  const demoCtx = { ...ctx, cwd: project };
  const hook = (payload: Record<string, unknown>) => handleHook('claude-code', { session_id: session, cwd: project, transcript_path: transcript, ...payload }, demoCtx, undefined, { projectDir: project });
  let n = 0;
  const tool = (name: string, input: Record<string, unknown>, opts: { change?: () => void; fail?: string; ms: number }) => {
    const id = `toolu_demo_${++n}`;
    hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input });
    opts.change?.();
    const post = { tool_name: name, tool_use_id: id, tool_input: input, duration_ms: opts.ms };
    if (opts.fail) hook({ hook_event_name: 'PostToolUseFailure', ...post, error: opts.fail, tool_response: { stderr: opts.fail } });
    else hook({ hook_event_name: 'PostToolUse', ...post, tool_response: { stdout: '✔ 12 tests passed' } });
  };

  hook({ hook_event_name: 'SessionStart', source: 'startup' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Remove the old auth code, we use the new session module now' });
  tool('Bash', { command: 'npm test' }, { ms: 2100 });
  tool('Read', { file_path: path.join(project, 'src/app.ts') }, { ms: 40 });
  tool('Edit', { file_path: path.join(project, 'src/app.ts'), old_string: "import { login } from './legacy/auth';\n", new_string: '' }, {
    change: () => fs.writeFileSync(path.join(project, 'src/app.ts'), "import { session } from './legacy/session';\n\nexport function start() {\n  return session({ user: 'demo' });\n}\n"),
    ms: 180,
  });
  tool('Bash', { command: 'rm -rf src/legacy' }, { change: () => fs.rmSync(path.join(project, 'src/legacy'), { recursive: true }), ms: 120 });
  tool('Bash', { command: 'npm test' }, { fail: "Error: Cannot find module './legacy/session'", ms: 1900 });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', requestId: 'req_demo', message: { id: 'msg_demo', model: 'example-model', usage: { input_tokens: 18240, output_tokens: 2310, cache_read_input_tokens: 96500, cache_creation_input_tokens: 4100 } } }) + '\n');
  hook({ hook_event_name: 'Stop' });

  const p = openProject(project, demoCtx);
  const ref = findSession(p);
  if (!ref) throw new Error(`the example session wasn't recorded in ${project}; see zerostel doctor`);
  const s = loadSession(ref);
  const z = selfCommand();
  out(c.green('✓ ') + `Made an example project and played one agent turn in it:`);
  out(c.dim(`  ${project}`));
  out(c.dim('  The "agent" ran the tests, edited src/app.ts, deleted src/legacy with rm -rf, and broke the tests.\n'));
  for (const line of renderTimeline(s)) out('  ' + line);
  for (const r of regressions(s)) out(c.yellow(`\n    ! #${r.failed.n} failed, the same command passed at #${r.passed.n}; files changed at ${r.changed.map((x) => '#' + x.n).join(', ')}`));
  out(`\n${c.bold('Now try it')}`);
  out(`  cd ${/\s/.test(project) ? `"${project}"` : project}`);
  out(`  ${z} checks          ${c.dim('# the tests: passed at #2, failing since')}`);
  out(`  ${z} undo            ${c.dim('# src/legacy comes back')}`);
  out(`  ${z} undo            ${c.dim('# run it again to undo the undo')}`);
  out(`  ${z} diff 5          ${c.dim('# exactly what step #5 deleted')}`);
  out(`  ${z} ui              ${c.dim('# the same, in your browser')}`);
  out(`  ${z} report --open   ${c.dim('# the session as one page')}`);
  out(c.dim(`\n  None of your projects were touched. The example lives in ${base}; delete it when you're done.`));
  out(c.dim(`  To record your own agent: ${z} install`));
  return project;
}
