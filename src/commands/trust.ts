import fs from 'node:fs';
import { evaluate, loadPolicy, policyPath, STARTER, type Decision } from '../guard/policy.js';
import { verify, type Verification } from '../store/audit.js';
import type { Project } from '../store/project.js';
import { findSession, listSessions, shortId, type SessionRef } from '../store/session.js';
import { ensurePrivateDir, tilde, type Ctx } from '../util/paths.js';
import { c, err, out } from '../util/term.js';

type Flags = { session?: string; json?: boolean; all?: boolean; force?: boolean };

function fail(msg: string): never {
  err(c.red('✗ ') + msg);
  process.exit(1);
}

export function verifyCmd(p: Project, flags: Flags): void {
  const refs: SessionRef[] = flags.all ? listSessions(p) : [findSession(p, flags.session)].filter((r): r is SessionRef => !!r);
  if (!refs.length) fail(flags.session ? `no session matching "${flags.session}"` : `nothing recorded for ${p.root} yet`);
  const results = refs.map((ref) => ({ ref, v: verify(ref.file) }));
  if (flags.json) {
    out(JSON.stringify(results.map(({ ref, v }) => ({ agent: ref.agent, session: ref.id, ...v })), null, 2));
  } else {
    for (const { ref, v } of results) out(verifyLine(ref, v));
  }
  if (results.some(({ v }) => !v.ok)) process.exitCode = 1;
}

function verifyLine(ref: SessionRef, v: Verification): string {
  const name = `${ref.agent} ${shortId(ref.id)}`;
  const older = v.unchained ? c.dim(`\n    ${v.unchained} earlier event${v.unchained > 1 ? 's were' : ' was'} recorded before chaining; the chain covers them as one block, so changing any of them still shows`) : '';
  const notes = v.notes.map((m) => c.dim('\n    ' + m)).join('');
  if (v.status === 'intact') return `${c.green('✓')} ${name}  ${v.events} events · chain intact · head ${c.bold(v.head!.slice(0, 12))}${older}${notes}`;
  if (v.status === 'unchecked') return `${c.yellow('·')} ${name}  ${v.events} events · can't be checked: recorded before Zerostel chained its logs${notes}`;
  return `${c.red('✗')} ${name}  ${v.events} events\n${v.problems.map((m) => c.red('    ' + m)).join('\n')}${older}`;
}

/** `zerostel policy [init|test <command or path>]` */
export function policyCmd(ctx: Ctx, root: string, args: string[], flags: Flags): void {
  const file = policyPath(ctx);
  const sub = args[0];
  if (sub === 'init') {
    if (fs.existsSync(file) && !flags.force) fail(`${tilde(file, ctx.home)} already exists; edit it, or use --force to start over`);
    ensurePrivateDir(ctx.dataDir, ctx.platform);
    // the schema gives editors completion and checks for every field
    fs.writeFileSync(file, JSON.stringify({ $schema: 'https://zerostel.com/schema/policy.json', ...STARTER }, null, 2) + '\n', { mode: 0o600 });
    out(c.green('✓ ') + `Wrote ${tilde(file, ctx.home)} with starter rules. Edit it to fit; agents pick it up on their next tool call.`);
    return;
  }
  const { policy, problem } = loadPolicy(ctx);
  if (sub === 'test') {
    const text = args.slice(1).join(' ');
    if (!text) fail('usage: zerostel policy test <command or path>');
    if (problem && !policy) fail(problem);
    const d = evaluate(policy, { tool: 'Bash', paths: [], command: text, writes: true, root, cwd: ctx.cwd, home: ctx.home, platform: ctx.platform });
    out(decisionLine(d));
    return;
  }
  if (problem) {
    out(c.red('✗ ') + problem);
    out(c.dim(policy ? '  Fix the file; until then the last working copy is used.' : '  Guardrails are off until this is fixed. Tool calls are still recorded.'));
    process.exitCode = 1;
    if (!policy) return;
  }
  if (!policy) {
    out(c.dim(`No guardrails: ${tilde(file, ctx.home)} doesn't exist.`));
    out(c.dim(`  ${c.bold('zerostel policy init')} writes a starter set: no credentials, ask before force-pushing or editing .env.`));
    return;
  }
  if (flags.json) return out(JSON.stringify(policy, null, 2));
  out(`${c.bold('Guardrails')} ${c.dim('· ' + tilde(file, ctx.home))}`);
  policy.rules.forEach((r, i) => {
    const what = [r.paths && `paths ${r.paths.join(', ')}${r.access === 'write' ? ' (writes)' : ''}`, r.commands && `commands ${r.commands.join(', ')}`, r.tools && `tools ${r.tools.join(', ')}`].filter(Boolean).join('; ');
    out(`  ${i + 1}. ${r.action === 'deny' ? c.red('deny') : c.yellow('ask ')}  ${what}${r.reason ? c.dim('  — ' + r.reason) : ''}`);
  });
  out(c.dim(`\n  Try one: zerostel policy test "git push --force"`));
}

function decisionLine(d: Decision | null): string {
  if (!d) return c.green('✓ allowed') + c.dim(' (no rule matches)');
  if (d.action === 'deny') return c.red(`✗ blocked by rule ${d.rule}: `) + d.reason;
  return c.yellow(`? asks first (rule ${d.rule}): `) + d.reason + c.dim('  (agents that can\'t ask block it instead)');
}

/** One line for status and doctor. */
export function guardrailsSummary(ctx: Ctx): { level: 'ok' | 'info' | 'warn'; text: string } {
  const { policy, problem } = loadPolicy(ctx);
  if (problem) return { level: 'warn', text: policy ? problem : `off: ${problem}` };
  if (!policy) return { level: 'info', text: 'off (zerostel policy init to add some)' };
  return { level: 'ok', text: `on · ${policy.rules.length} rule${policy.rules.length === 1 ? '' : 's'}` };
}
