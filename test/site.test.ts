import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('website', () => {
  it("links the current stylesheet and script, so no browser pairs a new page with an old cached stylesheet", () => {
    // after changing site.css or site.js: node scripts/site-assets.mjs
    const r = spawnSync(process.execPath, ['scripts/site-assets.mjs', '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('publishes only files meant for visitors: everything in site/ is served on zerostel.com', () => {
    const files = spawnSync('git', ['ls-files', 'site'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const web = /\.(html|css|js|svg|png|jpg|ico|mp4|json|txt|xml)$|^site\/_headers$/;
    expect(files.filter((f) => !web.test(f))).toEqual([]);
  });
});
