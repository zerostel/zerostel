import crypto from 'node:crypto';
import readline from 'node:readline';
import { applyRestore, rewindTarget, undoTarget, type Target } from '../commands/rewind.js';
import { evaluate, loadPolicy } from '../guard/policy.js';
import { verify } from '../store/audit.js';
import { openProject, unsafeRoot, type Project } from '../store/project.js';
import { append, findSession, loadSession, newId, now, sessionRef, summarize } from '../store/session.js';
import { snapshot } from '../store/shadow.js';
import { withLock } from '../util/lock.js';
import type { Ctx } from '../util/paths.js';
import { renderTimeline } from '../view/timeline.js';
import { VERSION } from '../version.js';

// `zerostel mcp`: a Model Context Protocol server on stdin/stdout, so an agent
// can save a checkpoint before something risky, look at its own timeline, or
// rewind when you ask it to. It only ever works on the project it was started
// in. Rewinds are previews unless the call says apply, and every rewind can
// itself be undone.

type Json = Record<string, unknown>;

// protocol versions this server speaks, newest first
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'checkpoint',
    description: 'Save a snapshot of the project files now, before doing something risky, so it can be rewound to later. Returns the step number.',
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'what is about to happen' } } },
  },
  {
    name: 'timeline',
    description: "Show the recorded steps of the current session: prompts, tool calls, files changed. Step numbers are what 'rewind' takes.",
    inputSchema: { type: 'object', properties: { last: { type: 'number', description: 'only the last N steps' } } },
  },
  {
    name: 'rewind',
    description:
      "Put the project files back to how they were before a step ('0' is point zero, the start of the session; 'undo' is before the last turn that changed files). Without apply=true it only previews which files would change and gives a confirm code. Only apply when the user has asked for it, after showing them the preview, passing that code. The rewind itself can be undone.",
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: "a step number from 'timeline', '0' for point zero, or 'undo'" },
        after: { type: 'boolean', description: 'go to just after the step instead of just before' },
        apply: { type: 'boolean', description: 'actually change the files (default: preview only)' },
        confirm: { type: 'string', description: 'with apply=true: the code the preview gave' },
      },
      required: ['step'],
    },
  },
  {
    name: 'verify',
    description: "Check that the current session's log hasn't been edited since it was recorded.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_policy',
    description: "Ask whether the user's guardrail rules would block a shell command or path, before trying it.",
    inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'a shell command or a file path' } }, required: ['command'] },
  },
];

class ToolError extends Error {}

function latest(p: Project) {
  const ref = findSession(p);
  if (!ref) throw new ToolError(`nothing recorded for ${p.root} yet`);
  return loadSession(ref);
}

function listFiles(label: string, files: string[]): string {
  return files.length ? `${label} (${files.length}): ${files.slice(0, 30).join(', ')}${files.length > 30 ? ', …' : ''}\n` : '';
}

export function callTool(ctx: Ctx, name: string, args: Json): string {
  const p = openProject(ctx.cwd, ctx);
  switch (name) {
    case 'checkpoint': {
      const why = unsafeRoot(p.root, ctx);
      if (why) throw new ToolError(`won't snapshot ${why}`);
      const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim().slice(0, 200) : 'Checkpoint';
      const ref = findSession(p) ?? sessionRef(p, 'manual', 'checkpoints');
      const snap = snapshot(p, message);
      const n = withLock(ref.file + '.lock', () => {
        append(ref, { e: 'snapshot', ts: now(), id: newId(), snap: snap.sha, message });
        return loadSession(ref).steps.filter((x) => x.n).length;
      });
      return `Saved as step #${n}${snap.created ? '' : ' (nothing changed since the last snapshot)'}. Rewind to it with step ${n}.`;
    }
    case 'timeline': {
      const last = typeof args.last === 'number' && args.last > 0 ? Math.floor(args.last) : 30;
      return renderTimeline(latest(p), { last, width: 110 }).join('\n');
    }
    case 'rewind': {
      const s = latest(p);
      const step = String(args.step ?? '').trim();
      let t: Target | null;
      try {
        t = step.toLowerCase() === 'undo' ? undoTarget(s) : rewindTarget(s, step, args.after === true);
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      if (!t) return 'Nothing to undo: no recorded step changed any files.';
      const apply = args.apply === true;
      // Applying takes the code from a preview of this exact state: the
      // project as it is now, this session, this target. Anything that
      // changes in between means a new preview.
      const code = (from: string) => crypto.createHash('sha256').update(`${s.ref.file}\0${t!.snap}\0${from}`).digest('hex').slice(0, 8);
      if (apply && args.confirm !== code(snapshot(p, 'before rewind').sha)) {
        throw new ToolError(args.confirm ? 'The project or the session changed since that preview. Preview again (without apply) and show the user.' : 'apply=true needs the confirm code from a preview: call without apply first and show the user what would change.');
      }
      // The agent rewinds the project and nothing else. Watched files in the
      // user's home and Windows user variables go back only when the user
      // rewinds from a terminal; this says if any would.
      const outside = applyRestore(p, s.ref, t, { dryRun: true, ctx });
      const left = [...(outside.home?.restored ?? []), ...(outside.env ?? [])];
      const r = applyRestore(p, s.ref, t, { dryRun: !apply });
      const total = r.created.length + r.modified.length + r.deleted.length;
      const pkgs = r.packages?.length ? `Global packages changed since then and are NOT undone by this; to undo: ${r.packages.flatMap((x) => x.undo).join(' && ')}
` : '';
      const leftNote = left.length ? `Outside the project, ${left.join(', ')} would also go back, but only if the user runs \`zerostel rewind\` in a terminal; this tool leaves them alone.\n` : '';
      const kept = !apply && r.failed.length ? `Left alone: ${r.failed.slice(0, 30).map((f) => `${f.path} (${f.error})`).join(', ')}\n` : '';
      const body = pkgs + listFiles('restore', r.modified) + listFiles('bring back', r.created) + listFiles('remove', r.deleted) + kept + leftNote;
      if (!total) return `${t.label}: the project already matches that point. Nothing to do.\n${kept}${leftNote}`;
      if (!apply) {
        const who = `${s.agent} session "${summarize(s).title}"`;
        return `${t.label} of the ${who} (preview, nothing changed yet)\n${body}This rewinds the whole project, including the user's own edits and other agents' since then. Only if the user agrees, call again with apply=true and confirm="${code(r.from)}".`;
      }
      const failed = r.failed.length ? `\n${r.failed.length} file(s) could not be restored: ${r.failed.map((f) => f.path).join(', ')}` : '';
      return `${t.label}: done.\n${body}${failed}\nThe rewind is recorded and can be undone with step 'undo'.`;
    }
    case 'verify': {
      const v = verify(latest(p).ref.file);
      if (!v.ok) return `The log does NOT verify:\n${v.problems.join('\n')}`;
      return v.head ? `Log intact: ${v.events} events, chain head ${v.head.slice(0, 12)}.` : `No chained events yet (${v.events} older events can't be checked).`;
    }
    case 'check_policy': {
      const text = typeof args.command === 'string' ? args.command.slice(0, 16_384) : '';
      if (!text) throw new ToolError('command is required');
      const { policy, problem } = loadPolicy(ctx);
      if (!policy) return problem ? `The user's policy file is broken and there are no earlier rules to fall back on, so none apply right now: ${problem}` : 'No guardrail rules are set.';
      const d = evaluate(policy, { tool: 'Bash', paths: [], command: text, writes: true, root: p.root, cwd: ctx.cwd, home: ctx.home, platform: ctx.platform });
      if (!d) return 'Allowed: no rule matches.';
      return d.action === 'deny' ? `Blocked by rule ${d.rule}: ${d.reason}` : `Needs the user's go-ahead (rule ${d.rule}): ${d.reason}`;
    }
  }
  throw new ToolError(`unknown tool ${name}`);
}

/** Handle one JSON-RPC message; returns the response, or null for notifications. */
export function handleMessage(ctx: Ctx, msg: Json): Json | null {
  const id = msg.id;
  const isRequest = id !== undefined && id !== null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json;
  // notifications (no id) never get an answer
  if (!isRequest) return null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: VERSIONS.includes(String(params.protocolVersion)) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'zerostel', version: VERSION },
        instructions: "Zerostel records this project's agent sessions. Use 'checkpoint' before risky changes, 'timeline' to see steps, and 'rewind' (preview first) when the user asks to go back.",
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Json;
      try {
        return reply({ content: [{ type: 'text', text: callTool(ctx, name, args) }] });
      } catch (e) {
        // tool failures go back to the model as results, not protocol errors
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
  }
  return error(-32601, `method not found: ${String(msg.method)}`);
}

export async function serveMcp(ctx: Ctx): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let res: Json | null;
    if (line.length > 1_000_000) res = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'message too large' } };
    else {
      try {
        res = handleMessage(ctx, JSON.parse(line) as Json);
      } catch {
        res = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
      }
    }
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
}
