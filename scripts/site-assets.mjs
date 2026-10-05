// Stamps the website's links to its stylesheet, script and demo video with a hash of their
// content (/assets/site.css?v=...), so a browser never pairs a new page with
// an old stylesheet it still has cached: Cloudflare tells browsers to keep
// them for hours.
//
//   node scripts/site-assets.mjs           update the pages
//   node scripts/site-assets.mjs --check   exit 1 if a page is out of date

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const ASSETS = ['/assets/site.css', '/assets/site.js', '/assets/demo-undo.mp4', '/assets/demo-undo.jpg'];

const pages = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? pages(p) : e.name.endsWith('.html') ? [p] : [];
  });

/** Pages whose links don't carry the current hashes; with write, fixes them. */
export function stamp({ write = false } = {}) {
  const version = Object.fromEntries(
    ASSETS.map((a) => [a, crypto.createHash('sha256').update(fs.readFileSync(path.join(site, a))).digest('hex').slice(0, 10)]),
  );
  const stale = [];
  for (const page of pages(site)) {
    const before = fs.readFileSync(page, 'utf8');
    let after = before;
    for (const a of ASSETS) {
      const re = new RegExp(`(["'])${a.replaceAll('.', '\\.')}(\\?v=[0-9a-f]*)?\\1`, 'g');
      after = after.replace(re, (_, q) => `${q}${a}?v=${version[a]}${q}`);
    }
    if (after === before) continue;
    stale.push(path.relative(site, page));
    if (write) fs.writeFileSync(page, after);
  }
  return stale;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const check = process.argv.includes('--check');
  const stale = stamp({ write: !check });
  if (check && stale.length) {
    console.error(`out of date (run node scripts/site-assets.mjs): ${stale.join(', ')}`);
    process.exit(1);
  }
  console.log(stale.length ? `updated ${stale.join(', ')}` : 'all pages up to date');
}
