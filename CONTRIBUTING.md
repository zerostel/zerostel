# Contributing

Thanks for helping. Bug reports with a timeline (`zerostel log`) or a report (`zerostel report --no-prompts`) are the most useful thing you can send.

## Setup

```bash
npm install
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
| `src/store/shadow.ts` | The shadow git repo: snapshot, diff, restore |
| `src/store/session.ts` | Session event log and how it turns into timeline steps |
| `src/store/prune.ts` | `zerostel prune` |
| `src/commands/rewind.ts` | What `undo` and `rewind` go back to |
| `src/commands/doctor.ts` | `zerostel doctor` checks |
| `src/install.ts` | Writing and removing hooks in agent config files |
| `src/report/html.ts` | The HTML report |
| `src/config.ts` | `~/.zerostel/config.json` |

How the pieces fit: [docs/architecture.md](docs/architecture.md).

## Adding an agent

If the agent has hooks, add an adapter to `src/agents/adapters.ts` (the fields are described in [docs/architecture.md](docs/architecture.md#adding-an-agent)) and tests that feed it real payloads. If it has no hooks, `zerostel run` already works; improvements there help every agent.

## Ground rules

- Hooks must never print to stdout (except an acknowledgement the agent requires), never exit non-zero and never block the agent.
- Never write to the user's own `.git`.
- Tests use temp folders only.
- Keep runtime dependencies at zero; everything is bundled into one file.
