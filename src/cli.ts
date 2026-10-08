// first: on Windows, paths Node would abort on become ordinary errors (src/util/win-paths.ts)
import './util/win-paths-install.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ackFor, ADAPTERS, getAdapter, type Adapter } from './agents/adapters.js';
import { handleHook, type HookResult } from './agents/hooks.js';
import { runWrapped } from './agents/run.js';
import { checkKind, checkName, checkStatuses, checksSummary, failingStreaks, renderChecks, runCommand } from './commands/checks.js';
import { checkHandoff, handoffSession, renderHandoff } from './commands/handoff.js';
import { applyRestore, changedByOthers, rewindTarget, undoTarget, type Restored, type Target } from './commands/rewind.js';
import { agentPresent, applyPlan, defaultAgents, hookStatus, installBin, planInstall, planUninstall } from './install.js';
import { doctor, find, projects, project, pruneCmd, sessionHeader, sessionJson } from './commands/more.js';
import { completionScript, SHELLS } from './commands/completion.js';
import { runDemo } from './commands/demo.js';
import { guardrailsSummary, policyCmd, verifyCmd } from './commands/trust.js';
import { configPath, loadConfig } from './config.js';
import { redact } from './detect/secrets.js';
import { renderReport } from './report/html.js';
import { serveMcp } from './mcp/server.js';
import { startUi } from './ui/server.js';
import { listProjects, openProject, unsafeRoot, type Project } from './store/project.js';
import { append, findSession, shortId, lastEventByAgent, listSessions, loadSession, newId, now, readState, regressions, sessionRef, stepDuration, writeState, type Session } from './store/session.js';
import { baselineRunning, changes, coverage, coverageNote, diffText, head, repoSize, snapshot, snapshotsPaused, takeBaseline } from './store/shadow.js';
import { gitVersion } from './util/git.js';
import { withLock } from './util/lock.js';
import { defaultCtx, displayPath, ensurePrivateDir, tilde, type Ctx } from './util/paths.js';
import { ago, c, clean, err, fmtBytes, fmtClock, fmtDate, fmtDuration, oneLine, out, selfCommand } from './util/term.js';
import { childEnv, findExecutable, neutralCwd } from './util/exec.js';
import { writeFileAtomic } from './util/files.js';
import { STANDALONE, VERSION } from './version.js';
import { agentName, protectionNote, renderSessionRow, renderTimeline } from './view/timeline.js';

const HELP = `${c.bold('zerostel')} ${VERSION} — rewind any AI agent to point zero

${c.bold('Try it')}
  zerostel demo               a throwaway project with one recorded agent turn to play with

${c.bold('Record')}
  zerostel install            record every agent found on this machine (adds hooks)
  zerostel run -- <command>   record any agent or script by watching file changes

${c.bold('Look')}
  zerostel log [-n 20]        timeline of the latest session (--changes: only file changes)
  zerostel sessions           all recorded sessions in this project
  zerostel show <n>           details of step n
  zerostel diff <n>           what step n changed

${c.bold('Go back')}
  zerostel undo               undo the agent's last turn (or your last rewind)
  zerostel rewind <n>         back to just before step n   (--after: just after it; 0: point zero)
  zerostel snapshot [-m msg]  save a checkpoint right now

${c.bold('Check the work')}
  zerostel checks             tests, type checks and builds this session ran: passed, failed, or out of date
  zerostel check -- <cmd>     run one yourself and record it against the code as it is now
  zerostel handoff [-o file]  what the next agent or person needs to carry on: asks, state, checks, dead ends
  zerostel handoff check <f>  does the folder still match that handoff?

${c.bold('Share and check')}
  zerostel report [--open]    export the session as a single HTML page (-o to pick the file)
  zerostel verify [--all]     check that a session's log hasn't been edited since it was recorded

${c.bold('Guardrails')}
  zerostel policy             show your rules (~/.zerostel/policy.json)
  zerostel policy init        start with a sensible set: no credentials, ask before force-pushing
  zerostel policy test <cmd>  see what a command or path would hit

${c.bold('For agents')}
  zerostel mcp                MCP server: checkpoint, timeline, rewind (preview first), verify
                              claude mcp add zerostel -- zerostel mcp

${c.bold('Find and tidy')}
  zerostel ui                 browse sessions and rewind from a local web page
  zerostel find <path>        every step that touched a file, across sessions
  zerostel prune              drop sessions older than 30 days (--older-than 7d)
  zerostel projects           every project with recordings, even moved ones

${c.bold('Other')}
  zerostel status             what's installed, disk usage
  zerostel doctor             check the setup; paste the output into bug reports
  zerostel config             show settings (~/.zerostel/config.json)
  zerostel uninstall          remove the hooks
  zerostel completion <shell> tab completion for bash, zsh, fish or powershell

Options: --session <id>  --project <id|path>  --agent <name|all>
         -y/--yes  --dry-run  --only <path>  --keep-others  --json
         --share  --no-prompts  --no-output  --no-diffs   (report)
         --port <n>  --no-open                            (ui)

Agents:  ${ADAPTERS.filter((a) => !a.experimental).map((a) => a.id).join(' ')}
         experimental: ${ADAPTERS.filter((a) => a.experimental).map((a) => a.id).join(' ')}
`;

function fail(msg: string): never {
  err(c.red('✗ ') + msg);
  process.exit(1);
}

function needGit(): void {
  if (!gitVersion()) fail('git was not found on PATH. Zerostel stores snapshots with git; install it from https://git-scm.com and try again.');
}

function session(p: Project, id?: string): Session {
  const ref = findSession(p, id);
  if (!ref) {
    fail(
      id
        ? `no session matching "${id}" in ${p.root}`
        : `nothing recorded for ${p.root} yet.\n  Run ${c.bold('zerostel install')} once and use Claude Code as usual, or ${c.bold('zerostel run -- <agent>')}.`,
    );
  }
  return loadSession(ref);
}

function stepNumber(arg: string | undefined, name: string): number {
  const n = Number(String(arg ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) fail(`usage: zerostel ${name} <step number>   (see zerostel log)`);
  return n;
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) fail('not a terminal; pass --yes to confirm');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${question} ${c.dim('[y/N]')} `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

function listFiles(label: string, files: string[], color: (s: string) => string): void {
  if (!files.length) return;
  out(`  ${color(label.padEnd(10))} ${files.length} file${files.length > 1 ? 's' : ''}`);
  for (const f of files.slice(0, 12)) out(c.dim(`              ${oneLine(f)}`));
  if (files.length > 12) out(c.dim(`              … ${files.length - 12} more`));
}

// Files that make agents, git or the shell run things on their own. Bringing
// back an old version of one is worth a second look.
const AUTO_RUN = /(^|\/)(\.claude|\.codex|\.cursor|\.gemini|\.husky|\.githooks|\.devcontainer)\/|(^|\/)(\.mcp\.json|\.envrc|\.vscode\/tasks\.json)$/;

function printPlan(r: Restored): void {
  listFiles('restore', [...r.modified, ...(r.home?.restored ?? [])], c.yellow);
  listFiles('bring back', r.created, c.green);
  listFiles('remove', r.deleted, c.red);
  if (r.home?.kept.length) out(c.dim(`  left as they are (they didn't exist then): ${r.home.kept.map(oneLine).join(', ')}`));
  if (r.kept.length) out(c.dim(`  left as they are (--keep-others): ${r.kept.slice(0, 12).map(oneLine).join(', ')}${r.kept.length > 12 ? ', …' : ''}`));
  for (const f of [...r.failed, ...(r.home?.failed ?? [])]) out(c.yellow(`  ! ${oneLine(f.path)}: ${f.error}`));
  if (r.env?.length) out(`  ${c.yellow('environment'.padEnd(10))} ${r.env.join(', ')} ${c.dim('(Windows user variables; new terminals see the change)')}`);
  const auto = [...r.modified, ...r.created].filter((f) => AUTO_RUN.test(f));
  if (auto.length) out(c.yellow(`  ! ${auto.map(oneLine).join(', ')} can make agents or git run commands; check ${auto.length > 1 ? 'them' : 'it'} after rewinding`));
}

// Global packages aren't files Zerostel can put back; say what changed and how to undo it.
function packageNote(r: Restored): void {
  if (!r.packages?.length) return;
  out(c.yellow('  ! global packages changed since then; a rewind leaves them as they are:'));
  for (const p of r.packages) out(c.dim(`    ${p.summary}`) + (p.undo.length ? `\n      to undo: ${c.bold(p.undo.join(' && '))}` : ''));
}

// `zerostel rewind` with no number: show the steps that changed files and ask.
async function pickStep(s: Session): Promise<string> {
  if (!process.stdin.isTTY) fail('usage: zerostel rewind <step number>   (see zerostel log)');
  for (const line of renderTimeline(s, { onlyChanges: true })) out(line);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`\nRewind to just before which step? ${c.dim('(number, empty to cancel)')} `);
  rl.close();
  if (!a.trim()) {
    out('Cancelled.');
    process.exit(0);
  }
  return a.trim();
}

// A rewind works on the whole project. Say so, and name other sessions that
// changed things since the target, so nobody thinks it only undoes one agent.
function scopeNote(p: Project, s: Session, t: Target): void {
  const since = t.step ? Date.parse(t.step.ts) : 0;
  const others = listSessions(p).filter((r) => r.file !== s.ref.file && fs.statSync(r.file).mtimeMs > since);
  out(c.dim('  This rewinds the whole project, including your own edits and other agents since then.'));
  if (others.length) out(c.yellow(`  ! ${others.length} other session(s) also changed things since then: ${others.slice(0, 3).map((r) => `${r.agent} ${shortId(r.id)}`).join(', ')}. Use --only <path> to limit the rewind.`));
  const gaps = coverageNote(coverage(p));
  if (gaps) out(c.dim('  ' + gaps));
}

async function doRewind(ctx: Ctx, p: Project, s: Session, t: Target, flags: Flags): Promise<void> {
  needGit();
  // `--only .` (or the project root) means the whole project, not nothing
  if (flags.only?.some((o) => !o.trim())) fail('--only needs a path');
  const picked = flags.only?.map((o) => (path.relative(p.root, path.resolve(p.root, o)) === '' ? '' : displayPath(o, p.root, p.root).replace(/\/+$/, '')));
  const only = picked?.length && picked.every(Boolean) ? picked : undefined;
  // files another session, or you outside the agent, changed since then
  const others = changedByOthers(p, s, t);
  const keep = flags['keep-others'] ? [...others.keys()] : undefined;
  const plan = applyRestore(p, s.ref, t, { only, keep, dryRun: true, ctx });
  const total = plan.created.length + plan.modified.length + plan.deleted.length + (plan.home?.restored.length ?? 0) + (plan.env?.length ?? 0);
  packageNote(plan);
  const what = t.step ? `${t.step.type === 'prompt' ? '❯ ' : ''}${t.step.summary}` : '';
  out(`${c.bold(t.label)}${what ? c.dim('  ' + what) : ''}`);
  if (!total) {
    printPlan(plan);
    out(c.dim(plan.failed.length ? '  Nothing else differs, so nothing to do.' : '  The project already matches that point. Nothing to do.'));
    return;
  }
  printPlan(plan);
  const clash = keep ? [] : [...plan.modified, ...plan.created, ...plan.deleted].filter((f) => others.has(f));
  if (clash.length) {
    out(c.yellow(`  ! changed since then by someone else, and this would take that back too: ${clash.slice(0, 6).map((f) => `${oneLine(f)} (${others.get(f)})`).join(', ')}${clash.length > 6 ? ', …' : ''}`));
    out(c.dim('    --keep-others leaves those files as they are'));
  }
  scopeNote(p, s, t);
  if (flags['dry-run']) {
    out(c.dim('\n  dry run: nothing was changed'));
    return;
  }
  if (!(await confirm(`\nRewind ${total} file${total > 1 ? 's' : ''}?`, !!flags.yes))) {
    out('Cancelled.');
    return;
  }
  // looked at again now: files can change while the question was on screen
  const keepNow = flags['keep-others'] ? [...new Set([...keep!, ...changedByOthers(p, s, t).keys()])] : undefined;
  const res = applyRestore(p, s.ref, t, { only, keep: keepNow, ctx });
  for (const f of res.failed) err(c.yellow(`  ! ${oneLine(f.path)}: ${f.error}`));
  out(res.failed.length ? c.yellow(`! Done, but ${res.failed.length} file${res.failed.length > 1 ? 's were' : ' was'} not restored (see above).`) : c.green('✓ Done.'));
  const z = selfCommand();
  out(c.dim(`  Changed your mind? ${c.bold(`${z} undo`)} puts it back (running undo again undoes this restore, it doesn't go further back).`));
  out(c.dim(`  To go back further: ${c.bold(`${z} log`)}, then ${c.bold(`${z} rewind <n> --dry-run`)}.`));
  out(c.dim('  The agent still remembers the old conversation: rewind it there too, or start a new session.'));
}

type Flags = {
  port?: string;
  'no-open'?: boolean;
  last?: string;
  json?: boolean;
  project?: string;
  'older-than'?: string;
  force?: boolean;
  share?: boolean;
  all?: boolean;
  agent?: string;
  session?: string;
  yes?: boolean;
  'dry-run'?: boolean;
  'keep-others'?: boolean;
  after?: boolean;
  only?: string[];
  changes?: boolean;
  message?: string;
  output?: string;
  open?: boolean;
  'no-prompts'?: boolean;
  'no-output'?: boolean;
  'no-diffs'?: boolean;
  help?: boolean;
  version?: boolean;
};

function parse(argv: string[]): { cmd: string; args: string[]; flags: Flags; rest: string[] } {
  const dd = argv.indexOf('--');
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  const { values, positionals } = parseArgs({
    args: dd >= 0 ? argv.slice(0, dd) : argv,
    allowPositionals: true,
    strict: false,
    options: {
      session: { type: 'string', short: 's' },
      agent: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean' },
      'keep-others': { type: 'boolean' },
      after: { type: 'boolean' },
      only: { type: 'string', multiple: true },
      changes: { type: 'boolean' },
      message: { type: 'string', short: 'm' },
      output: { type: 'string', short: 'o' },
      open: { type: 'boolean' },
      'no-prompts': { type: 'boolean' },
      'no-output': { type: 'boolean' },
      'no-diffs': { type: 'boolean' },
      json: { type: 'boolean' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      project: { type: 'string', short: 'p' },
      'older-than': { type: 'string' },
      force: { type: 'boolean' },
      share: { type: 'boolean' },
      all: { type: 'boolean' },
      last: { type: 'string', short: 'n' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd = '', ...args] = positionals as string[];
  return { cmd, args, flags: values as Flags, rest };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Hooks must never break the agent: no stray stdout, always exit 0, log errors.
async function hook(agentId: string, ctx: Ctx, event?: string): Promise<void> {
  const adapter = getAdapter(agentId);
  let result: HookResult = {};
  let payload: Record<string, unknown> = {};
  let answered = false;
  // a rule's decision goes out the moment it's made, so it reaches the agent
  // even if recording afterwards runs past the agent's hook timeout
  const answer = (r: HookResult) => {
    if (answered || !r.decision || !adapter?.decide) return;
    answered = true;
    say(adapter.decide(r.decision));
  };
  try {
    // PowerShell 5.1 can add a byte-order mark of its own in front of one already there
    const raw = (await readStdin()).replace(/^﻿+/, '');
    payload = JSON.parse(raw || '{}') as Record<string, unknown>;
    if (adapter) result = handleHook(adapter, payload, ctx, event, { onDecision: answer, startBaseline });
    if (result.policyProblem) logError(ctx, `hook ${agentId}: ${result.policyProblem}`);
    if (result.problem) logError(ctx, `hook ${agentId}: ${result.problem}`);
  } catch (e) {
    logError(ctx, `hook ${agentId}: ${(e as Error).stack ?? e}`);
  } finally {
    // a rule's decision replaces the usual empty answer; anything else stays silent
    answer(result);
    const ack = !answered && adapter ? ackFor(adapter, payload) : undefined;
    if (ack) say(ack);
  }
  process.exit(0);
}

// straight to the pipe: process.exit right after must not drop it
function say(text: string): void {
  try {
    fs.writeSync(1, text);
  } catch {
    process.stdout.write(text);
  }
}

// A project's first snapshot can take minutes. It goes on in a process of its
// own (`zerostel baseline`), so the hook returns at once and the agent doesn't
// wait. Started by absolute path, with an argument list and no shell.
function startBaseline(root: string): void {
  try {
    const self = STANDALONE ? [] : [fileURLToPath(import.meta.url)];
    const child = spawn(process.execPath, [...self, 'baseline', '--project', root], { detached: true, stdio: 'ignore', windowsHide: true, cwd: neutralCwd(), env: childEnv() });
    child.on('error', () => {});
    child.unref();
  } catch {
    // the next hook tries again
  }
}

/** `zerostel baseline --project <root>`: the background half of a first snapshot. */
function baseline(ctx: Ctx, root: string | undefined): void {
  if (!root || !path.isAbsolute(root)) return;
  try {
    const p = openProject(root, { ...ctx, cwd: root });
    if (unsafeRoot(p.root, ctx)) return;
    takeBaseline(p, 'point zero (the first snapshot, taken in the background)');
  } catch (e) {
    logError(ctx, `baseline ${root}: ${(e as Error).stack ?? e}`);
  }
}

// errors.log is kept to about 1 MB: one old copy, then it starts over
function logError(ctx: Ctx, message: string): void {
  try {
    ensurePrivateDir(ctx.dataDir, ctx.platform);
    const file = path.join(ctx.dataDir, 'errors.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, `${new Date().toISOString()} ${VERSION} ${redact(message)}\n`, { mode: 0o600 });
  } catch {
    // nowhere left to report it
  }
}

function agentLine(ctx: Ctx, a: Adapter, last: Record<string, number>): string {
  const st = hookStatus(ctx, a);
  if (st.installed) {
    if (st.disabled) return c.yellow('! hooks are disabled in its settings');
    if (!st.healthy) return c.yellow('! hooks point to a missing file — run zerostel install again');
    const exp = a.experimental ? c.dim(' (experimental)') : '';
    // the hooks file being right doesn't prove the agent runs it (trust prompts, old versions)
    const seen = last[a.id];
    if (!seen) return c.yellow('◌ configured, no events yet') + c.dim(' — use the agent once' + (a.id === 'codex' ? ' (and approve with /hooks)' : '')) + exp;
    return c.green('✓ recording') + c.dim(` · last event ${ago(new Date(seen).toISOString())}`) + exp;
  }
  if (!agentPresent(ctx, a)) return c.dim('not found');
  return c.dim('not recording — run ') + c.bold(`zerostel install${a.experimental ? ` --agent ${a.id}` : ''}`) + (a.experimental ? c.dim(' (experimental)') : '');
}

function status(ctx: Ctx): void {
  const g = gitVersion();
  out(`${c.bold('Zerostel')} ${VERSION}`);
  out(`  git           ${g ? c.green('✓ ') + g : c.red('✗ not found — snapshots need git')}`);
  const last = lastEventByAgent(ctx.dataDir);
  for (const a of ADAPTERS) out(`  ${a.name.padEnd(13)} ${agentLine(ctx, a, last)}`);
  const projects = listProjects(ctx);
  const size = projects.reduce((n, pr) => n + repoSize({ dir: pr.dir } as Project), 0);
  const guard = guardrailsSummary(ctx);
  out(`  guardrails    ${guard.level === 'ok' ? c.green('✓ ' + guard.text) : guard.level === 'warn' ? c.yellow('! ' + guard.text) : c.dim(guard.text)}`);
  out(`  data          ${tilde(ctx.dataDir, ctx.home)} · ${projects.length} project${projects.length === 1 ? '' : 's'} · ${fmtBytes(size)}`);
  const p = openProject(ctx.cwd, ctx);
  const sessions = listSessions(p);
  const unsafe = unsafeRoot(p.root, ctx);
  out(`  this project  ${p.root}${unsafe ? c.yellow(` (${unsafe}: timeline only, no snapshots)`) : ''}`);
  if (sessions.length) out(`                ${sessions.length} session${sessions.length > 1 ? 's' : ''} · ${fmtBytes(repoSize(p))} of snapshots`);
  const paused = snapshotsPaused(p);
  if (paused) out(c.yellow(`                ! snapshots paused for an hour: ${paused}`));
  // read-only: looking must not create a store for the folder status runs in
  if (!unsafe && sessions.length && !paused && fs.existsSync(path.join(p.repo.gitDir, 'HEAD')) && head(p) === null) {
    out(c.yellow(baselineRunning(p) ? '                ! the first snapshot is still being taken: steps until it is done can\'t be rewound' : '                ! no snapshot yet: the first one is taken when an agent starts here'));
  }
  const latest = sessions.length ? loadSession(sessions[0]!) : null;
  const note = latest && protectionNote(latest);
  if (note) out(c.yellow(`                ! latest session: ${note}`));
  const checks = latest && checksSummary(latest);
  if (checks) out(`  checks        ${checks} in the latest session · zerostel checks says if they're still current`);
}

function showStep(s: Session, n: number): void {
  const st = s.steps.find((x) => x.n === n) ?? fail(`step #${n} not found`);
  out(`${c.bold(`#${st.n}`)}  ${oneLine(st.summary)}`);
  const ms = stepDuration(st);
  const dur = ms === undefined ? '' : `  ${fmtDuration(ms)}`;
  out(c.dim(`${st.type}${st.tool ? ' · ' + st.tool : ''} · ${fmtDate(st.ts)}:${fmtClock(st.ts).slice(6)}${dur}${st.ok === false ? ' · failed' : ''}`));
  if (st.text) out('\n' + st.text);
  const cmd = (st.input as { command?: string } | undefined)?.command;
  if (cmd) out('\n' + c.cyan(cmd));
  if (st.output) out('\n' + c.dim(st.output));
  if (st.files.length) {
    out('');
    for (const f of st.files) {
      const col = f.status === 'A' ? c.green : f.status === 'D' ? c.red : c.yellow;
      out(`  ${col(f.status)} ${oneLine(f.path)}  ${f.binary ? c.dim('binary') : c.green('+' + f.added) + ' ' + c.red('−' + f.deleted)}`);
    }
    out(c.dim(`\n  zerostel diff ${st.n}    zerostel rewind ${st.n}`));
  }
}

function printDiff(p: Project, s: Session, n: number): void {
  needGit();
  const st = s.steps.find((x) => x.n === n) ?? fail(`step #${n} not found`);
  if (!st.before || !st.after || st.before === st.after) {
    out(c.dim(`step #${n} didn't change any files`));
    return;
  }
  const text = diffText(p, st.before, st.after);
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) out(c.bold(line));
    else if (line.startsWith('+')) out(c.green(line));
    else if (line.startsWith('-')) out(c.red(line));
    else if (line.startsWith('@@')) out(c.cyan(line));
    else out(line);
  }
}

function pickAgents(ctx: Ctx, flag: string | undefined, uninstall: boolean): Adapter[] {
  if (flag && flag !== 'all') {
    return [...new Set(flag.split(','))].map((id) => {
      const a = getAdapter(id.trim());
      if (!a) fail(`--agent must be one of: ${ADAPTERS.map((x) => x.id).join(', ')}, all (or several, comma-separated)`);
      return a;
    });
  }
  if (uninstall) return ADAPTERS;
  if (flag === 'all') return ADAPTERS.filter((a) => !a.experimental);
  return defaultAgents(ctx);
}

function install(ctx: Ctx, flags: Flags, uninstall: boolean): void {
  const agents = pickAgents(ctx, flags.agent, uninstall);
  // one agent's config Zerostel can't read or write doesn't stop the others
  const failed: string[] = [];
  const each = <T,>(a: { name: string }, fn: () => T): T | null => {
    try {
      return fn();
    } catch (e) {
      err(c.yellow(`! ${a.name}: ${(e as Error).message}`));
      failed.push(a.name);
      return null;
    }
  };
  if (uninstall) {
    for (const a of agents) {
      const plan = each(a, () => planUninstall(ctx, a));
      if (!plan || plan.before === plan.after) continue;
      if (flags['dry-run']) {
        out(c.dim(`Would write ${plan.file}:\n`) + plan.after);
        continue;
      }
      const backup = each(a, () => applyPlan(plan));
      if (backup === null && failed.includes(a.name)) continue;
      out(c.green(`✓ Removed Zerostel hooks for ${plan.name}`) + c.dim(`  ${plan.file}${backup ? `  (backup: ${path.basename(backup)})` : ''}`));
    }
    if (failed.length) {
      err(c.yellow(`! Hooks may still be installed for ${failed.join(', ')}: fix the file named above and run ${c.bold('zerostel uninstall')} again.`));
      process.exitCode = 1;
    }
    out(c.dim('Recorded sessions and snapshots stay in ' + tilde(ctx.dataDir, ctx.home) + '. Delete that folder to remove them.'));
    return;
  }
  needGit();
  // the copy goes in first: on Windows a hook may name it by its 8.3 short name, which only an existing file has
  if (!flags['dry-run']) installBin(ctx);
  // hooks run this exact Node; one in a per-shell or temporary folder disappears later
  if (ctx.platform === 'win32' && !STANDALONE && /fnm_multishells|[\\/]temp[\\/]/i.test(process.execPath)) {
    err(c.yellow(`! Hooks will run ${process.execPath}, which looks temporary. If it goes away, recording stops (zerostel doctor shows it); install again from a Node that stays put.`));
  }
  const plans = agents.flatMap((a) => each(a, () => planInstall(ctx, a)) ?? []);
  for (const p of plans) for (const w of p.warnings) err(c.yellow('! ' + w));
  if (flags['dry-run']) {
    for (const p of plans) out(c.dim(`Would write ${p.file}:\n`) + p.after);
    return;
  }
  for (const p of plans) {
    const backup = each(p, () => applyPlan(p));
    if (backup === null && failed.includes(p.name)) continue;
    out(c.green(`✓ ${p.name} sessions will be recorded`) + c.dim(`  ${p.file}${backup ? `  (backup: ${path.basename(backup)})` : ''}`));
  }
  if (failed.length) {
    err(c.yellow(`! Not set up for ${failed.join(', ')} (see above); the others are.`));
    process.exitCode = 1;
  }
  out('');
  for (const a of agents) if (a.afterInstall && !failed.includes(a.name)) out(`  ${a.afterInstall}`);
  out(`  Then run ${c.bold('zerostel log')} inside your project.`);
}

// No shell in between: `cmd /c start` would treat & or ^ in the path as syntax.
/** Open a file in its default app. False when there's nothing to open it with. */
function openFile(file: string): boolean {
  // by absolute path only: a bare name would also look in the current (maybe untrusted) folder
  const cmd = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe') : process.platform === 'darwin' ? '/usr/bin/open' : findExecutable('xdg-open');
  if (!cmd) return false;
  const child = spawn(cmd, [file], { detached: true, stdio: 'ignore', cwd: neutralCwd(), env: childEnv() });
  child.on('error', () => {});
  child.unref();
  return true;
}

// Command lines are readable by other users on Linux (/proc/<pid>/cmdline),
// and a browser started with a URL keeps it there. So the browser gets the
// path of a private file that redirects to the address with the token.
function openUi(ctx: Ctx, url: string): boolean {
  ensurePrivateDir(ctx.dataDir, ctx.platform);
  const file = path.join(ctx.dataDir, 'ui-open.html');
  const html = `<!doctype html><meta charset="utf-8"><title>Zerostel</title><script>location.replace(${JSON.stringify(url)})</script>`;
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, html, { mode: 0o600, flag: 'wx' });
  if (!openFile(file)) {
    fs.rmSync(file, { force: true });
    return false;
  }
  setTimeout(() => fs.rmSync(file, { force: true }), 60_000).unref();
  return true;
}

export async function main(argv: string[]): Promise<void> {
  const { cmd, args, flags, rest } = parse(argv);
  if (flags.version) return out(VERSION);
  if (flags.help || cmd === 'help') return out(HELP);
  const ctx = defaultCtx();

  switch (cmd) {
    case 'hook':
      return hook(args[0] ?? 'claude-code', ctx, args[1]);
    case 'baseline':
      return baseline(ctx, flags.project);
    case '':
    case 'status':
      status(ctx);
      if (!cmd) out(`\n${c.dim('zerostel --help for all commands')}`);
      return;
    case 'install':
      return install(ctx, flags, false);
    case 'uninstall':
      return install(ctx, flags, true);
    case 'log':
    case 'timeline': {
      const p = project(ctx, flags);
      const s = session(p, flags.session);
      if (flags.json) return out(JSON.stringify(sessionJson(s), null, 2));
      for (const line of renderTimeline(s, { onlyChanges: flags.changes, last: flags.last ? Number(flags.last) : undefined })) out(line);
      for (const r of regressions(s)) {
        const between = r.changed.length ? `files changed at ${r.changed.slice(0, 8).map((x) => '#' + x.n).join(', ')}${r.changed.length > 8 ? '…' : ''}` : 'no file changes in between';
        out(c.yellow(`\n  ! #${r.failed.n} failed, the same command passed at #${r.passed.n}; ${between}`));
      }
      for (const k of failingStreaks(s)) out(c.yellow(`\n  ! ${oneLine(k.name)} failed ${k.count} times in a row (#${k.from} to #${k.to}): the agent may be going in circles`));
      const gaps = coverageNote(coverage(p));
      if (gaps) out(c.yellow('\n  ! ' + gaps));
      out(c.dim(`\n  zerostel diff <n> · zerostel rewind <n> · zerostel undo · zerostel report`));
      return;
    }
    case 'sessions': {
      const p = project(ctx, flags);
      const refs = listSessions(p);
      if (flags.json) return out(JSON.stringify(refs.map((r) => sessionHeader(loadSession(r))), null, 2));
      if (!refs.length) return out(c.dim(`No sessions recorded for ${p.root}.`));
      out(c.dim('ID        AGENT         LAST        STEPS  FILES  TOKENS  TITLE'));
      for (const r of refs.slice(0, 50)) out(renderSessionRow(loadSession(r)));
      return;
    }
    case 'show': {
      const p = project(ctx, flags);
      const s = session(p, flags.session);
      if (flags.json) {
        const n = stepNumber(args[0], 'show');
        return out(JSON.stringify(s.steps.find((x) => x.n === n) ?? fail(`step #${n} not found`), null, 2));
      }
      return showStep(s, stepNumber(args[0], 'show'));
    }
    case 'diff': {
      const p = project(ctx, flags);
      return printDiff(p, session(p, flags.session), stepNumber(args[0], 'diff'));
    }
    case 'rewind':
    case 'goto': {
      const p = project(ctx, flags);
      const s = session(p, flags.session);
      let t: Target;
      try {
        t = rewindTarget(s, args[0] ?? (await pickStep(s)), !!flags.after);
      } catch (e) {
        fail((e as Error).message);
      }
      return doRewind(ctx, p, s, t, flags);
    }
    case 'undo': {
      const p = project(ctx, flags);
      const s = session(p, flags.session);
      const t = undoTarget(s);
      if (!t) {
        out(c.dim('Nothing to undo: no recorded step in this session changed any files.'));
        // files the snapshots can't see (a nested repo, say) may still have changed
        const gaps = coverageNote(coverage(p));
        if (gaps) out(c.yellow('  ! ' + gaps));
        return;
      }
      return doRewind(ctx, p, s, t, flags);
    }
    case 'snapshot':
    case 'save': {
      needGit();
      const p = project(ctx, flags);
      const why = unsafeRoot(p.root, ctx);
      if (why) fail(`refusing to snapshot ${why}; cd into a project first`);
      const latest = findSession(p);
      const ref = latest ?? sessionRef(p, 'manual', 'checkpoints');
      const snap = snapshot(p, flags.message ?? 'manual snapshot');
      append(ref, { e: 'snapshot', ts: now(), id: newId(), snap: snap.sha, message: flags.message ?? 'Manual snapshot' });
      const n = loadSession(ref).steps.filter((x) => x.n).length;
      out(c.green(`✓ Saved as step #${n}`) + c.dim(snap.created ? '' : ' (no changes since the last snapshot)') + c.dim(`  · go back later with zerostel rewind ${n}`));
      if (snap.incomplete) err(c.yellow(`! Some files couldn't be copied and keep an older copy (${snap.incomplete}); a rewind leaves them alone.`));
      return;
    }
    case 'check': {
      needGit();
      if (!rest.length) fail('usage: zerostel check -- <command> [args...]   (a test, type check, linter or build)');
      const p = project(ctx, flags);
      const why = unsafeRoot(p.root, ctx);
      if (why) fail(`refusing to snapshot ${why}; cd into a project first`);
      const ref = findSession(p, flags.session) ?? sessionRef(p, 'manual', 'checkpoints');
      const name = checkName(rest.join(' '));
      // The code the check runs against, saved first so the result can be tied
      // to it. Edits made since the session's last snapshot are recorded as
      // such, as a hook would, so they don't vanish from the timeline.
      const ranOn = withLock(ref.file + '.lock', () => {
        const sha = snapshot(p, `before check: ${name}`).sha;
        const st = readState(ref);
        if (st.lastSnap && st.lastSnap !== sha) {
          const files = changes(p, st.lastSnap, sha);
          if (files.length) append(ref, { e: 'outside', ts: now(), id: newId(), from: st.lastSnap, to: sha, files });
        }
        st.lastSnap = sha;
        writeState(ref, st);
        return sha;
      });
      // it runs in the project the snapshot is of: here if here is inside it, else its root (--project)
      const rel = path.relative(p.root, ctx.cwd);
      const runIn = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? ctx.cwd : p.root;
      const r = await runCommand(rest, runIn);
      withLock(ref.file + '.lock', () => {
        append(ref, { e: 'check', ts: now(), id: newId(), name, kind: checkKind(rest.join(' ')) ?? 'test', snap: ranOn, ok: r.code === 0, by: 'zerostel', exit: r.code, durationMs: r.durationMs, output: r.output, cwd: runIn });
        // files the check itself wrote (snapshots, generated code) show up as their own step;
        // a hook that ran meanwhile has already recorded its part
        const after = snapshot(p, `after check: ${name}`).sha;
        const st = readState(ref);
        const from = st.lastSnap ?? ranOn;
        if (after !== from) {
          const files = changes(p, from, after);
          if (files.length) append(ref, { e: 'change', ts: now(), id: newId(), from, to: after, files });
        }
        st.lastSnap = after;
        writeState(ref, st);
      });
      err(r.code === 0 ? c.green(`\n✓ ${name}: passed`) : c.red(`\n✗ ${name}: failed (exit ${r.code})`));
      err(c.dim(`  recorded against the code as it is now · zerostel checks shows where every check stands`));
      process.exit(r.code);
    }
    case 'handoff': {
      needGit();
      const p = project(ctx, flags);
      if (args[0] === 'check' && !args[1]) fail('usage: zerostel handoff check <file>');
      // a folder with nothing recorded gets no snapshot store just from asking
      const s = flags.session ? session(p, flags.session) : (handoffSession(p) ?? session(p));
      let current: string | null = null;
      try {
        if (!unsafeRoot(p.root, ctx)) current = snapshot(p, 'handoff').sha;
      } catch {
        // snapshots paused or not ready
      }
      if (args[0] === 'check') {
        if (!current) fail("can't take a snapshot of this project to compare with");
        const res = checkHandoff(p, fs.readFileSync(args[1]!, 'utf8'), current, args[1]);
        for (const line of res.lines) out(res.ok ? c.green(line) : line);
        process.exit(res.ok ? 0 : 1);
      }
      const text = renderHandoff(p, s, current, { prompts: !flags['no-prompts'], version: VERSION });
      // file names and commands can carry terminal escape codes
      if (!flags.output) return void process.stdout.write(clean(text));
      const file = path.resolve(flags.output);
      writeFileAtomic(file, text, { projectRoot: p.root });
      out(c.green(`✓ Handoff written to ${file}`));
      out(c.dim('  It quotes your prompts; secrets in them are masked. Whoever picks it up can run zerostel handoff check <file> to see if the folder still matches.'));
      return;
    }
    case 'checks': {
      needGit();
      const p = project(ctx, flags);
      const s = session(p, flags.session);
      let current: string | null = null;
      try {
        if (!unsafeRoot(p.root, ctx)) current = snapshot(p, 'checks').sha;
      } catch {
        // snapshots paused or not ready: results are shown without saying if they're out of date
      }
      if (flags.json) return out(JSON.stringify(checkStatuses(p, s, current), null, 2));
      for (const line of renderChecks(p, s, current)) out(line);
      out(c.dim(`\n  zerostel check -- <command> runs one yourself and records it against the code as it is now.`));
      return;
    }
    case 'run': {
      needGit();
      if (!rest.length) fail('usage: zerostel run -- <command> [args...]');
      let id = '';
      const code = await runWrapped(rest, ctx, { onSession: (x) => (id = x) });
      err(c.dim(`\nzerostel: recorded as session ${shortId(id)} · zerostel log to see what changed`));
      process.exit(code);
    }
    case 'report': {
      const p = project(ctx, flags);
      const s = session(p, flags.session);
      const share = !!flags.share;
      const html = renderReport(p, s, {
        share,
        prompts: !share && !flags['no-prompts'],
        output: !share && !flags['no-output'],
        diffs: !share && !flags['no-diffs'],
        version: VERSION,
      });
      // default outside the project, so the report doesn't show up as a change in the next snapshot
      const file = path.resolve(flags.output ?? path.join(ctx.dataDir, 'reports', `${p.id}-${shortId(s.id)}.html`));
      writeFileAtomic(file, html, { projectRoot: p.root });
      out(c.green('✓ ') + file);
      out(c.dim(share ? '  Share mode: no prompts, commands, output or diffs; file paths and counts stay.' : '  Secrets are masked and .env-style files are left out, but skim it before sharing (or use --share).'));
      if (flags.open && !openFile(file)) out(c.dim('  No program to open it with; open the file in a browser.'));
      return;
    }
    case 'find':
      return find(project(ctx, flags), args[0], flags);
    case 'prune':
      return pruneCmd(ctx, project(ctx, flags), flags);
    case 'projects':
      return projects(ctx, flags);
    case 'doctor':
      return doctor(ctx, flags);
    case 'completion': {
      const script = completionScript(args[0] ?? '');
      if (!script) fail(`usage: zerostel completion <${SHELLS.join('|')}>`);
      process.stdout.write(script);
      return;
    }
    case 'demo':
      needGit();
      runDemo(ctx);
      return;
    case 'mcp':
      return serveMcp(ctx);
    case 'verify':
      return verifyCmd(project(ctx, flags), flags);
    case 'policy':
      return policyCmd(ctx, project(ctx, flags).root, args, flags);
    case 'ui': {
      const port = flags.port === undefined ? undefined : Number(flags.port);
      if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) fail('--port must be a number between 1 and 65535');
      const ui = await startUi(ctx, { port });
      out(c.green('✓ ') + 'Zerostel UI: ' + c.bold(ui.url));
      out(c.dim('  It listens on this computer only and needs the token in that address, so keep the address to yourself. Ctrl+C to stop.'));
      if (!flags['no-open'] && !openUi(ctx, ui.url)) out(c.dim('  Open that address in a browser.'));
      await new Promise(() => {});
      return;
    }
    case 'config': {
      const { config, problems } = loadConfig(ctx);
      if (flags.json) return out(JSON.stringify(config, null, 2));
      out(c.dim(`${configPath(ctx)}${fs.existsSync(configPath(ctx)) ? '' : ' (not created yet; these are the defaults)'}`));
      out(JSON.stringify(config, null, 2));
      for (const pr of problems) err(c.yellow('! ' + pr));
      return;
    }
    default:
      err(`unknown command: ${cmd}\n`);
      out(HELP);
      process.exit(1);
  }
}

// `zerostel log | head` closes the pipe early; that's not an error
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
}

main(process.argv.slice(2)).catch((e: Error) => {
  err(c.red('✗ ') + e.message);
  if (process.env.ZEROSTEL_DEBUG) err(String(e.stack));
  process.exit(1);
});
