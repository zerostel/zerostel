import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeCode } from '../src/agents/adapters.js';

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const pkg = read('package.json');

describe('SECURITY.md', () => {
  it('names the current release line as the one that gets security fixes', () => {
    const [major, minor] = (pkg.version as string).split('.');
    expect(fs.readFileSync('SECURITY.md', 'utf8')).toContain(`| ${major}.${minor}.x | ✅ |`);
  });
});

describe('Claude Code plugin files', () => {
  it('match the package version and the events zerostel install registers', () => {
    const plugin = read('.claude-plugin/plugin.json');
    expect(plugin.version).toBe(pkg.version); // run `node scripts/plugin.mjs` after a version bump
    expect(plugin.hooks).toBe('./hooks/claude-code.json');
    const hooks = read('hooks/claude-code.json').hooks as Record<string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]>;
    expect(Object.keys(hooks)).toEqual(claudeCode.events.map((e) => e.event));
    for (const e of claudeCode.events) {
      const [group] = hooks[e.event]!;
      expect(group!.matcher).toBe(e.matcher);
      expect(group!.hooks[0]!.timeout).toBe(e.timeout);
      // shell form: neither bash nor PowerShell runs a program from the current folder
      expect(group!.hooks[0]!.command).toBe('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hook claude-code');
    }
    // Codex and Gemini CLI load hooks/hooks.json from any plugin; Claude Code's hooks must not be there
    expect(fs.existsSync('hooks/hooks.json')).toBe(false);
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', '.claude-plugin/plugin.json', 'hooks/claude-code.json', 'plugin.json', 'skills']));
  });
});

describe('other packages', () => {
  it('Codex plugin and Gemini CLI extension carry the same version and no hooks', () => {
    const codex = read('plugin.json');
    const gemini = read('gemini-extension.json');
    expect([codex.version, gemini.version]).toEqual([pkg.version, pkg.version]);
    expect(codex.extensions).toBeUndefined();
    expect(gemini.mcpServers).toBeUndefined();
  });

  it('the MCP Registry entry matches the npm package', () => {
    const server = read('server.json');
    expect(server.name).toBe(pkg.mcpName);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } });
  });
});

describe('the skill', () => {
  const text = fs.readFileSync('skills/zerostel/SKILL.md', 'utf8');
  const front = text.split('\n---\n')[0]!;

  it('has the frontmatter every agent reads', () => {
    expect(front).toMatch(/^---\nname: zerostel\n/);
    const description = /\ndescription: (.+)\n/.exec(front)![1]!;
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('pre-approves read-only commands only', () => {
    const allowed = [...front.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1]!);
    // exact commands: a wildcard could let extra arguments or a redirection through
    expect(allowed).toEqual(['Bash(zerostel log)', 'Bash(zerostel log --changes)', 'Bash(zerostel sessions)', 'Bash(zerostel status)', 'Bash(zerostel verify)', 'Bash(zerostel policy)']);
    // and no npx: inside a project it would prefer the project's own copy
    expect(text).not.toMatch(/`npx zerostel/);
  });
});
