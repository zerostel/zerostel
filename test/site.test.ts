import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('website', () => {
  it("links the current stylesheet and script, so no browser pairs a new page with an old cached stylesheet", () => {
    // after changing site.css or site.js: node scripts/site-assets.mjs
    const r = spawnSync(process.execPath, ['scripts/site-assets.mjs', '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
