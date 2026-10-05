# The demo video

The animation at the top of the README and the video on the website are made here, from the published npm package, so anyone can remake them.

1. `demo.tape` is a [VHS](https://github.com/charmbracelet/vhs) script: it types `npx zerostel demo`, which plays one agent turn that deletes `src/legacy` and breaks the tests, then `npx zerostel undo`. VHS records it at double size into `raw.mp4`.
2. `zoom.mjs` uses ffmpeg to zoom in on what's being typed and on the lines that matter, and writes `zerostel-demo.mp4`, a plain version without zooming, and a GIF of the plain one.

Everything runs in Docker, so only Docker and ffmpeg are needed on your machine:

```bash
cd docs/demo
docker build -t zerostel-vhs .
docker run --rm -v "${PWD}:/vhs" zerostel-vhs demo.tape
node zoom.mjs
```

Then copy `zerostel-demo.gif` to `docs/assets/demo.gif` (the README) and `zerostel-demo.mp4` to `site/assets/demo-undo.mp4` (the website). The outputs here aren't committed.

If you change the tape's timing, the zoom keyframes at the top of `zoom.mjs` need to move with it: they're in seconds and in `raw.mp4`'s pixels.
