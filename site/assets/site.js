// The site's only script: copy buttons, the flight recorder in the hero, and
// scrolling that plays the page like a recording. No tracking, no third
// parties, nothing read from the URL.

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

// The page as a recording. Scrolling down records: sections roll in, and a
// tape counter in the corner runs and names the channel you're on. Scrolling
// up rewinds it, and pressing it goes back to point zero. Without JavaScript,
// or with reduced motion, everything is simply there.
const zh = document.documentElement.lang.startsWith('zh');
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const main = document.querySelector('main');

if (main && !calm && 'IntersectionObserver' in window) {
  // things that roll in, each group staggered within its parent
  const pick = 'section:not(.hero) :is(.ch, h2, .sub, .agent, .bay-row, .card, .checks li, .table tbody tr, details, .term, .watch, .install, .ctas, .why-name, .small), .post > :not(header)';
  const seen = new Map();
  for (const el of main.querySelectorAll(pick)) {
    const n = seen.get(el.parentElement) ?? 0;
    seen.set(el.parentElement, n + 1);
    el.dataset.reveal = '';
    el.style.setProperty('--d', `${Math.min(n * 0.05, 0.3)}s`);
  }
  for (const [i, jack] of [...main.querySelectorAll('.jack')].entries()) jack.style.setProperty('--d', `${0.15 + i * 0.07}s`);
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    // start a little before an element comes into view, so fast scrolling never shows blank space
    { rootMargin: '0px 0px 8% 0px', threshold: 0 },
  );
  for (const el of main.querySelectorAll('[data-reveal], .bay')) io.observe(el);
  document.documentElement.classList.add('motion');
}

if (main) {
  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.setAttribute('aria-hidden', 'true');
  const tape = document.createElement('button');
  tape.type = 'button';
  tape.className = 'tape';
  tape.setAttribute('aria-label', zh ? '回到零點（頁面最上方）' : 'Back to point zero (top of the page)');
  tape.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="mode" aria-hidden="true"></span><span class="tc" aria-hidden="true"></span><span class="chn" aria-hidden="true"></span>';
  document.body.append(progress, tape);
  const [mode, tc, chn] = ['.mode', '.tc', '.chn'].map((s) => tape.querySelector(s));
  const marks = [...main.querySelectorAll('section .ch, .post h2')];
  const hero = document.querySelector('.hero');
  const two = (n) => String(n).padStart(2, '0');
  let last = scrollY;
  let rewindUntil = 0;
  let zeroUntil = 0;
  let toZero = false;
  let timer = 0;
  let queued = false;

  const draw = () => {
    queued = false;
    const y = Math.max(0, scrollY);
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.setProperty('--p', String(max > 0 ? Math.min(1, y / max) : 0));
    // one second of tape for every 30 pixels
    const s = Math.round(y / 30);
    tc.textContent = `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
    if (y < last - 2) rewindUntil = Math.max(rewindUntil, performance.now() + 700);
    last = y;
    const now = performance.now();
    const state = y < 8 ? 'zero' : now < rewindUntil ? 'rew' : 'rec';
    // arriving at the top after a rewind: say so for a moment before hiding
    if (state === 'zero' && (tape.dataset.mode === 'rew' || toZero)) {
      toZero = false;
      rewindUntil = 0;
      zeroUntil = now + 1600;
      setTimeout(draw, 1650);
    }
    tape.dataset.mode = state;
    mode.textContent = state === 'zero' ? (zh ? '零點' : 'Point zero') : state === 'rew' ? '◀◀ Rew' : 'Rec';
    let here = '';
    for (const m of marks) if (m.getBoundingClientRect().top < innerHeight * 0.45) here = m.textContent.replace(/\s+/g, ' ').trim();
    chn.textContent = here;
    const past = hero ? hero.getBoundingClientRect().bottom < 0 : y > 360;
    tape.classList.toggle('on', past || state === 'rew' || now < zeroUntil);
    // REW ends a moment after the scrolling up stops
    if (state === 'rew' && !timer) {
      timer = setTimeout(() => {
        timer = 0;
        draw();
      }, 750);
    }
  };
  const queue = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(draw);
    }
  };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue, { passive: true });
  tape.addEventListener('click', () => {
    // it shows REW all the way up, then POINT ZERO when it gets there
    toZero = true;
    rewindUntil = performance.now() + 4000;
    scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
    document.querySelector('.brand')?.focus({ preventScroll: true });
  });
  draw();
}
