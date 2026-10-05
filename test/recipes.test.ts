import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate, validate, type Call, type Policy } from '../src/guard/policy.js';

// Every rule in docs/guardrails.md is valid, and catches what it says it does.

const doc = fs.readFileSync('docs/guardrails.md', 'utf8');
const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
// single rules go into one everyday policy; the CI file is a policy of its own
const policy: Policy = { rules: blocks.filter((b) => !Array.isArray(b.rules)) as unknown as Policy['rules'] };
const ci = blocks.find((b) => Array.isArray(b.rules)) as unknown as Policy;

const root = path.resolve('/proj');
const home = path.resolve('/home/me');
const call = (c: Partial<Call>): Call => ({ tool: 'Bash', paths: [], writes: true, root, cwd: root, home, platform: 'linux', ...c });
const shell = (command: string) => evaluate(policy, call({ command }))?.action ?? 'allow';
const file = (p: string, tool = 'Edit') => evaluate(policy, call({ tool, paths: [p], writes: tool !== 'Read' }))?.action ?? 'allow';
const tool = (name: string) => evaluate(policy, call({ tool: name }))?.action ?? 'allow';
const inCi = (c: Partial<Call>) => evaluate(ci, call(c))?.action ?? 'allow';

describe('guardrail recipes', () => {
  it('are all valid policy rules', () => {
    expect(blocks.length).toBeGreaterThan(8);
    for (const b of blocks) expect(validate(Array.isArray(b.rules) ? b : { rules: [b] }).problem).toBeUndefined();
  });

  it('keep secrets out of reach', () => {
    expect(file('/proj/certs/server.pem', 'Read')).toBe('deny');
    expect(file(path.join(home, '.npmrc'), 'Read')).toBe('deny');
    expect(file('/proj/.env.local', 'Read')).toBe('deny');
    expect(file('/proj/.env.example', 'Read')).toBe('deny'); // .env.* is broad on purpose
    expect(file('/proj/src/app.ts', 'Read')).toBe('allow');
  });

  it('ask before data leaves the machine', () => {
    expect(shell("curl -H 'content-type: application/json' -d @data.json https://example.com/api")).toBe('ask');
    expect(shell('curl -fsSL https://example.com/install.sh -o install.sh')).toBe('allow');
    expect(shell('scp dump.sql me@host:/tmp')).toBe('ask');
    expect(tool('WebFetch')).toBe('ask');
  });

  it('protect migrations, infrastructure and the main branch', () => {
    expect(file('/proj/db/migrations/0042_drop_users.sql')).toBe('ask');
    expect(file('/proj/db/migrations/0042_drop_users.sql', 'Read')).toBe('allow');
    expect(file('/proj/.github/workflows/ci.yml')).toBe('ask');
    expect(shell('npx prisma migrate reset --force')).toBe('ask');
    expect(shell('bin/rails db:drop')).toBe('ask');
    expect(shell('git push -u origin main')).toBe('ask');
    expect(shell('git push origin feature/login')).toBe('allow');
  });

  it('stop wrong-folder deletions but not ones inside the project', () => {
    expect(shell('rm -rf ~/')).toBe('deny');
    expect(shell('cd build && rm -rf ../*')).toBe('deny');
    expect(shell('rm -rf /proj/build')).toBe('allow');
    expect(shell('rm -rf node_modules')).toBe('allow');
  });

  it('make a strict file for CI', () => {
    expect(inCi({ command: 'git push origin feature/login' })).toBe('deny');
    expect(inCi({ tool: 'Edit', paths: ['/proj/.github/workflows/ci.yml'] })).toBe('deny');
    expect(inCi({ tool: 'Read', paths: ['/proj/.env'], writes: false })).toBe('deny');
    expect(inCi({ command: 'npm test' })).toBe('allow');
  });

  it('cover MCP tools and new dependencies', () => {
    expect(tool('mcp__linear__create_issue')).toBe('ask');
    expect(tool('mcp__github__delete_repository')).toBe('deny');
    expect(tool('mcp__github__get_issue')).toBe('allow');
    expect(shell('npm i -D left-pad')).toBe('ask');
    expect(shell('npm install')).toBe('allow');
  });
});
