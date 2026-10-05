// Fills in the Homebrew formula and Scoop manifest for a published version:
//
//   node scripts/release-manifests.mjs 0.1.0            # hash of the tarball on npm
//   node scripts/release-manifests.mjs 0.1.0 local.tgz  # hash of a local `npm pack` file
//
// Writes packaging/out/zerostel.rb and packaging/out/zerostel.json, ready to
// copy into a tap (zerostel/homebrew-tap) and a bucket (zerostel/scoop-bucket).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [version, local] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: node scripts/release-manifests.mjs <version> [tarball]');
  process.exit(2);
}

let tarball;
if (local) {
  tarball = fs.readFileSync(local);
} else {
  const url = `https://registry.npmjs.org/zerostel/-/zerostel-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`could not download ${url}: HTTP ${res.status}`);
    process.exit(1);
  }
  tarball = Buffer.from(await res.arrayBuffer());
}
const sha256 = crypto.createHash('sha256').update(tarball).digest('hex');

const out = path.join(root, 'packaging', 'out');
fs.mkdirSync(out, { recursive: true });
for (const [template, name] of [
  ['packaging/homebrew/zerostel.rb', 'zerostel.rb'],
  ['packaging/scoop/zerostel.json', 'zerostel.json'],
]) {
  const text = fs.readFileSync(path.join(root, template), 'utf8').replaceAll('__VERSION__', version).replaceAll('__SHA256__', sha256);
  fs.writeFileSync(path.join(out, name), text);
}
console.log(`zerostel ${version} sha256 ${sha256}`);
console.log(`wrote ${path.relative(root, out)}/zerostel.rb and zerostel.json`);
