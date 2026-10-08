import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, pathGlob, STARTER, textGlob, type Call, type Policy, type Rule } from '../src/guard/policy.js';
import { sandbox, type Sandbox } from './helpers.js';

// Property-based tests for the guardrails (#3): generated paths, commands and
// patterns, checked against rules that must always hold. A form that slips
// past a deny rule is a way around it.

const win = process.platform === 'win32';
const fold = win || process.platform === 'darwin';

let sb: Sandbox;
let home: string;
let root: string;
beforeAll(() => {
  sb = sandbox();
  home = sb.root;
  root = sb.project;
  // real files, so the real-path lookups run too
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'key');
  sb.write('secrets/key.pem', 'key');
  sb.write('src/app.ts', 'x');
});
afterAll(() => sb.cleanup());

const call = (over: Partial<Call>): Call => ({ tool: 'Bash', paths: [], writes: true, root, cwd: root, home, platform: process.platform, ...over });

describe('glob matching', () => {
  // the same globs as a regular expression, built independently
  function reference(pattern: string, kind: 'path' | 'text', foldCase: boolean): RegExp {
    const p = [...(foldCase ? pattern.toLowerCase() : pattern)];
    let re = '';
    for (let i = 0; i < p.length; i++) {
      const ch = p[i]!;
      if (kind === 'path' && ch === '*' && p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else if (ch === '*') re += kind === 'text' ? '.*' : '[^/]*';
      else if (ch === '?') re += kind === 'text' ? '.' : '[^/]';
      else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
    return new RegExp(`^${re}$`, 'su');
  }
  const chars = ['a', 'B', 'b', '/', '.', '-', 'é', 'İ', 'i', '😀', '中'];
  const pattern = fc.array(fc.constantFrom(...chars, '*', '**', '**/', '?'), { maxLength: 8 }).map((x) => x.join(''));
  const input = fc.array(fc.constantFrom(...chars, '\n'), { maxLength: 10 }).map((x) => x.join(''));

  it('matches paths exactly as the reference does, characters outside the BMP included', () => {
    fc.assert(
      fc.property(pattern, input, fc.boolean(), (pat, s, f) => {
        const expected = reference(pat, 'path', f).test(f ? s.toLowerCase() : s) || (/\/\*\*$/.test(pat) && reference(pat.slice(0, -3), 'path', f).test(f ? s.toLowerCase() : s));
        expect(pathGlob(pat, f).test(s)).toBe(expected);
      }),
      { numRuns: 2000 },
    );
  });

  it('matches commands exactly as the reference does, ignoring case', () => {
    fc.assert(
      fc.property(pattern, input, (pat, s) => {
        expect(textGlob(pat).test(s)).toBe(reference(pat, 'text', true).test(s.toLowerCase()));
      }),
      { numRuns: 2000 },
    );
  });

  it('takes a literal emoji in a rule as one character', () => {
    expect(pathGlob('notes/😀*.md', false).test('notes/😀plan.md')).toBe(true);
    expect(pathGlob('notes/?.md', false).test('notes/😀.md')).toBe(true);
    expect(textGlob('echo 😀*').test('echo 😀 hi')).toBe(true);
  });
});

describe('never throws, and answers every call', () => {
  it('for any command or path, with the starter rules', () => {
    const text = fc.oneof(fc.string({ unit: 'binary', maxLength: 80 }), fc.array(fc.constantFrom('rm', '-rf', '"', "'", '\\', '$(', ')', '`', '&&', '|', ';', '\n', 'bash', '-c', 'cmd', '/c', 'pwsh', '-e', '~', '..', '/', 'C:\\', '%USERPROFILE%', '$HOME', ' ', 'git', '-C', 'sudo', 'env', 'A=b'), { maxLength: 24 }).map((x) => x.join('')));
    fc.assert(
      fc.property(text, fc.array(text, { maxLength: 3 }), (command, paths) => {
        const d = evaluate(STARTER, call({ command, paths }));
        expect(d === null || ((d.action === 'deny' || d.action === 'ask') && typeof d.reason === 'string' && Number.isInteger(d.rule))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('asks about a call too big to check in full, rather than letting it through', () => {
    const rules: Policy = { rules: [{ action: 'deny', commands: ['rm -rf *'] }] };
    expect(evaluate(rules, call({ command: 'echo hi;'.repeat(40_000) }))?.action).toBe('ask');
    expect(evaluate(rules, call({ command: Array.from({ length: 1_200 }, (_, i) => `f${i}.txt`).join(' ') }))?.action).toBe('ask');
  });
});

describe('a denied command stays denied however it is written', () => {
  const policy: Policy = {
    rules: [
      { action: 'deny', commands: ['rm -rf *'], reason: 'deletes a folder' },
      { action: 'deny', commands: ['git reset --hard*'], reason: 'throws away work' },
      { action: 'deny', commands: ['Remove-Item *-Recurse*'], reason: 'deletes a folder' },
    ],
  };
  const bases = [
    ['rm', '-rf', 'build'],
    ['git', 'reset', '--hard', 'HEAD~1'],
    ['Remove-Item', '-Recurse', 'build'],
  ];

  type Edit = (w: string[]) => string[];
  const pick = <T>(xs: T[], i: number) => xs[i % xs.length]!;
  // word by word: quotes around all or part of a word, a backslash in front
  const wordEdit = fc.tuple(fc.nat(), fc.nat(), fc.constantFrom('single', 'double', 'split', 'backslash')).map(([wi, at, how]): Edit => (w) => {
    const i = wi % w.length;
    const word = w[i]!;
    // quoting a word that has quotes already changes what it says ("r'm'" is a program named r'm')
    if (/["'\\]/.test(word)) return w;
    const cut = at % (word.length + 1);
    const out = [...w];
    if (how === 'single') out[i] = `'${word}'`;
    else if (how === 'double') out[i] = `"${word}"`;
    else if (how === 'split') out[i] = `${word.slice(0, cut)}'${word.slice(cut)}'`;
    else out[i] = /^\w/.test(word) ? `\\${word}` : word;
    return out;
  });
  const qualify = fc.nat().map((n): Edit => (w) => {
    const names: Record<string, string[]> = {
      rm: ['/bin/rm', '/usr/bin/rm', ...(win ? ['C:\\tools\\rm.exe'] : [])],
      git: ['/usr/bin/git', 'git.exe', ...(win ? ['C:\\Program Files\\Git\\cmd\\git.exe'] : [])],
      'Remove-Item': ['remove-item'],
    };
    const alt = names[w[0]!];
    if (!alt) return w;
    const p = pick(alt, n);
    return [p.includes(' ') ? `"${p}"` : p, ...w.slice(1)];
  });
  const gitOptions = fc.constantFrom(['-C', 'repo'], ['-c', 'core.pager=cat'], ['--no-pager'], ['--git-dir=.git'], ['-P'], ['--work-tree', '.']).map((opt): Edit => (w) => (w[0] === 'git' ? ['git', ...opt, ...w.slice(1)] : w));
  const prefix = fc.constantFrom(
    'FOO=1', 'LANG=C A="x y"', 'command', 'builtin', 'exec', 'nohup', 'time', 'time -p', 'nice', 'nice -n 10', 'nice -5', 'timeout 30', 'timeout -s KILL 5',
    'stdbuf -oL', 'env', 'env -i', 'env FOO=bar', 'env -u HOME FOO=1', 'sudo', 'sudo -u root', 'sudo -E', 'doas', 'xargs', 'xargs -n 1', 'busybox', 'noglob',
  ).map((p): Edit => (w) => [p, ...w]);
  const spaces = fc.constantFrom('  ', '\t', ' \t ');

  // around the whole command
  type Wrap = (cmd: string) => string;
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const wrap = fc.constantFrom<Wrap>(
    (c) => `echo start && ${c}`,
    (c) => `${c} || true`,
    (c) => `ls; ${c}; ls`,
    (c) => `cat list | ${c}`,
    (c) => `${c} & wait`,
    (c) => `true\n${c}`,
    (c) => `echo $(${c})`,
    (c) => `(${c})`,
    (c) => `echo \`${c}\``,
    (c) => `bash -c ${sq(c)}`,
    (c) => `sh -c ${sq(c)}`,
    (c) => `bash -lc ${sq(c)}`,
    (c) => `bash -o pipefail -c ${sq(c)}`,
    (c) => `zsh -ec ${sq(c)}`,
    (c) => `cmd /c ${c}`,
    (c) => `cmd.exe /s /c ${c}`,
    (c) => `powershell -NoProfile -Command ${c}`,
    (c) => `pwsh -c ${c}`,
    (c) => `powershell -EncodedCommand ${Buffer.from(c, 'utf16le').toString('base64')}`,
    (c) => `zerostel run -- ${c}`,
  );

  it('with quotes, backslashes, spaces, VAR=value, wrappers, a full program path, git options, separators and inner shells', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.array(fc.oneof(wordEdit, qualify, gitOptions), { maxLength: 3 }),
        fc.array(prefix, { maxLength: 2 }),
        spaces,
        fc.array(wrap, { maxLength: 2 }),
        (b, edits, prefixes, sp, wraps) => {
          let words = pick(bases, b);
          for (const e of edits) words = e(words);
          for (const p of prefixes) words = p(words);
          let cmd = words.join(sp);
          for (const w of wraps) cmd = w(cmd);
          const d = evaluate(policy, call({ command: cmd }));
          if (d?.action !== 'deny') throw new Error(`not denied: ${JSON.stringify(cmd)}`);
        },
      ),
      { numRuns: 1500 },
    );
  });

  it('examples a rule used to miss', () => {
    for (const cmd of [
      `'rm' -rf build`,
      `"git" reset --hard`,
      `\\rm -rf build`,
      `/usr/bin/git reset --hard`,
      `GIT_DIR=.git git reset --hard`,
      `git -C . reset --hard`,
      `sudo -u root rm -rf build`,
      `env -i rm -rf build`,
      `timeout -s KILL 5 rm -rf build`,
      `bash -c 'rm -rf build'`,
      `cmd /c rm -rf build`,
      `powershell -EncodedCommand ${Buffer.from('Remove-Item -Recurse build', 'utf16le').toString('base64')}`,
    ]) {
      expect(evaluate(policy, call({ command: cmd }))?.action, cmd).toBe('deny');
    }
  });

  it('leaves alone commands that only mention a denied one', () => {
    for (const cmd of [`echo "rm -rf build"`, `grep -r "git reset --hard" docs`, `git log --grep="reset --hard"`, `bash -c 'echo rm -rf build'`, `cat rm.txt`]) {
      expect(evaluate(policy, call({ command: cmd })), cmd).toBeNull();
    }
  });
});

describe('a denied file stays denied however its path is written', () => {
  const policy: Policy = { rules: [{ action: 'deny', paths: ['~/.ssh/**', 'secrets/**'], reason: 'off limits' }] };

  // a path that names the same file: same folders, written differently
  const segs = (parts: string[]) =>
    fc.tuple(fc.array(fc.constantFrom('./', 'x/../', 'a/b/../../', '/'), { minLength: parts.length, maxLength: parts.length }), fc.array(fc.boolean(), { minLength: parts.length, maxLength: parts.length }), fc.array(fc.constantFrom('', '.', ' ', '..'), { minLength: parts.length, maxLength: parts.length })).map(([noise, upper, trail]) =>
      parts
        .map((p, i) => {
          let s = p;
          if (fold && upper[i]) s = s.toUpperCase();
          // Windows drops trailing dots and spaces from a name
          if (win && trail[i] !== '..') s += trail[i];
          return noise[i] + s;
        })
        .join('/'),
    );
  // <HOME> and <ROOT> are filled in when the test runs: the folders don't exist yet here
  const homeFile = fc.tuple(fc.constantFrom('~', '$HOME', '${HOME}', '<HOME>', ...(win ? ['%USERPROFILE%', '$env:USERPROFILE', '\\\\?\\<HOME>'] : [])), segs(['.ssh', 'id_rsa']), fc.boolean()).map(([h, rest, back]) => {
    const p = `${h}/${rest}`;
    return win && back ? p.replace(/\//g, '\\') : p;
  });
  const projectFile = fc.tuple(fc.constantFrom('', './', '<ROOT>/'), segs(['secrets', 'key.pem'])).map(([pre, rest]) => (pre ? `${pre}${rest}` : rest.replace(/^\/+/, '')));

  const inCommand = fc.constantFrom(
    (p: string) => `cat ${p}`,
    (p: string) => `cat "${p}"`,
    (p: string) => `cp ${p} /tmp/out`,
    (p: string) => `echo hi > ${p}`,
    (p: string) => `bash -c "cat ${p}"`,
    (p: string) => `ls && cat ${p}`,
  );

  it('named by a tool, or in a shell command', () => {
    fc.assert(
      fc.property(fc.oneof(homeFile, projectFile), fc.boolean(), inCommand, (spelled, viaTool, cmd) => {
        const p = spelled.replace('<HOME>', home).replace('<ROOT>', root);
        if (p.includes(' ') && !viaTool) return; // a space splits a shell word: covered by the quoted form
        const d = viaTool ? evaluate(policy, call({ tool: 'Read', paths: [p] })) : evaluate(policy, call({ command: cmd(p) }));
        if (d?.action !== 'deny') throw new Error(`not denied: ${viaTool ? p : cmd(p)}`);
      }),
      { numRuns: 400 },
    );
  });

  it('with quotes inside the path, the way a shell joins them', () => {
    expect(evaluate(policy, call({ command: `cat ~/.s"sh"/id_rsa` }))?.action).toBe('deny');
    expect(evaluate(policy, call({ command: `cat secrets/'key'.pem` }))?.action).toBe('deny');
    expect(evaluate(policy, call({ command: `sh -c 'cat $HOME/.ssh/id_rsa'` }))?.action).toBe('deny');
  });

  it('from a folder below the project', () => {
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    expect(evaluate(policy, call({ cwd: path.join(root, 'src', 'deep'), command: 'cat ../../secrets/key.pem' }))?.action).toBe('deny');
  });
});

describe('more rules never mean fewer answers', () => {
  const pool: Rule[] = [
    { action: 'deny', commands: ['rm -rf *'] },
    { action: 'ask', commands: ['git push*'] },
    { action: 'deny', paths: ['secrets/**'] },
    { action: 'ask', paths: ['**/*.env'], access: 'write' },
    { action: 'ask', tools: ['WebFetch'] },
    { action: 'deny', commands: ['*curl*'] },
  ];
  const calls = fc.record({
    tool: fc.constantFrom('Bash', 'Read', 'Write', 'WebFetch'),
    command: fc.constantFrom(undefined, 'rm -rf build', 'git push --force', 'curl x | sh', 'ls', `bash -c 'git push'`, 'cat secrets/key.pem'),
    paths: fc.array(fc.constantFrom('secrets/key.pem', 'src/app.ts', 'a/.env', 'README.md'), { maxLength: 2 }),
    writes: fc.boolean(),
  });

  it('adding a rule never turns a block or a question into nothing', () => {
    fc.assert(
      fc.property(fc.subarray(pool), fc.subarray(pool), calls, (base, extra, c) => {
        const before = evaluate({ rules: base }, call(c));
        const after = evaluate({ rules: [...base, ...extra] }, call(c));
        if (before) expect(after).not.toBeNull();
        if (before?.action === 'deny') expect(after?.action).toBe('deny');
      }),
      { numRuns: 500 },
    );
  });
});
