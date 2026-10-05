import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCtx, type Ctx } from '../src/util/paths.js';

export interface Sandbox {
  root: string; // fake home
  project: string; // a project inside it
  ctx: Ctx;
  write(rel: string, content: string): void;
  read(rel: string): string | null;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zerostel-test-'));
  const project = path.join(root, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const ctx = defaultCtx({ home: root, cwd: project, dataDir: path.join(root, '.zerostel') });
  return {
    root,
    project,
    ctx,
    write(rel, content) {
      const f = path.join(project, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    },
    read(rel) {
      const f = path.join(project, rel);
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
