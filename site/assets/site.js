// The site's only script: copy buttons and the flight recorder in the hero.
// No tracking, no third parties, nothing read from the URL.

// one polite live region for every copy button, so a screen reader hears the result
const live = document.createElement('p');
live.className = 'sr-only';
live.setAttribute('aria-live', 'polite');
document.body.append(live);

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = btn.getAttribute('data-copy') || '';
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = btn.getAttribute('data-done-label') || 'Copied';
      btn.setAttribute('data-done', '');
      live.textContent = `${btn.textContent}: ${text}`;
      setTimeout(() => {
        btn.textContent = label;
        btn.removeAttribute('data-done');
      }, 1600);
    } catch {
      // no clipboard access here: select the command so it can be copied by hand
      const code = btn.parentElement?.querySelector('code');
      if (code) getSelection()?.selectAllChildren(code);
      live.textContent = document.documentElement.lang.startsWith('zh') ? '無法自動複製，指令已選取' : "Couldn't copy; the command is selected";
    }
  });
}

// Flight recorder: the slider says "the project as of before step n" (7 = now).
// Step 4 edited src/app.ts, step 5 deleted src/legacy.
const scrub = document.getElementById('scrub');
if (scrub) {
  const rec = scrub.closest('.rec');
  const out = document.getElementById('scrub-out');
  const status = document.getElementById('rec-status');
  const text = {};
  for (const el of document.getElementById('rec-text').content.querySelectorAll('[data-k]')) text[el.dataset.k] = el.textContent;
  const label = (el, state) => {
    const em = el.querySelector('[data-state]');
    el.dataset.state = state;
    em.textContent = state ? text[state] : '';
  };
  // steps that are undone say so to screen readers too, not only by fading
  for (const li of rec.querySelectorAll('.rec-steps li')) {
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.dataset.undone = '';
    li.append(sr);
  }
  const render = () => {
    const v = Number(scrub.value);
    for (const li of rec.querySelectorAll('.rec-steps li')) {
      const undone = Number(li.dataset.step) >= v;
      li.classList.toggle('undone', undone);
      li.querySelector('[data-undone]').textContent = undone ? ` (${text.undone || 'undone'})` : '';
    }
    for (const el of rec.querySelectorAll('[data-file="app"]')) label(el, v >= 5 ? 'modified' : 'back');
    for (const el of rec.querySelectorAll('[data-file="legacy"]')) label(el, v >= 6 ? 'deleted' : 'back');
    const where = v === 7 ? scrub.dataset.now : scrub.dataset.before.replace('#', String(v));
    out.textContent = where;
    scrub.setAttribute('aria-valuetext', v === 1 ? `${text.zeroName || 'Point zero'}, ${where}` : where);
    status.textContent = v === 7 ? text.now : v === 1 ? text.zero : text.past;
    rec.classList.toggle('rewound', v < 7);
  };
  scrub.addEventListener('input', render);
  rec.querySelector('[data-zero]').addEventListener('click', () => {
    scrub.value = '1';
    render();
    scrub.focus();
  });
  render();
}
