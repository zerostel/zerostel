const useColor = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !!process.stdout.isTTY;
})();

const wrap = (open: number, close: number) => (s: string | number) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** The command to suggest in hints: `npx zerostel` when npx started this process, so the hint works as typed. */
export function selfCommand(): string {
  return process.env.npm_command === 'exec' ? 'npx zerostel' : 'zerostel';
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

// Commands, their output and file names come from the agent and the project,
// and can carry terminal escape codes (clear the screen, set the title, write
// the clipboard). Everything printed goes through here; only our own colour
// codes survive.
const UNSAFE = /\x1b(?!\[(?:1|2|22|3[1-9]|90)m)|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

export function clean(s: string): string {
  return s.replace(UNSAFE, '');
}

export function out(line = ''): void {
  process.stdout.write(clean(line) + '\n');
}

export function err(line: string): void {
  process.stderr.write(clean(line) + '\n');
}
