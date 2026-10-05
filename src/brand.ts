// The small Zerostel icon (docs/assets/brand/zerostel-icon-small.svg), inlined
// so the web UI and the single-file report need nothing from outside.
const ICON_SMALL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-28 -59 420 420"><path fill="#F1653B" transform="translate(-16 0)" d="M62 20H328A32 32 0 0 1 348.67 76.428L181.358 218H334A32 32 0 0 1 334 282H94A32 32 0 0 1 73.33 225.572L240.642 84H62A32 32 0 0 1 62 20Z"/></svg>';

export const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(ICON_SMALL)}">`;
