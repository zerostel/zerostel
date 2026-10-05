import { spawn } from 'node:child_process';
import type { Project } from '../store/project.js';
import type { Session } from '../store/session.js';
import { changes, type FileChange } from '../store/shadow.js';
import { redact } from '../detect/secrets.js';
import { childEnv } from '../util/exec.js';
import { c, oneLine, truncate } from '../util/term.js';
import { agentName } from '../view/timeline.js';

// A check is a command whose result says something about the code: tests,
// type checks, linters, builds. Zerostel ties each result to the snapshot
// the command ran against, so "the tests passed" can be told apart from "the
// tests passed on code that has changed since".

export type CheckKind = 'test' | 'typecheck' | 'lint' | 'build';

const KIND_ORDER: CheckKind[] = ['test', 'typecheck', 'lint', 'build'];

// one segment of a shell command, after any leading VAR=value assignments
const RULES: [CheckKind, RegExp][] = [
  // package scripts: npm test, npm run typecheck, pnpm lint, yarn build, bun test
  ['test', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:t|test|tests|test:\S+|check)(?:\s|$)/],
  ['typecheck', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|types|tsc|check-types)(?:\s|$)/],
  ['lint', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|lint:\S+)(?:\s|$)/],
  ['build', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|build:\S+)(?:\s|$)/],
  // test runners
  ['test', /^(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+|bunx\s+)?(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run)(?:\s|$)/],
  ['test', /^(?:python3?\s+-m\s+|py\s+-m\s+|uv\s+run\s+|poetry\s+run\s+)?(?:pytest|unittest|tox|nox)(?:\s|$)/],
  ['test', /^(?:go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|deno\s+test|swift\s+test|mix\s+test|rspec|phpunit|pest|ctest)(?:\s|$)/],
  ['test', /^(?:mvn|mvnw|\.\/mvnw|gradle|gradlew|\.\/gradlew)\s+(?:\S+\s+)*?(?:test|check|verify)(?:\s|$)/],
  ['test', /^make\s+(?:test|check)(?:\s|$)/],
  // type checkers
  ['typecheck', /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+|bunx\s+)?(?:tsc|vue-tsc)(?:\s|$)/],
  ['typecheck', /^(?:python3?\s+-m\s+|uv\s+run\s+|poetry\s+run\s+)?(?:mypy|pyright)(?:\s|$)/],
  ['typecheck', /^cargo\s+check(?:\s|$)/],
  // linters
  ['lint', /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+|bunx\s+)?(?:eslint|biome\s+(?:check|lint)|oxlint|stylelint)(?:\s|$)/],
  ['lint', /^(?:python3?\s+-m\s+|uv\s+run\s+|poetry\s+run\s+)?(?:ruff(?:\s+check)?|flake8|pylint)(?:\s|$)/],
  ['lint', /^(?:golangci-lint|cargo\s+clippy|go\s+vet)(?:\s|$)/],
  // builds
  ['build', /^(?:go\s+build|cargo\s+build|dotnet\s+build|swift\s+build)(?:\s|$)/],
  ['build', /^(?:npx\s+)?(?:vite|next|nuxt|astro)\s+build(?:\s|$)/],
];

function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
    .filter(Boolean);
}

/** What kind of check a shell command runs, or null for any other command. */
export function checkKind(command: string): CheckKind | null {
  const found = new Set<CheckKind>();
  for (const seg of segments(command.slice(0, 10_000))) for (const [kind, re] of RULES) if (re.test(seg)) found.add(kind);
  return KIND_ORDER.find((k) => found.has(k)) ?? null;
}

/** The name a check goes by: the command, on one line, so runs of the same one group together. */
export function checkName(command: string): string {
  // masked before it's cut short: a token cut in half no longer looks like one
  return truncate(oneLine(redact(command.trim().replace(/\s+/g, ' '))), 120);
}

/**
 * Whether the command's exit status can't be the check's own: piped into
 * another program, or followed by `||`, `;` or `&`, so `npm test | tail` and
 * `npm test || true` succeed whatever the tests did.
 */
export function resultMasked(command: string): boolean {
  // operators outside quotes, each with the segment before it
  const parts: { seg: string; op: string }[] = [];
  let seg = '';
  let quote: string | null = null;
  const text = command.slice(0, 10_000);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      seg += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      seg += ch;
      continue;
    }
    const two = text.slice(i, i + 2);
    // 2>&1 and &> are redirections, not "run in the background"
    const redirect = ch === '&' && (text[i - 1] === '>' || text[i + 1] === '>');
    const op = two === '&&' || two === '||' ? two : !redirect && (ch === '|' || ch === ';' || ch === '&' || ch === '\n') ? ch : null;
    if (!op) {
      seg += ch;
      continue;
    }
    parts.push({ seg, op });
    seg = '';
    if (op.length === 2) i++;
  }
  parts.push({ seg, op: '' });
  const k = parts.findIndex((x) => checkKind(x.seg) !== null);
  if (k < 0) return false;
  if (parts[k]!.op === '|' && !/\bpipefail\b/.test(text)) return true;
  if (parts.slice(k).some((x) => x.op === '||' || x.op === ';' || x.op === '&' || x.op === '\n')) return true;
  return /\bexit\s+0\b/.test(parts.slice(k + 1).map((x) => x.seg).join(' '));
}

/**
 * Whether a check an agent ran passed, from what the agent reported about the
 * tool call. Undefined when the agent doesn't say: a missing failure is not a pass.
 */
export function agentCheckResult(agent: string, failed: boolean, response: unknown, output: string | undefined): boolean | undefined {
  const r = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  for (const k of ['exit_code', 'exitCode', 'returncode']) if (typeof r[k] === 'number') return r[k] === 0;
  if (failed) return false;
  // the exit status as agents print it into the tool result
  const m = /\bexit(?:ed with)? code:?\s*(-?\d+)\b/i.exec(output ?? '');
  if (m) return Number(m[1]) === 0;
  // these send a separate event for a tool call that failed, so a plain one means it didn't
  return agent === 'claude-code' || agent === 'cursor' || agent === 'copilot' ? true : undefined;
}

export interface CheckRun {
  n: number; // the step number
  name: string;
  kind: CheckKind;
  ok?: boolean;
  by: 'agent' | 'zerostel';
  snap?: string; // the snapshot of the code it ran against
  ts: string;
}

export function checkRuns(s: Session): CheckRun[] {
  return s.steps
    .filter((x) => x.check)
    .map((x) => ({ n: x.n, ts: x.ts, ...x.check! }));
}

export type Freshness = { state: 'current' } | { state: 'stale'; files: FileChange[] } | { state: 'unknown' };

export interface CheckStatus {
  name: string;
  kind: CheckKind;
  latest: CheckRun;
  freshness: Freshness;
  /** how many times it ran in the session, and whether every one of them failed */
  runs: number;
  alwaysFailed: boolean;
  /** passed at this step, then failed later */
  passedBefore?: CheckRun;
}

/** Test files: a deleted or rewritten test can make a check pass for the wrong reason. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.(cs|java|kt)$/;

/**
 * Where every check of a session stands against `current`, the snapshot of
 * the project as it is now.
 */
export function checkStatuses(p: Project, s: Session, current: string | null): CheckStatus[] {
  const byName = new Map<string, CheckRun[]>();
  for (const run of checkRuns(s)) byName.set(run.name, [...(byName.get(run.name) ?? []), run]);
  const out: CheckStatus[] = [];
  for (const [name, runs] of byName) {
    const latest = runs[runs.length - 1]!;
    let freshness: Freshness = { state: 'unknown' };
    if (latest.snap && current) {
      try {
        const files = changes(p, latest.snap, current);
        freshness = files.length ? { state: 'stale', files } : { state: 'current' };
      } catch {
        // the snapshot is gone (pruned): can't tell
      }
    }
    const passedBefore = latest.ok === false ? [...runs].reverse().find((r) => r.ok === true) : undefined;
    out.push({ name, kind: latest.kind, latest, freshness, runs: runs.length, alwaysFailed: runs.length > 1 && runs.every((r) => r.ok === false), passedBefore });
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.latest.n - b.latest.n);
}

/** Test files the session added, changed or deleted, from its first snapshot to `current`. */
export function testsTouched(p: Project, s: Session, current: string | null): FileChange[] {
  const start = s.steps.find((x) => x.before)?.before;
  if (!start || !current) return [];
  try {
    return changes(p, start, current).filter((f) => TEST_FILE.test(f.path));
  } catch {
    return [];
  }
}

function resultText(st: CheckStatus): string {
  const r = st.latest;
  const who = r.by === 'zerostel' ? 'run by zerostel check' : 'as the agent reported it';
  if (r.ok === true) return c.green('✓ passed') + c.dim(` at #${r.n} (${who})`);
  if (r.ok === false) return c.red('✗ failed') + c.dim(` at #${r.n} (${who})`);
  return c.yellow('? ran') + c.dim(` at #${r.n}, result not reported by the agent`);
}

function freshnessText(f: Freshness): string {
  if (f.state === 'current') return c.green('the code is the same now');
  if (f.state === 'stale') return c.yellow(`out of date: ${f.files.length} file${f.files.length > 1 ? 's' : ''} changed since (${f.files.slice(0, 3).map((x) => oneLine(x.path)).join(', ')}${f.files.length > 3 ? ', …' : ''})`);
  return c.dim("can't tell if the code changed since");
}

/** The `zerostel checks` report, also used by the MCP server and handoffs. */
export function renderChecks(p: Project, s: Session, current: string | null): string[] {
  const statuses = checkStatuses(p, s, current);
  const lines: string[] = [c.bold(`Checks in the ${agentName(s.agent)} session`) + c.dim(`  (${s.steps.find((x) => x.type === 'prompt')?.summary ?? s.id})`)];
  if (!statuses.length) {
    lines.push(c.dim('  No tests, type checks, linters or builds were run in this session.'));
  }
  for (const st of statuses) {
    lines.push(`  ${c.bold(truncate(redact(st.name), 60))}`);
    lines.push(`    ${resultText(st)} · ${freshnessText(st.freshness)}`);
    if (st.passedBefore) lines.push(c.yellow(`    passed at #${st.passedBefore.n}, failing since`));
    else if (st.alwaysFailed) lines.push(c.dim(`    failed all ${st.runs} times it ran in this session: it may have been broken before the session started`));
  }
  for (const k of failingStreaks(s)) lines.push(c.yellow(`  ! ${truncate(redact(k.name), 60)} failed ${k.count} times in a row (#${k.from} to #${k.to}): the agent may be going in circles`));
  const tests = testsTouched(p, s, current);
  if (tests.length) {
    const word = { A: 'added', M: 'changed', D: 'deleted', T: 'changed' } as const;
    lines.push('');
    lines.push(c.yellow(`  ! Test files changed in this session: ${tests.slice(0, 8).map((f) => `${oneLine(f.path)} (${word[f.status]})`).join(', ')}${tests.length > 8 ? ', …' : ''}`));
    lines.push(c.dim('    A passing result means less if the tests themselves were changed or removed; look at them.'));
  }
  return lines;
}

export interface FailingStreak {
  name: string;
  count: number;
  from: number; // step numbers of the first and last failing run
  to: number;
}

/**
 * Checks failing several times in a row, up to now: the agent keeps trying and the
 * check keeps failing. Often time (and tokens) better spent on a new approach.
 */
export function failingStreaks(s: Session, min = 3): FailingStreak[] {
  const open = new Map<string, FailingStreak>();
  for (const r of checkRuns(s)) {
    if (r.ok === false) {
      const cur = open.get(r.name);
      if (cur) {
        cur.count++;
        cur.to = r.n;
      } else open.set(r.name, { name: r.name, count: 1, from: r.n, to: r.n });
    } else if (r.ok === true) {
      // a pass ends it: only a streak that is still going is news
      open.delete(r.name);
    }
  }
  const out = [...open.values()].filter((k) => k.count >= min);
  return out.sort((a, b) => a.from - b.from);
}

/** One line for `zerostel status`, or null when the session ran no checks. */
export function checksSummary(s: Session): string | null {
  const runs = checkRuns(s);
  if (!runs.length) return null;
  const latest = new Map<string, CheckRun>();
  for (const r of runs) latest.set(r.name, r);
  const all = [...latest.values()];
  const failed = all.filter((r) => r.ok === false).length;
  const passed = all.filter((r) => r.ok === true).length;
  const unknown = all.length - failed - passed;
  return [passed && `${passed} passed`, failed && `${failed} failed`, unknown && `${unknown} not reported`].filter(Boolean).join(', ');
}

/**
 * Run a check the user (or a script) asked for: the command as given, with
 * its output shown as usual and its tail kept. Resolves with the exit code
 * and that tail.
 */
export function runCommand(argv: string[], cwd: string): Promise<{ code: number; output: string; durationMs: number }> {
  const win = process.platform === 'win32';
  const quote = (a: string) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const started = Date.now();
  let tail = '';
  const keep = (d: Buffer) => {
    tail = (tail + d.toString('utf8')).slice(-4000);
  };
  return new Promise((resolve) => {
    const child = spawn(win ? argv.map(quote).join(' ') : argv[0]!, win ? [] : argv.slice(1), {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd,
      // cmd.exe would otherwise run a same-named program from the project folder first
      env: childEnv(),
      shell: win,
    });
    child.stdout!.on('data', (d: Buffer) => {
      process.stdout.write(d);
      keep(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      process.stderr.write(d);
      keep(d);
    });
    child.on('error', (e) => {
      keep(Buffer.from(`could not start ${argv[0]}: ${e.message}\n`));
      resolve({ code: 127, output: redact(tail.slice(-2000)), durationMs: Date.now() - started });
    });
    child.on('close', (code, sig) => resolve({ code: code ?? (sig ? 1 : 0), output: redact(tail.slice(-2000)), durationMs: Date.now() - started }));
  });
}

