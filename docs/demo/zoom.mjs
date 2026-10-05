// Turns raw.mp4 (from demo.tape) into the finished videos:
//   zerostel-demo.mp4        1920 wide, zooming in on what's typed and on what matters
//   zerostel-demo-plain.mp4  the same without zooming
//   zerostel-demo.gif        the plain one, small enough for a README
//
//   node zoom.mjs
//
// Needs ffmpeg on PATH. The keyframes below are in raw.mp4's pixels
// (2720x1640) and seconds; after changing the tape, look at a few frames and
// move them to match.

import { execFileSync } from 'node:child_process';

const W = 2720;
const H = 1640;
const FPS = 25;

// [seconds, zoom, centre x, centre y]: zoom 1 shows the whole window
const KEYS = [
  [0.0, 2.0, 760, 460], // typing `npx zerostel demo`
  [2.3, 2.0, 760, 460],
  [3.0, 1.0, W / 2, H / 2], // the whole timeline
  [4.0, 1.0, W / 2, H / 2],
  [4.7, 1.34, 1525, 800], // rm -rf, the failed test
  [6.6, 1.34, 1525, 800],
  [7.1, 2.0, 760, 1230], // typing cd at the bottom
  [8.6, 2.0, 760, 1230],
  [9.0, 2.0, 760, 460], // ls, then typing `npx zerostel undo`
  [13.3, 2.0, 760, 460],
  [14.0, 1.4, 1060, 760], // what undo will bring back, and the question
  [16.4, 1.4, 1060, 760],
  [17.0, 1.0, W / 2, H / 2], // done, and the hints
  [18.6, 1.0, W / 2, H / 2],
  [19.2, 2.0, 760, 1100], // ls: the files are back
  [99, 2.0, 760, 1100],
];

// piecewise smoothstep through the keyframes, as an ffmpeg expression of time T
function curve(index, scale = 1) {
  let expr = String(KEYS[KEYS.length - 1][index] * scale);
  for (let i = KEYS.length - 2; i >= 0; i--) {
    const [t0] = KEYS[i];
    const [t1] = KEYS[i + 1];
    const a = KEYS[i][index] * scale;
    const b = KEYS[i + 1][index] * scale;
    const u = `clip((T-${t0})/${t1 - t0},0,1)`;
    const seg = a === b ? String(a) : `(${a}+(${b - a})*${u}*${u}*(3-2*${u}))`;
    expr = `if(lt(T,${t1}),${seg},${expr})`;
  }
  return expr.replaceAll('T', `(in/${FPS})`);
}

// the input is doubled first so the moving crop lands on half pixels of the original
const zoom = curve(1);
const cx = curve(2, 2);
const cy = curve(3, 2);
const zoompan = `zoompan=z='${zoom}':x='max(0,min(iw-iw/zoom,${cx}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${cy}-ih/zoom/2))':d=1:s=1920x1158:fps=${FPS}`;

const encode = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'];
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

ff(['-i', 'raw.mp4', '-vf', `scale=${W * 2}:${H * 2}:flags=lanczos,${zoompan}`, ...encode, 'zerostel-demo.mp4']);
ff(['-i', 'raw.mp4', '-vf', 'scale=1920:1158:flags=lanczos', ...encode, 'zerostel-demo-plain.mp4']);
ff(['-i', 'zerostel-demo-plain.mp4', '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none', 'zerostel-demo.gif']);
console.log('wrote zerostel-demo.mp4, zerostel-demo-plain.mp4 and zerostel-demo.gif');
