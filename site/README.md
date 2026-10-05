# zerostel.com

The project website: static files, no build step, no third-party scripts, fonts or analytics.

- `index.html` (English) and `zh-tw/index.html`; styles in `assets/site.css`, the only script (copy buttons and the flight recorder example) in `assets/site.js`. `scripts/stars.mjs` draws `assets/stars.svg`.
- `_headers` sets the security headers on Cloudflare Pages. The pages also carry their CSP in a `<meta>` tag. Inline styles and scripts are not allowed, so keep everything in the asset files. The one `<script type="application/ld+json">` in each page is structured data for search engines; browsers never run it, so the CSP doesn't apply to it.
- `.well-known/security.txt` points to security@zerostel.com and GitHub's private reporting.

Preview: serve the folder with any static server, for example `npx serve site`, and open it in a browser.

Deploying is described in `docs/releasing.md`.
