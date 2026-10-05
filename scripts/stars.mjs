// Draws site/assets/stars.svg: scattered stars, some of them joined by thin
// lines that all meet at one point (zero trust + stella: many agents, one
// point to come back to). Seeded, so the picture is the same on every run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let seed = 20261005;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const W = 1200;
const H = 720;
const zero = { x: 840, y: 300 };
const stars = Array.from({ length: 90 }, () => ({ x: rand() * W, y: rand() * H, r: 0.6 + rand() * 1.6, o: 0.25 + rand() * 0.6 }));
const linked = stars.filter((_, i) => i % 5 === 0);

const lines = linked
  .map((s) => `<line x1="${s.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${zero.x}" y2="${zero.y}" stroke="#f1653b" stroke-opacity="${(0.08 + s.o * 0.12).toFixed(2)}" stroke-width="0.8"/>`)
  .join('');
const dots = stars.map((s) => `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${s.r.toFixed(2)}" fill="#9fb0bf" fill-opacity="${s.o.toFixed(2)}"/>`).join('');
const point = `<circle cx="${zero.x}" cy="${zero.y}" r="22" fill="none" stroke="#f1653b" stroke-opacity="0.25"/><circle cx="${zero.x}" cy="${zero.y}" r="9" fill="none" stroke="#f1653b" stroke-opacity="0.5"/><circle cx="${zero.x}" cy="${zero.y}" r="3.5" fill="#f1653b"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">${lines}${dots}${point}</svg>\n`;
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'assets', 'stars.svg');
fs.writeFileSync(out, svg);
console.log(`${out} (${svg.length} bytes)`);
