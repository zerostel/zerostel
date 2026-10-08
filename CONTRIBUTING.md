# Contributing

Thanks for helping. Questions and ideas go to [Discussions](https://github.com/zerostel/zerostel/discussions), bugs and agent requests to [Issues](https://github.com/zerostel/zerostel/issues). Security problems go privately, as [SECURITY.md](SECURITY.md) describes, never into a public issue.

The most useful bug reports carry the output of `zerostel doctor` and a timeline (`zerostel log -n 20`) or a shareable report (`zerostel report --share`, which leaves out prompts, commands, output and diffs). Read either before you paste it.

## Setup

You need Node 20 or newer and git.

```bash
npm ci
npm run typecheck
npm test          # vitest, uses real git in temp folders
npm run build     # bundles to dist/cli.js
node dist/cli.js --help
```

`zerostel install` sets up every agent it finds, so to try hooks without touching your real agent configs, point your home folder and every agent folder at a temp folder:

```bash
export HOME=/tmp/zh USERPROFILE=/tmp/zh ZEROSTEL_DIR=/tmp/zh/.zerostel CLAUDE_CONFIG_DIR=/tmp/zh/.claude CODEX_HOME=/tmp/zh/.codex \
  COPILOT_HOME=/tmp/zh/.copilot XDG_CONFIG_HOME=/tmp/zh/.config GEMINI_CLI_HOME=/tmp/zh DSH_HOME=/tmp/zh/.dsh
node dist/cli.js install
```

`npm run smoke` does exactly that, and fails if a real agent config changes. `node scripts/bench.mjs` measures what Zerostel adds to a session.

## Layout

| Path | What's there |
|---|---|
| `src/agents/adapters.ts` | One adapter per agent: hooks file, layout, Windows runner, payload mapping |
| `src/agents/hooks.ts` | The hook handler every adapter feeds into |
| `src/agents/run.ts` | `zerostel run`: file-watching mode for agents without hooks |
| `src/guard/policy.ts` | Guardrails: matching paths, commands and tools against `policy.json` |
| `src/store/shadow.ts` | The shadow git repo: snapshot, diff, restore |
| `src/store/session.ts` | Session event log and how it turns into timeline steps |
| `src/store/prune.ts` | `zerostel prune` |
| `src/commands/rewind.ts` | What `undo` and `rewind` go back to |
| `src/commands/doctor.ts` | `zerostel doctor` checks |
| `src/install.ts` | Writing and removing hooks in agent config files |
| `src/detect/secrets.ts` | Masking API keys and tokens in what gets recorded |
| `src/mcp/server.ts` | `zerostel mcp` |
| `src/ui/` | `zerostel ui`: the local web page and its server |
| `src/report/html.ts` | The HTML report |
| `src/config.ts` | `~/.zerostel/config.json` |

How the pieces fit: [docs/architecture.md](docs/architecture.md).

## Adding an agent

If the agent has hooks, add an adapter to `src/agents/adapters.ts` (the fields are described in [docs/architecture.md](docs/architecture.md#adding-an-agent)) and tests that feed it real payloads. If it has no hooks, `zerostel run` already works; improvements there help every agent.

## Pull requests

- For anything bigger than a fix, open an issue or a discussion first, so we agree on the approach before you write it.
- One change per pull request, with tests. A bug fix comes with a test that fails without it.
- `npm run typecheck && npm test && npm run smoke` pass on your machine. CI runs the same on Linux, macOS and Windows with Node 20, 22, 24 and 26; for pull requests from forks it starts once a maintainer approves the run.
- Match the code around you; there's no formatter to run. Comments say why, not what.
- Anything users will notice gets a line in `CHANGELOG.md` under `## Unreleased` (add the heading if it isn't there).
- No new runtime dependencies. New dev dependencies need a good reason, since they run in CI.

By sending a pull request you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), like the rest of the project.

## Ground rules

- Hooks must never print to stdout (except an acknowledgement the agent requires), never exit non-zero and never block the agent. They run around every tool call, so they have to be quick.
- Never write to the user's own `.git`.
- Treat every project as hostile: never run programs found in it, never follow links out of it.
- Nothing leaves the machine: no telemetry, no uploads.
- Tests use temp folders only.
- Keep runtime dependencies at zero; everything is bundled into one file.
