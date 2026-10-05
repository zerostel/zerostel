// Builds Zerostel as a single executable with Node inside, for machines that
// don't have Node: build/standalone/zerostel (zerostel.exe on Windows).
//
// It packs the Node that runs this script, so run it on each target OS and
// architecture with the Node version to ship (the release workflow does).
// Node's single executable applications: https://nodejs.org/api/single-executable-applications.html
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'build', 'standalone');
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status}`})`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Node runs one CommonJS script from inside the executable
await build({
  config: false,
  entry: { cli: 'src/cli.ts' },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: `node${process.versions.node.split('.')[0]}`,
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  outDir: out,
  shims: true,
  silent: true,
  define: { __VERSION__: JSON.stringify(pkg.version), __STANDALONE__: 'true' },
});

const blob = path.join(out, 'sea.blob');
const seaConfig = path.join(out, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({ main: path.join(out, 'cli.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: true }));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

const exe = path.join(out, win ? 'zerostel.exe' : 'zerostel');
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (mac) run('codesign', ['--remove-signature', exe]);
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
run(process.execPath, [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(mac ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
// macOS won't run an arm64 binary without a signature; an ad-hoc one will do until it's notarized
if (mac) run('codesign', ['--sign', '-', exe]);

for (const f of ['cli.cjs', 'sea.blob', 'sea-config.json']) fs.rmSync(path.join(out, f));

const v = spawnSync(exe, ['--version'], { encoding: 'utf8' });
if (v.stdout.trim() !== pkg.version) throw new Error(`${exe} --version printed ${JSON.stringify(v.stdout || v.stderr)}`);
console.log(`${path.relative(root, exe)}  ${pkg.version}  node ${process.version}  ${(fs.statSync(exe).size / 1e6).toFixed(0)} MB`);
