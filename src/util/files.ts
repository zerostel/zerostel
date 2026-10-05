import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Replace a report without following a project-supplied symlink or hard link. */
export function writeFileAtomic(file: string, data: string, opts: { projectRoot?: string; mode?: number } = {}): void {
  const target = path.resolve(file);
  if (opts.projectRoot) {
    const root = path.resolve(opts.projectRoot);
    const rel = path.relative(root, target);
    const inside = rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
    if (inside) {
      let parent = root;
      for (const part of rel.split(path.sep).slice(0, -1)) {
        parent = path.join(parent, part);
        try {
          const st = fs.lstatSync(parent);
          if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to write through a linked or non-directory parent: ${parent}`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          break;
        }
      }
    }
  }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.zerostel-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(tmp, 'wx', opts.mode ?? 0o600);
    created = true;
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
    created = false;
  } finally {
    if (created) fs.unlinkSync(tmp);
  }
}
