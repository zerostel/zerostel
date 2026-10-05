import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './util/paths.js';

// ~/.zerostel/config.json. Every key is optional; environment variables win
// over the file so a single run can be tweaked without editing it.
export interface Config {
  /** new files larger than this are left out of snapshots */
  maxFileMB: number;
  /** stop snapshotting a project for an hour when staging takes longer */
  snapshotTimeoutSec: number;
  /** what `zerostel prune` removes by default */
  retentionDays: number;
  /** extra patterns never snapshotted, git pathspec glob syntax (`**` for any depth) */
  exclude: string[];
  /** files outside the project, under your home folder, to snapshot and rewind along with it (e.g. "~/.zshrc") */
  watch: string[];
}

export const DEFAULT_CONFIG: Config = {
  maxFileMB: 25,
  snapshotTimeoutSec: 20,
  retentionDays: 30,
  exclude: [],
  watch: [],
};

export function configPath(ctx: Pick<Ctx, 'dataDir'>): string {
  return path.join(ctx.dataDir, 'config.json');
}

export interface Loaded {
  config: Config;
  problems: string[];
  snapshotProblem?: string;
}

export function loadConfig(ctx: Pick<Ctx, 'dataDir'>): Loaded {
  const config = { ...DEFAULT_CONFIG, exclude: [...DEFAULT_CONFIG.exclude], watch: [...DEFAULT_CONFIG.watch] };
  const problems: string[] = [];
  let snapshotProblem: string | undefined;
  const file = configPath(ctx);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
      for (const key of ['maxFileMB', 'snapshotTimeoutSec', 'retentionDays'] as const) {
        if (raw[key] === undefined) continue;
        if (typeof raw[key] === 'number' && raw[key] > 0) config[key] = raw[key];
        else problems.push(`${key} must be a positive number`);
      }
      if (raw.exclude !== undefined) {
        if (Array.isArray(raw.exclude) && raw.exclude.every((x) => typeof x === 'string')) config.exclude = raw.exclude as string[];
        else {
          snapshotProblem = 'exclude must be a list of strings';
          problems.push(snapshotProblem);
        }
      }
      if (raw.watch !== undefined) {
        if (Array.isArray(raw.watch) && raw.watch.length <= 100 && raw.watch.every((x) => typeof x === 'string' && x.length > 0 && x.length < 1024)) config.watch = raw.watch as string[];
        else problems.push('watch must be a list of up to 100 file paths');
      }
      for (const key of Object.keys(raw)) if (!(key in DEFAULT_CONFIG) && key !== '$schema') problems.push(`unknown key "${key}"`);
    } catch (e) {
      snapshotProblem = `not valid JSON: ${(e as Error).message}`;
      problems.push(snapshotProblem);
    }
  }
  const mb = Number(process.env.ZEROSTEL_MAX_FILE_MB);
  if (mb > 0) config.maxFileMB = mb;
  const ms = Number(process.env.ZEROSTEL_SNAPSHOT_TIMEOUT_MS);
  if (ms > 0) config.snapshotTimeoutSec = ms / 1000;
  return { config, problems, snapshotProblem };
}
