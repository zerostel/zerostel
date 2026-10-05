# Installing

```bash
npx zerostel install          # one-off, nothing installed globally
npm install -g zerostel       # or keep the `zerostel` command around
```

Run `npx` from a folder you trust, such as your home folder: inside a project, npx prefers a copy of the package that the project itself provides. You need git, and Node 20 or newer for npm. No Node? Every release also has a single executable with Node inside, for Windows, macOS and Linux on x64 and arm64: download it from [Releases](https://github.com/zerostel/zerostel/releases), run `zerostel install`, and it copies itself to `~/.zerostel/bin`. `gh attestation verify <file> --repo zerostel/zerostel` checks that a download was built by this repository's release workflow. Homebrew and Scoop packages are coming; their templates are in [packaging/](../packaging).

`zerostel install` copies itself to `~/.zerostel/bin`, so hooks keep working after an npx cache cleanup, and adds hooks to every agent it finds. It shows the change and keeps a backup of each config file it edits.

## Plugins, extensions and the skill

Each agent's own plugin system can install Zerostel too. All of them bring the same `zerostel` skill, which teaches the agent to read its timeline, preview a rewind and ask you before applying it, and leave the recorder alone.

| Agent | From inside the agent | What it adds |
|---|---|---|
| Claude Code | `/plugin marketplace add zerostel/zerostel`, then `/plugin install zerostel@zerostel` | recording, guardrails and the skill |
| Codex | `codex plugin marketplace add zerostel/zerostel`, then install Zerostel from the plugin list | the skill; recording comes from `zerostel install` |
| Antigravity | `agy plugin install https://github.com/zerostel/zerostel` | the skill; recording comes from `zerostel install` |
| Gemini CLI | `gemini extensions install https://github.com/zerostel/zerostel` | the skill; recording comes from `zerostel install` |
| Other agents that read skills | `npx skills add zerostel/zerostel` | the skill |
| MCP clients | `io.github.zerostel/zerostel` in the [MCP Registry](https://registry.modelcontextprotocol.io) | the MCP server ([docs/mcp.md](mcp.md)) |

In Claude Code, use the plugin or `zerostel install`, not both; if both are on, each event is still recorded once. No plugin starts the MCP server by itself: you add it, so you choose which program runs it ([docs/mcp.md](mcp.md)).
