import { FAVICON } from '../brand.js';
import { redact } from '../detect/secrets.js';
import type { Project } from '../store/project.js';
import { checkStatuses } from '../commands/checks.js';
import { verify } from '../store/audit.js';
import { regressions, stepDuration, summarize, type Session, type Step } from '../store/session.js';
import { changes, coverage, coverageNote, diffText } from '../store/shadow.js';
import { agentName, isDrastic, plural } from '../view/timeline.js';
import { fmtDate, fmtDuration, fmtTokens } from '../util/term.js';

export interface ReportOpts {
  /** a version meant for other people: no prompts, commands, output or diffs in the file at all */
  share?: boolean;
  prompts?: boolean;
  output?: boolean;
  diffs?: boolean;
  version?: string;
}

// Diffs of these files never go into a report, even redacted.
const PRIVATE_FILE =
  /(^|\/)(\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars)(\.backup)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service-account.*\.json)$/i;
const MAX_DIFF_LINES = 1500;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function renderDiff(text: string): string {
  const lines = text.split('\n');
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const body = shown
    .map((l) => {
      const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('@@') ? 'hk' : '';
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    })
    .join('\n');
  const more = lines.length > MAX_DIFF_LINES ? `\n<span class="hk">… ${lines.length - MAX_DIFF_LINES} more lines</span>` : '';
  return `<pre class="diff">${body}${more}</pre>`;
}

function stepDiff(p: Project, st: Step): string {
  if (!st.before || !st.after || st.before === st.after || !st.files.length) return '';
  const hidden = st.files.filter((f) => PRIVATE_FILE.test(f.path)).map((f) => f.path);
  const visible = st.files.filter((f) => !PRIVATE_FILE.test(f.path) && !f.binary).map((f) => f.path);
  let html = '';
  if (visible.length) {
    try {
      html += renderDiff(redact(diffText(p, st.before, st.after, visible)));
    } catch {
      html += '<p class="muted">Diff unavailable (snapshot missing).</p>';
    }
  }
  if (hidden.length) html += `<p class="muted">Diff hidden for private files: ${hidden.map(esc).join(', ')}</p>`;
  return html;
}

function fileList(st: Step): string {
  if (!st.files.length) return '';
  const rows = st.files
    .map((f) => {
      const stat = f.binary ? 'binary' : `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>`;
      return `<li><span class="st st-${f.status}">${f.status}</span> <code>${esc(f.path)}</code> <span class="muted">${stat}</span></li>`;
    })
    .join('');
  return `<ul class="files">${rows}</ul>`;
}

function badge(st: Step): string {
  if (!st.files.length) return '';
  const add = st.files.reduce((n, f) => n + f.added, 0);
  const del = st.files.reduce((n, f) => n + f.deleted, 0);
  const removed = st.files.filter((f) => f.status === 'D').length;
  return `<span class="badge">${st.files.length} file${st.files.length > 1 ? 's' : ''} <span class="add">+${add}</span> <span class="del">−${del}</span>${removed ? ` <span class="del">${removed} deleted</span>` : ''}</span>`;
}

// In a shared report the step name must not leak what the command or search
// was; file paths, tool names and counts are kept.
function shareLabel(st: Step): string {
  if (st.type === 'snapshot') return 'Snapshot';
  // its summary is the command: the shared version names the kind only
  if (st.type === 'check') return `Check (${st.check?.kind ?? 'check'})`;
  if (st.type === 'guard') return `${st.guard === 'deny' ? 'Blocked' : 'Asked first'}: ${st.tool ?? 'tool call'}`;
  if (st.type !== 'tool') return st.summary;
  switch (st.kind) {
    case 'shell':
      return 'Shell command';
    case 'web':
      return 'Web request';
    case 'agent':
      return 'Subagent';
    case 'read':
      return st.tool === 'Read' ? st.summary : 'Search';
    case 'mcp':
    case 'edit':
      return st.summary;
    default:
      return st.tool ?? 'Tool';
  }
}

type StepOpts = Required<Omit<ReportOpts, 'version'>> & { passedAt: Map<number, number> };

function stepHtml(p: Project, st: Step, o: StepOpts): string {
  const time = new Date(st.ts).toTimeString().slice(0, 8);
  const ms = stepDuration(st);
  const dur = ms === undefined ? '' : fmtDuration(ms);
  if (st.type === 'turn') {
    const tok = st.usage ? fmtTokens(st.usage.input + st.usage.output + st.usage.cacheRead + st.usage.cacheWrite) + ' tokens' : '';
    return `<div class="turn">turn done${tok ? ' · ' + tok : ''}</div>`;
  }
  if (st.type === 'prompt') {
    const text = o.prompts ? esc(redact(st.text ?? st.summary)) : '<span class="muted">(prompt hidden)</span>';
    return `<div class="step prompt" id="s${st.n}"><div class="meta"><span class="n">#${st.n}</span><span class="t">${time}</span></div><div class="ptext">${text}</div></div>`;
  }
  const kind = st.type === 'tool' ? st.kind ?? 'other' : st.type;
  const drastic = isDrastic(st);
  const body: string[] = [];
  if (!o.share && st.type === 'tool' && st.kind === 'shell' && st.input && typeof (st.input as { command?: unknown }).command === 'string') {
    body.push(`<pre class="cmd">${esc(redact((st.input as { command: string }).command))}</pre>`);
  }
  if (!o.share && (st.type === 'guard' || st.type === 'packages' || st.type === 'hooks') && st.text) body.push(`<p>${esc(redact(st.text))}</p>`);
  if (o.output && st.output) body.push(`<pre class="out">${esc(redact(st.output))}</pre>`);
  body.push(fileList(st));
  if (o.diffs) body.push(stepDiff(p, st));
  const content = body.filter(Boolean).join('');
  const label = o.share ? shareLabel(st) : st.summary;
  const summary = `<span class="n">#${st.n}</span><span class="t">${time}</span><span class="k k-${esc(kind)}">${esc(kind)}</span><span class="s">${st.subagent ? `<span class="muted"${o.share ? '' : ` title="${esc(st.subagent)}"`}>↳ subagent</span> ` : ''}${esc(redact(label))}</span>${st.ok === false ? `<span class="fail">failed${o.passedAt.has(st.n) ? ` · passed at #${o.passedAt.get(st.n)}` : ''}</span>` : ''}${drastic ? '<span class="warn">big deletion</span>' : ''}${st.guard === 'deny' ? '<span class="warn">blocked by policy</span>' : st.guard === 'ask' ? '<span class="fail">asked first</span>' : ''}<span class="right">${badge(st)}${dur ? `<span class="muted">${dur}</span>` : ''}</span>`;
  const cls = `step ${st.type}${drastic ? ' drastic' : ''}${!st.files.length && st.kind !== 'shell' && st.type === 'tool' ? ' quiet' : ''}`;
  if (!content) return `<div class="${cls}" id="s${st.n}"><div class="line">${summary}</div></div>`;
  return `<details class="${cls}" id="s${st.n}"${drastic ? ' open' : ''}><summary class="line">${summary}</summary><div class="body">${content}</div></details>`;
}

/** Files deleted at some point that are still gone at the end of the session. */
function stillDeleted(p: Project, s: Session): number | null {
  const first = s.steps.find((x) => x.before)?.before;
  const last = [...s.steps].reverse().find((x) => x.after ?? x.before);
  const end = last?.after ?? last?.before;
  if (!first || !end) return null;
  try {
    return changes(p, first, end).filter((f) => f.status === 'D').length;
  } catch {
    return null;
  }
}

function utcOffset(): string {
  const m = -new Date().getTimezoneOffset();
  const sign = m >= 0 ? '+' : '−';
  return `UTC${sign}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
}

export function renderReport(p: Project, s: Session, opts: ReportOpts = {}): string {
  const share = !!opts.share;
  const o = { share, prompts: !share && (opts.prompts ?? true), output: !share && (opts.output ?? true), diffs: !share && (opts.diffs ?? true) };
  const sum = summarize(s);
  const tokens = sum.usage.input + sum.usage.output + sum.usage.cacheRead + sum.usage.cacheWrite;
  const captured = s.steps.some((x) => x.type === 'turn' && x.usage);
  const title = o.prompts ? redact(sum.title) : `${agentName(s.agent)} session`;
  const gone = stillDeleted(p, s);
  const events = s.steps.filter((x) => x.type !== 'turn').length;
  const cards = [
    ['Elapsed', sum.durationMs ? fmtDuration(sum.durationMs) : 'not recorded', 'first to last recorded event'],
    ['Tool calls', `${sum.tools}`, `${plural(sum.prompts, 'prompt')} · ${plural(events, 'event')} in total`],
    ['Files changed', `${sum.filesChanged}`, `<span class="add">+${sum.linesAdded}</span> <span class="del">−${sum.linesDeleted}</span> lines, added up over all steps`],
    ['Deleted', `${sum.filesDeleted}`, gone === null ? 'at some point' : `at some point · ${gone} still gone at the end`],
    [
      'Tokens',
      tokens ? fmtTokens(tokens) : captured ? '0' : 'not captured',
      tokens
        ? `in ${fmtTokens(sum.usage.input)} · out ${fmtTokens(sum.usage.output)} · cache ${fmtTokens(sum.usage.cacheRead + sum.usage.cacheWrite)}`
        : s.agent === 'run'
          ? 'zerostel run sees files, not the model'
          : captured
            ? ''
            : 'the agent’s transcript was not readable',
    ],
  ];
  const cardHtml = cards.map(([k, v, sub]) => `<div class="card"><div class="ck">${k}</div><div class="cv">${v}</div>${sub ? `<div class="cs">${sub}</div>` : ''}</div>`).join('');
  const drastic = s.steps.filter(isDrastic);
  const alert = drastic.length
    ? `<div class="alert">Biggest deletions: ${drastic.map((d) => `<a href="#s${d.n}">#${d.n}</a>`).join(', ')}.${share ? '' : ` To preview undoing it, run this inside the original project: <code>zerostel rewind ${drastic[0]!.n} --session ${esc(s.id)} --dry-run</code>`}</div>`
    : '';
  const policy = share
    ? 'Shared version: prompts, commands, command output and diffs are not in this file. Step names, tool names, file paths and counts are.'
    : 'Full local report: contains prompts, commands, command output and diffs. Known secret formats are masked and .env-style files are left out, but masking is best effort: it can’t recognise every password or private detail. Use <code>zerostel report --share</code> for a version to send to others.';
  // what this report can't show or a rewind can't restore, in one place
  const gaps: string[] = [];
  const unsnapped = s.steps.filter((x) => x.type === 'tool' && x.kind !== 'read' && x.kind !== 'web' && !x.before).length;
  if (unsnapped) gaps.push(`${plural(unsnapped, 'step')} that could change files had no snapshot (home folder, paused or skipped)`);
  if (!captured && s.agent !== 'run') gaps.push('token usage was not captured');
  try {
    const note = coverageNote(coverage(p));
    if (note) gaps.push(note);
  } catch {
    // snapshot store gone; nothing to add
  }
  // the chain check: does this log still match what Zerostel wrote?
  let audit = '';
  try {
    const v = verify(s.ref.file);
    if (!v.ok) gaps.push(`the session log doesn't verify (${v.problems[0]}); it may have been edited after it was recorded`);
    else if (v.head) audit = ` · audit chain intact, ${v.events} events, head <code>${v.head.slice(0, 12)}</code> (<code>zerostel verify</code>)`;
    else if (v.events) gaps.push("this session was recorded before Zerostel chained its logs, so the log can't be verified");
  } catch {
    // no key or no file; nothing to say
  }
  const gapsHtml = gaps.length ? `<div class="gaps"><b>Gaps in this record</b><ul>${gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : '';
  // same command, passing then failing: point at what changed in between
  const regs = regressions(s);
  const link = (st: Step) => `<a href="#s${st.n}">#${st.n}</a>`;
  const regsHtml = regs.length
    ? `<div class="regress"><b>Passed earlier, failed later</b><ul>${regs
        .map((r) => {
          const what = share ? 'The command' : `<code>${esc(redact(r.command))}</code>`;
          const between = r.changed.length ? `files changed in between at ${r.changed.slice(0, 12).map(link).join(', ')}${r.changed.length > 12 ? ` and ${r.changed.length - 12} more` : ''}` : 'no recorded file changes in between';
          return `<li>${what} at ${link(r.failed)} failed; the same command passed at ${link(r.passed)}. ${between}.</li>`;
        })
        .join('')}</ul></div>`
    : '';
  // tests and builds, and whether the code changed after they ran (up to the end of the session)
  const last = [...s.steps].reverse().find((x) => x.after ?? x.before);
  const checks = checkStatuses(p, s, last?.after ?? last?.before ?? null);
  const checksHtml = checks.length
    ? `<div class="regress"><b>Checks</b>, as the session left the code<ul>${checks
        .map((st) => {
          const what = share ? esc(st.kind) : `<code>${esc(redact(st.name))}</code>`;
          const result = st.latest.ok === true ? 'passed' : st.latest.ok === false ? '<span class="fail">failed</span>' : 'ran, result not reported by the agent';
          const fresh = st.freshness.state === 'current' ? '; nothing changed after it' : st.freshness.state === 'stale' ? `; <span class="warn">out of date</span>: ${plural(st.freshness.files.length, 'file')} changed after it ran` : '';
          return `<li>${what}: ${result} at <a href="#s${st.latest.n}">#${st.latest.n}</a>${fresh}.</li>`;
        })
        .join('')}</ul></div>`
    : '';
  const passedAt = new Map(regs.map((r) => [r.failed.n, r.passed.n]));
  const guarded = s.steps.filter((x) => x.type === 'guard');
  const guardHtml = guarded.length
    ? `<div class="regress"><b>Guardrails</b> stopped ${plural(guarded.filter((x) => x.guard === 'deny').length, 'tool call')} and asked about ${guarded.filter((x) => x.guard === 'ask').length}: ${guarded.slice(0, 12).map(link).join(', ')}${guarded.length > 12 ? ' …' : ''}.</div>`
    : '';
  const steps = s.steps.map((st) => stepHtml(p, st, { ...o, passedAt })).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Zerostel report</title>
${FAVICON}
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5e7;--card:#fff;--add:#1a7f37;--del:#cf222e;--accent:#5b5bd6;--warn:#b35900;--code:#f3f3f2}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--muted:#9a9aa1;--line:#2a2a2e;--card:#1c1c1f;--add:#3fb950;--del:#f85149;--accent:#9d9dff;--warn:#f0a040;--code:#202024}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:22px;margin:4px 0 6px;overflow-wrap:anywhere}.sub{color:var(--muted);font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:22px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.ck{color:var(--muted);font-size:12px}.cv{font-size:24px;font-weight:600}.cs{font-size:12px;color:var(--muted)}
.gaps{font-size:13px;border:1px solid var(--line);border-radius:10px;padding:8px 14px;margin:0 0 18px}.gaps ul{margin:4px 0 0;padding-left:18px}
.policy{font-size:13px;color:var(--muted);border-left:3px solid var(--line);padding:2px 10px;margin:0 0 18px}
.regress{border:1px solid var(--warn);border-radius:10px;padding:8px 14px;margin-bottom:18px;font-size:14px}.regress ul{margin:4px 0 0;padding-left:18px}.regress a{color:inherit}
.alert{border:1px solid var(--del);color:var(--del);border-radius:10px;padding:10px 14px;margin-bottom:18px;font-size:14px}.alert a{color:inherit}
.step{border-bottom:1px solid var(--line)}.line{display:flex;gap:10px;align-items:baseline;padding:8px 4px;cursor:default;list-style:none;flex-wrap:wrap}
.line::before{content:'';flex:none;width:10px}details>summary.line{cursor:pointer}details>summary::-webkit-details-marker{display:none}details>summary.line::before{content:'▸';color:var(--muted);transition:transform .15s}details[open]>summary.line::before{transform:rotate(90deg)}summary.line:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.n{color:var(--muted);font-variant-numeric:tabular-nums;min-width:34px}.t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px}
.k{font-size:11px;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--muted)}
.s{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;overflow-wrap:anywhere;flex:1;min-width:200px}
.right{margin-left:auto;display:flex;gap:10px;font-size:13px}.quiet .s{color:var(--muted)}
.prompt{padding:14px 4px 6px}.prompt .meta{display:flex;gap:10px}.ptext{white-space:pre-wrap;font-weight:600;margin:4px 0 4px 44px;overflow-wrap:anywhere}
.turn{color:var(--muted);font-size:12px;padding:4px 0 10px 48px}
.drastic{border-left:3px solid var(--del);padding-left:6px}.warn,.fail{font-size:11px;color:var(--bg);background:var(--del);border-radius:4px;padding:0 6px}.fail{background:var(--warn)}
.body{padding:0 4px 12px 48px}pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;margin:6px 0;max-height:520px}
.cmd{border-left:3px solid var(--accent)}.out{color:var(--muted)}
.diff .a{color:var(--add)}.diff .d{color:var(--del)}.diff .hk{color:var(--accent)}.diff .h{color:var(--muted);font-weight:600}
.files{list-style:none;padding:0;margin:6px 0;font-size:13px}.files li{padding:1px 0}.st{display:inline-block;width:16px;font-weight:700}.st-A{color:var(--add)}.st-D{color:var(--del)}.st-M,.st-T{color:var(--warn)}
.add{color:var(--add)}.del{color:var(--del)}.muted{color:var(--muted)}code{font-family:ui-monospace,Consolas,monospace;font-size:13px}
.badge{display:inline-flex;gap:6px}footer{margin-top:40px;color:var(--muted);font-size:12px;text-align:center}
@media (max-width:600px){.body,.ptext{margin-left:0;padding-left:0}.turn{padding-left:0}.right{margin-left:0}.cards{grid-template-columns:repeat(3,1fr);gap:6px;margin:14px 0}.card{padding:8px 10px}.cv{font-size:18px}.cs{font-size:11px}}
</style>
</head>
<body>
<main>
<div class="sub">${esc(agentName(s.agent))} session${s.startedAt ? ' · ' + esc(fmtDate(s.startedAt)) + ' ' + utcOffset() : ''}${!share && s.model ? ' · ' + esc(s.model) : ''}${share ? '' : ' · session ' + esc(s.id)}</div>
<h1>${esc(title)}</h1>
<div class="cards">${cardHtml}</div>
<p class="policy">${policy}</p>
${gapsHtml}
${alert}
${regsHtml}
${checksHtml}
${guardHtml}
<section>
${steps}
</section>
<footer>Recorded with Zerostel${opts.version ? ' ' + esc(opts.version) : ''}${audit} · <code>npx zerostel</code></footer>
</main>
</body>
</html>
`;
}
