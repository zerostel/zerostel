# zerostel.com

The project website: static files, no build step, no third-party scripts, fonts or analytics.

- `index.html` (English) and `zh-tw/index.html`; styles in `assets/site.css`, the only script (copy buttons, the flight recorder example, and the scroll recording: sections that roll in and the tape counter that goes back to point zero) in `assets/site.js`; it respects reduced motion, and without it every section is simply there. `scripts/stars.mjs` draws `assets/stars.svg`.
- `_headers` sets the security headers on Cloudflare Pages. The pages also carry their CSP in a `<meta>` tag. Inline styles and scripts are not allowed, so keep everything in the asset files (site.js only sets CSS custom properties through the CSSOM, which the CSP allows). The one `<script type="application/ld+json">` in each page is structured data for search engines; browsers never run it, so the CSP doesn't apply to it.
- `.well-known/security.txt` points to security@zerostel.com and GitHub's private reporting.

After changing `assets/site.css` or `assets/site.js`, run `node scripts/site-assets.mjs`: it stamps the links in every page with a hash of the file, so browsers never mix a new page with a stylesheet they cached earlier (a test checks this).

Preview: serve the folder with any static server, for example `npx serve site`, and open it in a browser.

Deploying is described in `docs/releasing.md`.
