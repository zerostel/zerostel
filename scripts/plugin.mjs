// Writes the files that package Zerostel for each agent's plugin system, all
// from package.json, so the versions never drift. Run after bumping the version.
//
//   .claude-plugin/plugin.json, marketplace.json   Claude Code plugin (hooks + skill)
//   hooks/claude-code.json                         its hooks
//   plugin.json                                    Codex plugin (skill; recording comes from `zerostel install`)
//   gemini-extension.json                          Gemini CLI extension (skill)
//   server.json                                    MCP Registry entry for `zerostel mcp`
//
// The skill itself is skills/zerostel/SKILL.md, shared by all three.
// Claude Code's hooks are deliberately not in hooks/hooks.json: Codex and
// Gemini CLI load that path from any plugin or extension by default, and
// would run Claude Code's hooks under their own name.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8'));
const write = (file, data) => fs.writeFileSync(path.join(root, file), JSON.stringify(data, null, 2) + '\n');

const description = 'Rewind any AI agent to point zero. Records every step, rewinds to any of them, enforces your guardrails and keeps a log you can verify. Local, no telemetry.';
const author = { name: 'Zerostel', email: 'hello@zerostel.com', url: 'https://zerostel.com' };

// shell form on purpose: bash and PowerShell never run a program from the
// current folder, while exec form on Windows might pick up a node.exe there
const cmd = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hook claude-code';
const entry = (timeout) => ({ type: 'command', command: cmd, timeout });
const events = [
  ['SessionStart', undefined, 30],
  ['UserPromptSubmit', undefined, 30],
  ['PreToolUse', '*', 30],
  ['PostToolUse', '*', 30],
  ['PostToolUseFailure', '*', 30],
  ['Stop', undefined, 30],
  ['SessionEnd', undefined, 5],
];
const hooks = {};
for (const [e, matcher, timeout] of events) hooks[e] = [{ ...(matcher ? { matcher } : {}), hooks: [entry(timeout)] }];
write('hooks/claude-code.json', { hooks });

const plugin = {
  name: 'zerostel',
  displayName: 'Zerostel',
  version: pkg.version,
  description,
  author,
  homepage: 'https://zerostel.com',
  repository: 'https://github.com/zerostel/zerostel',
  license: 'Apache-2.0',
  keywords: ['rewind', 'undo', 'checkpoint', 'audit', 'guardrails', 'zero-trust', 'timeline'],
  hooks: './hooks/claude-code.json',
};
write('.claude-plugin/plugin.json', plugin);
write('.claude-plugin/marketplace.json', {
  name: 'zerostel',
  description: 'Zerostel for Claude Code: a flight recorder and time machine for your agent.',
  owner: { name: author.name, email: author.email },
  plugins: [{ name: 'zerostel', source: { source: 'npm', package: 'zerostel' }, description }],
});

// Codex reads a plugin.json at the package root. It carries the skill only:
// Codex would otherwise look for hooks/hooks.json, and plugin hooks run
// through cmd.exe on Windows, which looks for node in the project folder first.
write('plugin.json', {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'zerostel',
  version: pkg.version,
  description,
  author,
  homepage: 'https://zerostel.com',
  repository: 'https://github.com/zerostel/zerostel',
  license: 'Apache-2.0',
  keywords: plugin.keywords,
});

// Gemini CLI installs extensions from the git repository, which has no dist/,
// so the extension carries the skill; `zerostel install --agent gemini` adds the hooks.
write('gemini-extension.json', { name: 'zerostel', version: pkg.version, description });

// The MCP Registry entry; its name has to match "mcpName" in package.json.
if (!pkg.mcpName) throw new Error('package.json needs "mcpName"');
write('server.json', {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: pkg.mcpName,
  title: 'Zerostel',
  description: 'Checkpoints, timeline and rewind for AI coding agents. Local, no telemetry.',
  websiteUrl: 'https://zerostel.com',
  repository: { url: 'https://github.com/zerostel/zerostel', source: 'github' },
  version: pkg.version,
  packages: [
    {
      registryType: 'npm',
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: 'stdio' },
      packageArguments: [{ type: 'positional', value: 'mcp' }],
    },
  ],
});
