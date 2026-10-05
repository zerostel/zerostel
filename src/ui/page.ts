// The single page served by `zerostel ui`. Data only ever reaches the DOM
// through textContent, never innerHTML, so file names and command output
// can't inject markup. The token arrives in the URL fragment (never sent to
// a server or a Referer) and moves into memory on load.

import { FAVICON } from '../brand.js';

export function page(nonce: string, version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Zerostel</title>
${FAVICON}
<style>
:root{--bg:#f7f7f6;--fg:#1d1d1f;--muted:#6b6b72;--line:#e3e3e6;--panel:#fff;--add:#1a7f37;--del:#cf222e;--accent:#4b4bc8;--warn:#9a5b00;--code:#f1f1ef;--sel:#ececfb}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececee;--muted:#9a9aa3;--line:#2a2a2f;--panel:#1a1a1d;--add:#3fb950;--del:#f85149;--accent:#a5a5ff;--warn:#e3a54a;--code:#1f1f23;--sel:#24243a}}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}#project{max-width:100%;min-width:0;text-overflow:ellipsis}
header b{font-size:15px}select,button{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:5px 9px}
button{cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{background:var(--del);border-color:var(--del);color:#fff}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
main{flex:1;display:grid;grid-template-columns:260px 1fr 1fr;min-height:0}
@media (max-width:900px){main{grid-template-columns:1fr}#detail{border-top:1px solid var(--line)}}
#sessions,#timeline,#detail{overflow:auto;min-height:0}
#sessions{border-right:1px solid var(--line)}#timeline{border-right:1px solid var(--line)}
.item{padding:9px 14px;border-bottom:1px solid var(--line);cursor:pointer}.item:hover{background:var(--sel)}.item.on{background:var(--sel)}
.muted{color:var(--muted)}.small{font-size:12px}.add{color:var(--add)}.del{color:var(--del)}.warn{color:var(--warn)}
.step{display:grid;grid-template-columns:44px 64px 1fr auto;gap:8px;align-items:baseline}
.step .s{font-family:ui-monospace,Consolas,monospace;font-size:13px;overflow-wrap:anywhere}.step.prompt .s{font-family:inherit;font-weight:600}
.turn{padding:3px 14px 3px 70px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)}
#detail{padding:14px 18px}h2{font-size:15px;margin:0 0 4px;overflow-wrap:anywhere}
pre{background:var(--code);padding:10px 12px;border-radius:8px;overflow:auto;font:12px/1.45 ui-monospace,Consolas,monospace;max-height:420px;white-space:pre}
.files{list-style:none;padding:0;margin:8px 0}.files li{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;padding:1px 0;overflow-wrap:anywhere}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.plan{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0;background:var(--panel)}
.empty{padding:24px;color:var(--muted)}.err{color:var(--del);padding:8px 16px}
</style>
</head>
<body>
<header><b>Zerostel</b><span class="muted small">${version}</span><select id="project" aria-label="Project"></select><button id="undo">Undo last turn…</button><span id="status" class="muted small" role="status"></span></header>
<div id="error" class="err" role="alert"></div>
<main><nav id="sessions" aria-label="Sessions"></nav><section id="timeline" aria-label="Timeline"></section><section id="detail" aria-label="Step"><div class="empty">Pick a step to see what it did.</div></section></main>
<script nonce="${nonce}">
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || sessionStorage.getItem('zerostel-token') || '';
  if (location.hash) history.replaceState(null, '', location.pathname);
  try { sessionStorage.setItem('zerostel-token', token); } catch {}
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = String(text); return e; };
  const state = { project: null, session: null, data: null, step: null };

  async function api(path, body) {
    const opts = { headers: { 'X-Zerostel-Token': token } };
    if (body) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  function fail(e) { $('error').textContent = e.message || String(e); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  const time = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toTimeString().slice(0, 8); };
  const qs = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  function badge(files) {
    const span = el('span', 'small');
    if (!files || !files.length) return span;
    const add = files.reduce((n, f) => n + f.added, 0), del = files.reduce((n, f) => n + f.deleted, 0), gone = files.filter((f) => f.status === 'D').length;
    span.append(el('span', '', files.length + (files.length > 1 ? ' files ' : ' file ')), el('span', 'add', '+' + add + ' '), el('span', 'del', '−' + del));
    if (gone) span.append(el('span', 'del', ' · ' + gone + ' deleted'));
    return span;
  }

  async function loadProjects() {
    const list = await api('/api/projects');
    const sel = $('project'); clear(sel);
    for (const p of list) { const o = el('option', '', p.root + ' (' + p.sessions + ')'); o.value = p.id; sel.append(o); }
    if (!list.length) { $('sessions').append(el('div', 'empty', 'Nothing recorded yet.')); return; }
    state.project = list[0].id; sel.value = state.project; await loadSessions();
  }
  async function loadSessions() {
    const list = await api('/api/sessions?' + qs({ project: state.project }));
    const nav = $('sessions'); clear(nav);
    for (const s of list) {
      const it = el('div', 'item'); it.tabIndex = 0;
      it.append(el('div', '', s.title), el('div', 'muted small', s.agent + ' · ' + s.steps + ' steps · ' + s.filesChanged + ' files'));
      it.onclick = () => openSession(s.id, it); it.onkeydown = (e) => { if (e.key === 'Enter') openSession(s.id, it); };
      nav.append(it);
    }
    if (list.length) await openSession(list[0].id, nav.firstChild);
  }
  async function openSession(id, item) {
    for (const n of $('sessions').children) n.classList.toggle('on', n === item);
    state.session = id; state.data = await api('/api/session?' + qs({ project: state.project, session: id }));
    renderTimeline(); showEmpty();
  }
  function renderTimeline() {
    const tl = $('timeline'); clear(tl);
    for (const st of state.data.steps) {
      if (st.type === 'turn') { tl.append(el('div', 'turn', 'turn done')); continue; }
      const it = el('div', 'item step ' + st.type); it.tabIndex = 0;
      const icon = { prompt: '❯ ', outside: '✎ ', change: '● ', snapshot: '◆ ', restore: '↺ ', home: '⌂ ', packages: '◇ ', userenv: '≡ ', hooks: '⚑ ', check: st.ok === true ? '✓ ' : st.ok === false ? '✗ ' : '? ', guard: st.guard === 'deny' ? '⊘ ' : '? ' }[st.type] || (st.ok === false ? '✗ ' : '');
      it.append(el('span', 'muted', '#' + st.n), el('span', 'muted small', time(st.ts)), el('span', 's', icon + st.summary), badge(st.files));
      // a test or build the agent ran, and steps a rewind cannot go back to
      if (st.type === 'tool' && st.check) it.append(el('span', st.check.ok === true ? 'add small' : st.check.ok === false ? 'del small' : 'muted small', st.check.ok === true ? st.check.kind + ' passed' : st.check.ok === false ? st.check.kind + ' failed' : st.check.kind + ': not reported'));
      if (st.nosnap) it.append(el('span', 'warn small', 'no snapshot'));
      it.onclick = () => showStep(st, it); it.onkeydown = (e) => { if (e.key === 'Enter') showStep(st, it); };
      tl.append(it);
    }
  }
  function showEmpty() { const d = $('detail'); clear(d); d.append(el('div', 'empty', 'Pick a step to see what it did.')); }
  function passedNote(st) {
    const r = (state.data.regressions || []).find((x) => x.failed === st.n);
    if (!r) return '';
    return ' · the same command passed at #' + r.passed + (r.changed.length ? '; files changed in between at #' + r.changed.join(', #') : '');
  }
  function showStep(st, item) {
    for (const n of $('timeline').children) n.classList.toggle('on', n === item);
    state.step = st;
    const d = $('detail'); clear(d);
    d.append(el('h2', '', '#' + st.n + '  ' + st.summary), el('div', 'muted small', st.type + (st.tool ? ' · ' + st.tool : '') + ' · ' + new Date(st.ts).toLocaleString() + (st.ok === false ? ' · failed' + passedNote(st) : '')));
    if (st.nosnap) d.append(el('div', 'warn small', 'No snapshot from just before this step (' + st.nosnap + '): a rewind cannot go back to this point.'));
    if (st.text) d.append(el('pre', '', st.text));
    if (st.input && typeof st.input.command === 'string') d.append(el('pre', '', st.input.command));
    if (st.output) d.append(el('pre', 'muted', st.output));
    if (st.files && st.files.length) {
      const ul = el('ul', 'files');
      for (const f of st.files) { const li = el('li'); li.append(el('span', f.status === 'A' ? 'add' : f.status === 'D' ? 'del' : 'warn', f.status + ' '), el('span', '', f.path)); ul.append(li); }
      d.append(ul);
    }
    const row = el('div', 'row');
    if (st.files && st.files.length) { const b = el('button', '', 'Show diff'); b.onclick = () => showDiff(st); row.append(b); }
    const before = el('button', '', 'Rewind to before #' + st.n + '…'); before.onclick = () => preview({ step: st.n, after: false });
    const after = el('button', '', 'Rewind to after #' + st.n + '…'); after.onclick = () => preview({ step: st.n, after: true });
    row.append(before, after); d.append(row);
  }
  async function showDiff(st) {
    try {
      const { diff } = await api('/api/diff?' + qs({ project: state.project, session: state.session, step: st.n }));
      const pre = el('pre');
      for (const line of diff.split('\\n')) pre.append(el('span', line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'muted' : '', line + '\\n'));
      $('detail').append(pre);
    } catch (e) { fail(e); }
  }
  async function preview(target, undo) {
    try {
      const body = { project: state.project, session: state.session, dryRun: true, ...target };
      const plan = await api(undo ? '/api/undo' : '/api/rewind', body);
      const box = el('div', 'plan');
      if (plan.nothing) { box.append(el('div', 'muted', 'Nothing to undo in this session.')); $('detail').append(box); return; }
      const total = plan.created.length + plan.modified.length + plan.deleted.length;
      box.append(el('b', '', plan.label));
      if (!total) box.append(el('div', 'muted', 'The project already matches that point.'));
      for (const [label, list, cls] of [['restore', plan.modified, 'warn'], ['bring back', plan.created, 'add'], ['remove', plan.deleted, 'del']]) {
        if (!list.length) continue;
        box.append(el('div', cls, label + ' · ' + list.length + (list.length > 1 ? ' files' : ' file')));
        const ul = el('ul', 'files'); for (const f of list.slice(0, 50)) ul.append(el('li', '', f)); if (list.length > 50) ul.append(el('li', 'muted', '… ' + (list.length - 50) + ' more')); box.append(ul);
      }
      if (total) {
        const go = el('button', 'danger', 'Rewind ' + total + (total > 1 ? ' files' : ' file'));
        go.onclick = async () => {
          go.disabled = true;
          try {
            const r = await api(undo ? '/api/undo' : '/api/rewind', { ...body, dryRun: false });
            $('status').textContent = r.failed.length ? r.failed.length + ' file(s) not restored' : 'Done. Undo puts it back.';
            await openSession(state.session, [...$('sessions').children].find((n) => n.classList.contains('on')));
          } catch (e) { fail(e); go.disabled = false; }
        };
        box.append(el('div', 'row'), go);
      }
      const d = undo ? $('detail') : $('detail'); if (undo) clear(d); d.append(box);
    } catch (e) { fail(e); }
  }
  $('project').onchange = (e) => { state.project = e.target.value; loadSessions().catch(fail); };
  $('undo').onclick = () => { if (state.session) preview({}, true); };
  if (!token) fail(new Error('Open the address zerostel ui printed; it carries the access token.'));
  else loadProjects().catch(fail);
})();
</script>
</body>
</html>
`;
}
