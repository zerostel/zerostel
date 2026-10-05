import type { Session, Step } from '../store/session.js';
import { shortId, stepDuration, summarize } from '../store/session.js';
import type { FileChange } from '../store/shadow.js';
import { ago, c, fmtClock, fmtDate, fmtDuration, fmtTokens, truncate } from '../util/term.js';

export const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  copilot: 'Copilot CLI',
  opencode: 'opencode',
  deepseek: 'DeepSeek Harness',
  run: 'zerostel run',
  manual: 'Manual',
};

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function agentName(a: string): string {
  return AGENT_NAMES[a] ?? a;
}

export function fileBadge(files: FileChange[]): string {
  if (!files.length) return '';
  const add = files.reduce((n, f) => n + f.added, 0);
  const del = files.reduce((n, f) => n + f.deleted, 0);
  const removed = files.filter((f) => f.status === 'D').length;
  const parts: string[] = [];
  if (files.length > 1) parts.push(`${files.length} files`);
  if (add || del) parts.push(c.green(`+${add}`) + ' ' + c.red(`−${del}`));
  if (removed) parts.push(c.red(`${removed} deleted`));
  if (!parts.length) parts.push(files.length === 1 ? '1 file' : `${files.length} files`);
  return parts.join('  ');
}

/** A step that removed a lot is worth flagging: it's usually where things broke. */
export function isDrastic(st: Step): boolean {
  if (st.type === 'restore') return false;
  const removed = st.files.filter((f) => f.status === 'D').length;
  const del = st.files.reduce((n, f) => n + f.deleted, 0);
  const add = st.files.reduce((n, f) => n + f.added, 0);
  return removed >= 3 || (del >= 200 && del > add * 3);
}

function icon(st: Step): string {
  switch (st.type) {
    case 'prompt':
      return c.cyan('❯');
    case 'outside':
      return c.yellow('✎');
    case 'change':
      return c.blue('●');
    case 'snapshot':
      return c.magenta('◆');
    case 'restore':
      return c.magenta('↺');
    case 'home':
      return c.cyan('⌂');
    case 'packages':
      return c.yellow('◇');
    case 'userenv':
      return c.yellow('≡');
    case 'guard':
      return st.guard === 'deny' ? c.red('⊘') : c.yellow('?');
    case 'hooks':
      return c.red('⚑');
    default:
      return st.ok === false ? c.red('✗') : ' ';
  }
}

export function renderHeader(s: Session): string[] {
  const sum = summarize(s);
  const lines: string[] = [];
  lines.push(`${c.bold(agentName(s.agent))}  ${c.dim('·')}  ${sum.title}`);
  const bits = [
    s.startedAt ? `started ${fmtDate(s.startedAt)}` : '',
    sum.durationMs ? fmtDuration(sum.durationMs) : '',
    plural(sum.steps, 'step'),
    sum.filesChanged ? `${plural(sum.filesChanged, 'file')} changed` : 'no file changes',
    sum.usage.input + sum.usage.output ? `${fmtTokens(sum.usage.input + sum.usage.output + sum.usage.cacheRead + sum.usage.cacheWrite)} tokens` : '',
    `session ${shortId(s.id)}`,
  ].filter(Boolean);
  lines.push(c.dim(bits.join(' · ')));
  return lines;
}

export function renderTimeline(s: Session, opts: { onlyChanges?: boolean; width?: number; last?: number } = {}): string[] {
  const width = Math.max(60, opts.width ?? process.stdout.columns ?? 100);
  const lines = [...renderHeader(s), ''];
  const numW = String(s.steps.length).length + 1;
  let steps = s.steps;
  if (opts.last && opts.last > 0) {
    const numbered = steps.filter((x) => x.n);
    const from = numbered[Math.max(0, numbered.length - opts.last)];
    if (from && from.n > 1) {
      steps = steps.slice(steps.indexOf(from));
      lines.push(c.dim(`  … ${from.n - 1} earlier steps (zerostel log without -n shows all)`));
    }
  }
  for (const st of steps) {
    if (st.type === 'turn') {
      const bits = ['turn done'];
      if (st.usage) bits.push(`${fmtTokens(st.usage.input + st.usage.output + st.usage.cacheRead + st.usage.cacheWrite)} tokens`);
      lines.push(c.dim(`${' '.repeat(numW + 12)}└ ${bits.join(' · ')}`));
      continue;
    }
    const quiet = st.type === 'tool' && !st.files.length && st.kind !== 'shell';
    if (opts.onlyChanges && !st.files.length && st.type !== 'prompt' && st.type !== 'restore') continue;
    const num = `#${st.n}`.padStart(numW + 1);
    const ms = stepDuration(st);
    const dur = ms === undefined ? '' : fmtDuration(ms);
    // fixed columns: number, clock, icon, summary, duration, file changes
    if (st.type === 'prompt') {
      lines.push(`${c.dim(num)}  ${c.dim(fmtClock(st.ts))}  ${icon(st)} ${c.bold(truncate(st.summary, width - numW - 15))}`);
      continue;
    }
    const sumW = Math.max(24, width - (numW + 1) - 14 - 7 - 30);
    const label = st.subagent ? `↳ ${st.summary}` : st.summary;
    const plain = truncate(label, sumW).padEnd(sumW);
    let text = plain;
    if (st.type === 'outside') text = c.yellow(plain);
    else if (quiet) text = c.dim(plain);
    const flag = isDrastic(st) ? c.red('  ⚠') : st.type === 'hooks' ? c.red('  recorder changed') : st.type === 'guard' ? (st.guard === 'deny' ? c.red('  blocked by policy') : c.yellow('  asked first')) : '';
    lines.push(`${c.dim(num)}  ${c.dim(fmtClock(st.ts))}  ${icon(st)} ${text} ${c.dim(dur.padStart(6))}  ${fileBadge(st.files)}${flag}`.trimEnd());
  }
  return lines;
}

export function renderSessionRow(s: Session): string {
  const sum = summarize(s);
  const tokens = sum.usage.input + sum.usage.output + sum.usage.cacheRead + sum.usage.cacheWrite;
  return [
    c.bold(shortId(s.id).padEnd(9)),
    agentName(s.agent).padEnd(13),
    (s.endedAt ? ago(s.endedAt) : '').padEnd(10),
    String(sum.steps).padStart(5),
    String(sum.filesChanged).padStart(6),
    (tokens ? fmtTokens(tokens) : '-').padStart(7),
    '  ' + truncate(sum.title, 50),
  ].join(' ');
}
