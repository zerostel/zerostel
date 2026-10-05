import path from 'node:path';
import type { Decision } from '../guard/policy.js';
import type { Ctx } from '../util/paths.js';

// Everything Zerostel needs to know about one agent lives in its adapter:
// where its hooks file is, what that file looks like, how the agent runs a
// hook command on Windows, and how its payload maps onto Zerostel's moments.
// Supporting a new agent means adding one object to ADAPTERS.

/** The moments Zerostel records, whatever each agent calls them. */
export type Moment = 'start' | 'prompt' | 'pre' | 'post' | 'post-fail' | 'stop' | 'end';

/** A hook payload in Zerostel's terms. */
export interface HookInput {
  moment: Moment;
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
  prompt?: string;
  source?: string;
  reason?: string;
  model?: string;
  agent_type?: string; // set when a subagent made the call
  /** the tool's arguments as the agent sent them, when they were renamed above; rules check both */
  raw_input?: Record<string, unknown>;
}

export interface InstallEvent {
  event: string;
  matcher?: string;
  timeout: number;
}

/** What an adapter needs to write a hooks file it owns entirely. */
export interface RenderInput {
  /** the program and its first arguments: node and the bundle, or the standalone executable */
  argv: string[];
  /** the command as sh would run it */
  unix: (event?: string) => string;
  /** the command as PowerShell would run it */
  powershell: (event?: string) => string;
}

export interface Adapter {
  id: string;
  name: string;
  configFile(ctx: Ctx): string;
  /**
   * nested: { Event: [{ matcher, hooks: [entry] }] }   Claude Code, Codex, Gemini CLI
   * flat:   { event: [entry] }                         Cursor
   * group:  { zerostel: { enabled, Event: [...] } }    Antigravity: one named group per tool
   * owned:  a file only Zerostel writes                Copilot CLI hooks folder, opencode plugin
   * block:  a marked block in a text file              DeepSeek Harness's YAML patch
   */
  layout: 'nested' | 'flat' | 'group' | 'owned' | 'block';
  /** for layout 'owned': the whole file */
  render?(r: RenderInput): string;
  /** for layout 'block': Zerostel's lines in the file, without the markers */
  block?(ctx: Ctx): string;
  /** a second file only Zerostel writes, such as a plugin the config file points to */
  companion?: { file(ctx: Ctx): string; render(r: RenderInput): string };
  /** top-level keys a freshly created hooks file needs */
  scaffold?: Record<string, unknown>;
  events: InstallEvent[];
  /** events that take a plain list of entries even in a nested or group layout */
  flatEvents?: string[];
  /** the payload doesn't name the event, so the hook command carries it */
  eventArg?: boolean;
  /**
   * how the agent runs a hook command on Windows: exec (program + args, no
   * shell), cmd (cmd /C), powershell, or shim (a command any of bash,
   * PowerShell and cmd read the same way, falling back to exec)
   */
  windowsRunner: 'exec' | 'cmd' | 'powershell' | 'shim';
  /** stdout the agent expects from a hook that has no opinion; undefined prints nothing */
  ack?: string | ((raw: Record<string, unknown>) => string | undefined);
  /** program name; when set, the agent only counts as present if it's on PATH (its config folder alone can come from another tool) */
  cli?: string;
  /** the agent can pause a tool call to ask the user; otherwise a rule's "ask" blocks */
  asks?: boolean;
  /** not tested against the real agent; installed only when asked for by name */
  experimental?: boolean;
  afterInstall?: string;
  /** stdout that makes the agent block a tool call (or ask the user first) before it runs */
  decide?(d: Decision): string;
  normalize(raw: Record<string, unknown>, event?: string): HookInput | null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Lookup by a name from a payload: own keys only, so "constructor" or "__proto__" find nothing. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * A tool's arguments as an object. Some agents send them as a string: JSON,
 * or (Copilot CLI's edit tool) a whole apply_patch body, whose file names the
 * rules have to see like any other path.
 */
export function toolInput(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== 'string') return obj(v);
  const text = v.trim();
  if (text.startsWith('{')) {
    try {
      return obj(JSON.parse(text));
    } catch {
      // not JSON after all
    }
  }
  if (/^\*\*\* Begin Patch/m.test(text)) return { patch: v };
  return text ? { input: v } : undefined;
}

function common(raw: Record<string, unknown>, moment: Moment): HookInput {
  const input = toolInput(raw.tool_input);
  // an edit sent as a patch is a patch, whatever the agent calls the tool
  const name = str(raw.tool_name);
  return {
    moment,
    session_id: str(raw.session_id),
    transcript_path: str(raw.transcript_path) ?? null,
    cwd: str(raw.cwd),
    tool_name: typeof input?.patch === 'string' && name && /^(edit|write|multiedit|create|str_replace_editor)$/i.test(name) ? 'apply_patch' : name,
    tool_input: input,
    tool_response: raw.tool_response,
    tool_use_id: str(raw.tool_use_id),
    duration_ms: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
    prompt: str(raw.prompt),
    source: str(raw.source),
    reason: str(raw.reason),
    model: str(raw.model),
    agent_type: str(raw.agent_type),
  };
}

const CLAUDE_EVENTS: Record<string, Moment> = {
  SessionStart: 'start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'pre',
  PostToolUse: 'post',
  PostToolUseFailure: 'post-fail',
  Stop: 'stop',
  SessionEnd: 'end',
};

// What the agent (and through it, the user) is told when a rule fires. Where
// an agent can't pause to ask the user, "ask" blocks and says why.
function decisionText(d: Decision, canAsk: boolean): string {
  if (d.action === 'deny') return `Zerostel policy blocked this: ${d.reason}`;
  if (canAsk) return `Zerostel policy: ${d.reason}`;
  return `Zerostel policy: ${d.reason}. This needs the user's go-ahead: ask them first; if they agree, they can run it themselves or change ~/.zerostel/policy.json.`;
}

/** Claude Code's PreToolUse output, also read by Codex. */
const claudeDecision = (canAsk: boolean) => (d: Decision) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.action === 'ask' && canAsk ? 'ask' : 'deny', permissionDecisionReason: decisionText(d, canAsk) } });

// Gemini CLI, Antigravity and Copilot CLI have an "ask" answer too, but what
// it does in their headless and auto-approve modes isn't documented (in Gemini
// CLI a tool that never asks runs anyway). Until that's tested, a rule that
// says "ask" blocks there and tells the agent to get the user's go-ahead.

/** `{ decision, reason }`, as Gemini CLI and Antigravity read it. */
const plainDecision = (d: Decision) => JSON.stringify({ decision: 'deny', reason: decisionText(d, false) });

/** A string argument that is itself JSON-quoted ("\"/path\""), as some Antigravity builds send them. */
function unquote(v: unknown): unknown {
  if (typeof v !== 'string' || v.length < 2 || !v.startsWith('"') || !v.endsWith('"')) return v;
  try {
    const inner: unknown = JSON.parse(v);
    return typeof inner === 'string' ? inner : v;
  } catch {
    return v;
  }
}

export const claudeCode: Adapter = {
  id: 'claude-code',
  name: 'Claude Code',
  configFile: (ctx) => path.join(ctx.claudeDir, 'settings.json'),
  layout: 'nested',
  events: [
    { event: 'SessionStart', timeout: 30 },
    { event: 'UserPromptSubmit', timeout: 30 },
    { event: 'PreToolUse', matcher: '*', timeout: 30 },
    { event: 'PostToolUse', matcher: '*', timeout: 30 },
    { event: 'PostToolUseFailure', matcher: '*', timeout: 30 },
    { event: 'Stop', timeout: 30 },
    { event: 'SessionEnd', timeout: 5 },
  ],
  // Claude Code runs it with Git Bash, but Cursor also runs Claude Code's
  // hooks, in PowerShell and without the args of exec form. The cmd shim
  // under a path with no spaces or quotes reads the same in both.
  windowsRunner: 'shim',
  afterInstall: 'Claude Code: restart it, then work as usual.',
  asks: true,
  decide: claudeDecision(true),
  normalize(raw) {
    // Cursor replays Claude Code hooks by default; the Cursor adapter records those
    if (raw.cursor_version !== undefined) return null;
    const moment = own(CLAUDE_EVENTS, String(raw.hook_event_name));
    return moment ? common(raw, moment) : null;
  },
};

export const codex: Adapter = {
  id: 'codex',
  name: 'Codex',
  configFile: (ctx) => path.join(ctx.codexDir, 'hooks.json'),
  layout: 'nested',
  // no matcher means every tool; older Codex builds validate matchers as regex, where "*" is invalid
  events: [
    { event: 'SessionStart', timeout: 30 },
    { event: 'UserPromptSubmit', timeout: 30 },
    { event: 'PreToolUse', timeout: 30 },
    { event: 'PostToolUse', timeout: 30 },
    { event: 'Stop', timeout: 30 },
    { event: 'SessionEnd', timeout: 3 },
  ],
  // Codex runs hooks through `%COMSPEC% /C`
  windowsRunner: 'cmd',
  afterInstall: 'Codex: start it and run /hooks once to approve the new hooks (Codex asks for every new hook).',
  decide: claudeDecision(false),
  normalize(raw) {
    const moment = own(CLAUDE_EVENTS, String(raw.hook_event_name));
    return moment ? common(raw, moment) : null;
  },
};

const CURSOR_EVENTS: Record<string, Moment> = {
  sessionStart: 'start',
  beforeSubmitPrompt: 'prompt',
  preToolUse: 'pre',
  postToolUse: 'post',
  postToolUseFailure: 'post-fail',
  stop: 'stop',
  sessionEnd: 'end',
};

// Cursor's tool names, mapped onto the Claude Code ones the summaries know
const CURSOR_TOOLS: Record<string, [string, Record<string, string>?]> = {
  Shell: ['Bash'],
  Read: ['Read'],
  Write: ['Write'],
  // Grep's file_path is where it searches, not a file it reads
  Grep: ['Grep', { file_path: 'path' }],
  Task: ['Task'],
  Delete: ['Delete'],
};

/** Parse a JSON string, or give it back as it was. */
function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

export const cursor: Adapter = {
  id: 'cursor',
  name: 'Cursor',
  configFile: (ctx) => path.join(ctx.home, '.cursor', 'hooks.json'),
  layout: 'flat',
  scaffold: { version: 1 },
  events: [
    { event: 'sessionStart', timeout: 30 },
    { event: 'beforeSubmitPrompt', timeout: 30 },
    { event: 'preToolUse', timeout: 30 },
    { event: 'postToolUse', timeout: 30 },
    { event: 'postToolUseFailure', timeout: 30 },
    { event: 'stop', timeout: 30 },
    { event: 'sessionEnd', timeout: 5 },
  ],
  // Cursor pipes the payload into PowerShell on Windows
  windowsRunner: 'powershell',
  // Cursor checks the answer against each event's schema, and one that doesn't
  // fit blocks a tool call. preToolUse needs a "permission", and "allow" could
  // skip Cursor's own approval, so it gets no answer at all (Cursor runs the
  // tool, as for a hook that failed). The rest take `{}`, or "go on". A
  // payload that couldn't be read might have been a preToolUse: no answer.
  ack: (raw) => {
    const event = raw.hook_event_name;
    if (event === 'beforeSubmitPrompt') return '{"continue":true}';
    return typeof event === 'string' && event && event !== 'preToolUse' ? '{}' : undefined;
  },
  afterInstall: 'Cursor: hooks reload on save. The Cursor CLI sends no prompt events, so there undo goes back one change at a time; on Windows run it from PowerShell, not Git Bash.',
  // Cursor ignores "ask" in hooks, so it blocks
  decide: (d) => JSON.stringify({ permission: 'deny', user_message: decisionText(d, false), agent_message: decisionText(d, false) }),
  normalize(raw) {
    const moment = own(CURSOR_EVENTS, String(raw.hook_event_name));
    if (!moment) return null;
    // Cursor reports a call it was told to block as a failure; the guard step already says so
    if (moment === 'post-fail' && raw.failure_type === 'permission_denied') return null;
    const input = common(raw, moment);
    input.session_id = str(raw.conversation_id) ?? input.session_id;
    const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots.filter((x): x is string => typeof x === 'string') : [];
    // Cursor sends cwd as "" for most tools
    input.cwd = input.cwd ?? roots[0];
    const tool = input.tool_name;
    if (tool?.startsWith('MCP:')) {
      // MCP:<tool>, or MCP:<server>:<tool> in some builds
      const parts = tool.slice(4).split(':');
      input.tool_name = parts.length > 1 ? `mcp__${parts[0]}__${parts.slice(1).join(':')}` : `mcp__cursor__${parts[0]}`;
    } else {
      mapTool(input, CURSOR_TOOLS);
    }
    if (typeof raw.duration === 'number') input.duration_ms = Math.round(raw.duration);
    if (input.tool_response === undefined) input.tool_response = maybeJson(raw.tool_output ?? raw.output ?? raw.result_json);
    if (moment === 'post-fail' && input.tool_response === undefined) input.tool_response = str(raw.error_message);
    return input;
  },
};

// Rename a tool and its arguments onto the Claude Code names the summaries know.
function mapTool(input: HookInput, table: Record<string, [string, Record<string, string>?]>): HookInput {
  // own keys only: a tool named "constructor" must not hit Object.prototype
  const hit = input.tool_name && Object.hasOwn(table, input.tool_name) ? table[input.tool_name] : undefined;
  if (!hit) return input;
  const [name, args] = hit;
  if (input.tool_input) input.raw_input = input.tool_input;
  input.tool_name = name;
  if (args && input.tool_input) {
    const mapped: Record<string, unknown> = { ...input.tool_input };
    // the old name goes, so what's stored is what the summaries and rules read (and content isn't kept twice)
    for (const [from, to] of Object.entries(args)) {
      if (!Object.hasOwn(input.tool_input, from)) continue;
      delete mapped[from];
      mapped[to] = input.tool_input[from];
    }
    input.tool_input = mapped;
  }
  return input;
}

const GEMINI_EVENTS: Record<string, Moment> = {
  SessionStart: 'start',
  BeforeAgent: 'prompt',
  BeforeTool: 'pre',
  AfterTool: 'post',
  AfterAgent: 'stop',
  SessionEnd: 'end',
};

const GEMINI_TOOLS: Record<string, [string, Record<string, string>?]> = {
  run_shell_command: ['Bash'],
  read_file: ['Read'],
  write_file: ['Write'],
  replace: ['Edit'],
  list_directory: ['LS', { dir_path: 'path' }],
  glob: ['Glob', { dir_path: 'path' }],
  grep_search: ['Grep', { dir_path: 'path' }],
  search_file_content: ['Grep', { dir_path: 'path' }],
  web_fetch: ['WebFetch', { prompt: 'url' }],
  google_web_search: ['WebSearch'],
  read_many_files: ['Read'],
  invoke_agent: ['Agent'],
};

// Gemini CLI reads hooks from settings.json ($GEMINI_CLI_HOME/.gemini when
// set). They only run in folders the user has marked as trusted
// (security.folderTrust, on by default). Since June 2026 Gemini CLI serves
// Code Assist Standard and Enterprise and paid API keys; personal accounts
// moved to Antigravity CLI.
export const gemini: Adapter = {
  id: 'gemini',
  name: 'Gemini CLI',
  configFile: (ctx) => path.join(ctx.geminiHome, '.gemini', 'settings.json'),
  // ~/.gemini is also Antigravity's folder
  cli: 'gemini',
  layout: 'nested',
  // Gemini's timeouts are in milliseconds and its matcher is an unanchored regex
  events: [
    { event: 'SessionStart', timeout: 30_000 },
    { event: 'BeforeAgent', timeout: 30_000 },
    { event: 'BeforeTool', matcher: '.*', timeout: 30_000 },
    { event: 'AfterTool', matcher: '.*', timeout: 30_000 },
    { event: 'AfterAgent', timeout: 30_000 },
    { event: 'SessionEnd', timeout: 5_000 },
  ],
  windowsRunner: 'powershell',
  // with nothing on stdout Gemini CLI shows stderr to the user, so say something
  ack: '{}',
  afterInstall: 'Gemini CLI: hooks only run in folders you have trusted.',
  decide: plainDecision,
  normalize(raw) {
    const moment = own(GEMINI_EVENTS, String(raw.hook_event_name));
    if (!moment) return null;
    const input = mapTool(common(raw, moment), GEMINI_TOOLS);
    const mcp = obj(raw.mcp_context);
    if (mcp && str(mcp.server_name) && str(mcp.tool_name)) input.tool_name = `mcp__${mcp.server_name}__${mcp.tool_name}`;
    const resp = obj(raw.tool_response);
    if (moment === 'post' && resp?.error) input.moment = 'post-fail';
    return input;
  },
};

const ANTIGRAVITY_EVENTS: Record<string, Moment> = { PreInvocation: 'prompt', PreToolUse: 'pre', PostToolUse: 'post', Stop: 'stop' };

const ANTIGRAVITY_TOOLS: Record<string, [string, Record<string, string>?]> = {
  run_command: ['Bash', { CommandLine: 'command' }],
  view_file: ['Read', { AbsolutePath: 'file_path' }],
  write_to_file: ['Write', { TargetFile: 'file_path' }],
  replace_file_content: ['Edit', { TargetFile: 'file_path' }],
  multi_replace_file_content: ['Edit', { TargetFile: 'file_path' }],
  read_url_content: ['WebFetch', { Url: 'url' }],
  search_web: ['WebSearch'],
  list_dir: ['LS', { DirectoryPath: 'path' }],
  grep_search: ['Grep', { Query: 'pattern', SearchPath: 'path' }],
  find_by_name: ['Glob', { Pattern: 'pattern', SearchDirectory: 'path' }],
  invoke_subagent: ['Agent'],
  ask_question: ['AskUserQuestion'],
};

// Antigravity (CLI, desktop and IDE share ~/.gemini/config/hooks.json). Its
// payload is camelCase and doesn't say which event fired, and hooks run with
// the hooks file's folder as cwd. There's no prompt event: the first model
// call of a turn (PreInvocation, invocationNum 0) stands in for it.
export const antigravity: Adapter = {
  id: 'antigravity',
  name: 'Antigravity',
  configFile: (ctx) => path.join(ctx.home, '.gemini', 'config', 'hooks.json'),
  layout: 'group',
  events: [
    { event: 'PreInvocation', timeout: 30 },
    { event: 'PreToolUse', matcher: '.*', timeout: 30 },
    { event: 'PostToolUse', matcher: '.*', timeout: 30 },
    { event: 'Stop', timeout: 30 },
  ],
  flatEvents: ['PreInvocation', 'Stop'],
  eventArg: true,
  // reported both as cmd /C and as a plain split on spaces with quotes passed
  // through; a command with no quotes and no spaces works either way
  windowsRunner: 'cmd',
  // no ack: PreToolUse takes empty output as no objection, while `{}` there
  // counts as a denial (seen on agy 1.2.16), which would block every tool
  afterInstall: "Antigravity: it doesn't pass on the prompt text, so turns show up as \"New turn\".",
  decide: plainDecision,
  normalize(raw, event) {
    const moment = event ? own(ANTIGRAVITY_EVENTS, event) : undefined;
    if (!moment) return null;
    // only the first model call of a turn starts one
    if (moment === 'prompt' && raw.invocationNum !== 0) return null;
    // a stop while background tasks still run isn't the end of the turn
    if (moment === 'stop' && raw.fullyIdle === false) return null;
    const call = obj(raw.toolCall);
    const args = call ? obj(call.args) : undefined;
    const roots = Array.isArray(raw.workspacePaths) ? raw.workspacePaths.filter((x): x is string => typeof x === 'string') : [];
    const step = raw.stepIdx;
    const input: HookInput = {
      moment,
      session_id: str(raw.conversationId),
      transcript_path: str(raw.transcriptPath) ?? null,
      cwd: roots[0],
      tool_name: call ? str(call.name) : undefined,
      tool_input: args ? Object.fromEntries(Object.entries(args).map(([k, v]) => [k, unquote(v)])) : undefined,
      tool_use_id: typeof step === 'number' || typeof step === 'string' ? `step-${step}` : undefined,
      model: str(raw.modelName),
      prompt: moment === 'prompt' ? 'New turn' : undefined,
    };
    // PostToolUse carries an error message when the tool failed, "" when it didn't
    if (moment === 'post' && str(raw.error)) {
      input.moment = 'post-fail';
      input.tool_response = str(raw.error);
    }
    return mapTool(input, ANTIGRAVITY_TOOLS);
  },
};

// Copilot CLI loads every file in ~/.copilot/hooks/ ($COPILOT_HOME/hooks/).
// Registered with PascalCase event names it sends Claude Code's payload and
// tool names, but no tool_use_id, and the tool's output as tool_result.
export const copilot: Adapter = {
  id: 'copilot',
  name: 'Copilot CLI',
  configFile: (ctx) => path.join(ctx.copilotDir, 'hooks', 'zerostel.json'),
  // ~/.copilot is also created by the Copilot editor extensions
  cli: 'copilot',
  layout: 'owned',
  events: [
    { event: 'SessionStart', timeout: 30 },
    { event: 'UserPromptSubmit', timeout: 30 },
    { event: 'PreToolUse', timeout: 30 },
    { event: 'PostToolUse', timeout: 30 },
    { event: 'PostToolUseFailure', timeout: 30 },
    { event: 'Stop', timeout: 30 },
    { event: 'SessionEnd', timeout: 5 },
  ],
  windowsRunner: 'powershell',
  afterInstall: 'Copilot CLI: hooks load from ~/.copilot/hooks/zerostel.json on its next start.',
  // the documented answer is top-level; some versions only read Claude Code's nested one, so both
  decide: (d) => {
    const nested = JSON.parse(claudeDecision(false)(d)) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    const { permissionDecision, permissionDecisionReason } = nested.hookSpecificOutput;
    return JSON.stringify({ permissionDecision, permissionDecisionReason, ...nested });
  },
  render(r) {
    const hooks: Record<string, unknown[]> = {};
    for (const e of this.events) hooks[e.event] = [{ type: 'command', bash: r.unix(), powershell: r.powershell(), timeoutSec: e.timeout }];
    return JSON.stringify({ version: 1, hooks }, null, 2) + '\n';
  },
  normalize(raw) {
    const moment = own(CLAUDE_EVENTS, String(raw.hook_event_name));
    if (!moment) return null;
    // its file tools take "path" where Claude Code says "file_path"
    const input = mapTool(common(raw, moment), { Read: ['Read', { path: 'file_path' }], View: ['Read', { path: 'file_path' }] });
    const result = obj(raw.tool_result);
    if (input.tool_response === undefined && result) input.tool_response = result.text_result_for_llm ?? result;
    if (moment === 'post' && str(result?.result_type) && result!.result_type !== 'success') input.moment = 'post-fail';
    if (moment === 'post-fail' && input.tool_response === undefined) input.tool_response = str(raw.error);
    return input;
  },
};

const OPENCODE_EVENTS: Record<string, Moment> = { prompt: 'prompt', pre: 'pre', post: 'post', stop: 'stop' };

const OPENCODE_TOOLS: Record<string, [string, Record<string, string>?]> = {
  bash: ['Bash'],
  read: ['Read', { filePath: 'file_path' }],
  write: ['Write', { filePath: 'file_path' }],
  edit: ['Edit', { filePath: 'file_path', oldString: 'old_string', newString: 'new_string' }],
  // what GPT models get instead of edit and write: the same patch format as Codex
  apply_patch: ['apply_patch', { patchText: 'patch' }],
  glob: ['Glob'],
  grep: ['Grep'],
  list: ['LS'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  task: ['Task'],
  todowrite: ['TodoWrite'],
  todoread: ['TodoRead'],
  skill: ['Skill'],
  question: ['AskUserQuestion'],
};

// opencode has no command hooks, only JS plugins. Zerostel writes a small
// plugin that forwards tool calls to the hook command in its own payload format.
export const opencode: Adapter = {
  id: 'opencode',
  name: 'opencode',
  configFile: (ctx) => path.join(ctx.configHome, 'opencode', 'plugins', 'zerostel.js'),
  layout: 'owned',
  events: [],
  windowsRunner: 'exec',
  afterInstall: 'opencode: the plugin loads the next time opencode starts.',
  // the plugin reads this and throws, which is how opencode plugins stop a tool
  decide: plainDecision,
  render(r) {
    return `// Written by \`zerostel install --agent opencode\`; \`zerostel uninstall\` removes it.
// Forwards opencode's tool calls to Zerostel. It only stops a tool when one of
// your rules in ~/.zerostel/policy.json says so; if Zerostel fails, the tool runs.
import { spawn } from 'node:child_process';

// the program to run and its first arguments, as absolute paths: nothing is looked up
const ARGV = ${JSON.stringify(r.argv)};

// Runs the hook without holding up opencode's event loop. Never rejects.
function send(payload) {
  return new Promise((resolve) => {
    let out = '';
    let timer;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Zerostel writes its answer before it records anything: act on it as
    // soon as it's whole, and never let a timeout or exit drop a deny
    const answer = () => {
      try { return JSON.parse(out || '{}'); } catch { return null; }
    };
    let body;
    let child;
    try {
      body = serialize(payload);
      child = spawn(ARGV[0], [...ARGV.slice(1), 'hook', 'opencode'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish({});
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(answer() ?? {});
    }, 30000);
    child.on('error', () => finish(answer() ?? {}));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const a = answer();
      if (a && a.decision) finish(a);
    });
    child.on('close', () => finish(answer() ?? {}));
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

// Tool arguments can hold what JSON can't (a BigInt, an object that loops
// back on itself); that must never turn into an error that blocks the tool.
function serialize(payload) {
  try {
    return JSON.stringify(payload);
  } catch {}
  const seen = new WeakSet();
  return JSON.stringify(payload, (k, v) => {
    if (typeof v === 'bigint') return String(v);
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

// For the end of a turn: \`opencode run\` exits right after it, so the hook
// runs on its own instead of being waited for (and cut short).
function post(payload) {
  try {
    const child = spawn(ARGV[0], [...ARGV.slice(1), 'hook', 'opencode'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: true });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(serialize(payload));
    child.unref();
  } catch {}
}

// what the user typed, without the file contents opencode adds for @-mentions
function text(output) {
  const parts = Array.isArray(output?.parts) ? output.parts : [];
  return parts.filter((p) => p && p.type === 'text' && !p.synthetic).map((p) => p.text).join('\\n');
}

export const Zerostel = async ({ directory, worktree }) => {
  // outside a git repository opencode sets worktree to "/"
  const cwd = worktree && worktree !== '/' ? worktree : directory;
  return {
    'chat.message': async (input, output) => { await send({ event: 'prompt', session_id: input?.sessionID, prompt: text(output), cwd }); },
    'tool.execute.before': async (input, output) => {
      const d = await send({ event: 'pre', session_id: input?.sessionID, tool_use_id: input?.callID, tool_name: input?.tool, tool_input: output?.args, cwd });
      if (d && d.decision === 'deny') throw new Error(String(d.reason || 'Zerostel policy blocked this'));
    },
    'tool.execute.after': async (input, output) => { await send({ event: 'post', session_id: input?.sessionID, tool_use_id: input?.callID, tool_name: input?.tool, tool_input: input?.args, tool_response: output?.output, cwd }); },
    event: async ({ event }) => {
      // session.idle is the older name for session.status with status "idle"
      const idle = event?.type === 'session.idle' || (event?.type === 'session.status' && event.properties?.status?.type === 'idle');
      if (idle) post({ event: 'stop', session_id: event.properties?.sessionID, cwd });
    },
  };
};
`;
  },
  normalize(raw) {
    const moment = own(OPENCODE_EVENTS, String(raw.event));
    return moment ? mapTool(common(raw, moment), OPENCODE_TOOLS) : null;
  },
};

const DEEPSEEK_EVENTS: Record<string, Moment> = { start: 'start', prompt: 'prompt', pre: 'pre', post: 'post', 'post-fail': 'post-fail', stop: 'stop', end: 'end' };

// DeepSeek Harness's own tool names (bash on macOS and Linux, pwsh on Windows)
const DEEPSEEK_TOOLS: Record<string, [string, Record<string, string>?]> = {
  bash: ['Bash'],
  pwsh: ['PowerShell'],
  read: ['Read'],
  read_image: ['Read'],
  write: ['Write'],
  edit: ['Edit'],
  str_replace_editor: ['Edit', { path: 'file_path' }],
  glob: ['Glob'],
  grep: ['Grep'],
  web_fetch: ['WebFetch'],
  web_search: ['WebSearch'],
  subagent: ['Agent'],
  subagent_fork: ['Agent'],
  subagent_codex: ['Agent'],
  subagent_claude_code: ['Agent'],
  todo_write: ['TodoWrite'],
  ask_user_question: ['AskUserQuestion'],
  skill: ['Skill'],
  exit_plan_mode: ['ExitPlanMode'],
  job_list: ['BashOutput'],
  job_output: ['BashOutput'],
  job_kill: ['KillShell'],
};

/** Inside a YAML single-quoted string only ' needs escaping, as ''. */
const yamlQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

// DeepSeek Harness (dsh) is built from Cordis plugins. Its Claude Code hook
// bridge is off by default and runs hooks in its sandbox, where they can't
// write ~/.zerostel, so Zerostel adds a small plugin of its own instead: the
// plugin runs in dsh's own process and forwards each step to the hook
// command. It's registered in the home-level patch, which every profile reads.
export const deepseek: Adapter = {
  id: 'deepseek',
  name: 'DeepSeek Harness',
  configFile: (ctx) => path.join(ctx.dshHome, 'cordis.patch.yml'),
  layout: 'block',
  events: [],
  cli: 'dsh',
  windowsRunner: 'exec',
  experimental: true,
  afterInstall: 'DeepSeek Harness: the plugin loads the next time dsh starts. Support is experimental.',
  // the plugin turns this into { kind: 'deny' }
  decide: plainDecision,
  companion: {
    file: (ctx) => path.join(ctx.dataDir, 'bin', 'deepseek-plugin.mjs'),
    render(r) {
      return `// Written by \`zerostel install --agent deepseek\`; \`zerostel uninstall\` removes it.
// A DeepSeek Harness plugin that forwards each step to Zerostel. It only stops
// a tool when one of your rules in ~/.zerostel/policy.json says so; if
// Zerostel fails, the tool runs.
import { spawn } from 'node:child_process';

// the program to run and its first arguments, as absolute paths: nothing is looked up
const ARGV = ${JSON.stringify(r.argv)};

export const name = 'zerostel';

// Runs the hook without holding up dsh. Never rejects.
function send(payload) {
  return new Promise((resolve) => {
    let out = '';
    let timer;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Zerostel writes its answer before it records anything: act on it as
    // soon as it's whole, and never let a timeout or exit drop a deny
    const answer = () => {
      try { return JSON.parse(out || '{}'); } catch { return null; }
    };
    let body;
    let child;
    try {
      body = serialize(payload);
      child = spawn(ARGV[0], [...ARGV.slice(1), 'hook', 'deepseek'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish({});
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(answer() ?? {});
    }, 30000);
    child.on('error', () => finish(answer() ?? {}));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const a = answer();
      if (a && a.decision) finish(a);
    });
    child.on('close', () => finish(answer() ?? {}));
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

// Tool arguments can hold what JSON can't (a BigInt, an object that loops
// back on itself); that must never turn into an error that blocks the tool.
function serialize(payload) {
  try {
    return JSON.stringify(payload);
  } catch {}
  const seen = new WeakSet();
  return JSON.stringify(payload, (k, v) => {
    if (typeof v === 'bigint') return String(v);
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

// For the end of a session: dsh may be shutting down, so the hook runs on its own.
function post(payload) {
  try {
    const child = spawn(ARGV[0], [...ARGV.slice(1), 'hook', 'deepseek'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: true });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(serialize(payload));
    child.unref();
  } catch {}
}

const text = (blocks) => (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
const where = (agent) => ({ session_id: agent?.session?.header?.id, cwd: agent?.session?.header?.cwd });

export function apply(ctx) {
  // calls a rule stopped: dsh still reports them as finished, which isn't news
  const denied = new Set();
  ctx.on('agent/created', async ({ agent, source }) => {
    await send({ event: 'start', ...where(agent), source });
  });
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (Array.isArray(messages) && messages.length) await send({ event: 'prompt', ...where(agent), prompt: text(messages.flatMap((m) => m?.content ?? [])) });
    return next();
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    const d = await send({ event: 'pre', ...where(exec.agent), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId });
    if (d && d.decision === 'deny') {
      if (denied.size > 1000) denied.clear();
      denied.add(exec.callId);
      return { kind: 'deny', reason: String(d.reason || 'Zerostel policy blocked this') };
    }
    return next();
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (denied.delete(exec.callId)) return next();
    await send({ event: result?.isError ? 'post-fail' : 'post', ...where(exec.agent), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: text(result?.content) });
    return next();
  });
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    await send({ event: 'stop', ...where(agent) });
  });
  ctx.on('agent/disposed', ({ agent }) => {
    post({ event: 'end', ...where(agent) });
  });
}
`;
    },
  },
  block: (ctx) => {
    const plugin = path.join(ctx.dataDir, 'bin', 'deepseek-plugin.mjs').replace(/\\/g, '/');
    // a line break or control character would end the YAML string early
    if (/[\u0000-\u001f\u007f]/.test(plugin)) throw new Error(`can't write ${JSON.stringify(plugin)} into a YAML patch`);
    return `- insert:\n    - id: zerostel\n      name: ${yamlQuote(plugin)}\n`;
  },
  normalize(raw) {
    const moment = own(DEEPSEEK_EVENTS, String(raw.event));
    return moment ? mapTool(common(raw, moment), DEEPSEEK_TOOLS) : null;
  },
};

export const ADAPTERS: Adapter[] = [claudeCode, codex, cursor, gemini, antigravity, copilot, opencode, deepseek];

/** What a hook prints when no rule has anything to say. */
export function ackFor(a: Adapter, raw: Record<string, unknown>): string | undefined {
  try {
    return typeof a.ack === 'function' ? a.ack(raw && typeof raw === 'object' ? raw : {}) : a.ack;
  } catch {
    return undefined;
  }
}

export function getAdapter(id: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
