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

## What each agent tells Zerostel

Every agent is recorded the same way, but they don't all report the same things to their hooks. This is what that changes in practice:

| Agent | Your prompts | A rule set to "ask" | A command that failed | Token usage |
|---|---|---|---|---|
| Claude Code | ✅ | asks you, in Claude Code | ✅ reported | ✅ from its transcript |
| Codex | ✅ | blocked, and the agent is told to get your go-ahead | only when an exit code shows in the output | ✅ from its transcript |
| Cursor | ✅ in the editor; the CLI sends none | blocked, as for Codex | ✅ reported | not captured yet |
| Gemini CLI | ✅ | blocked, as for Codex | when the tool reports an error, or an exit code shows | not captured yet |
| Antigravity | turns only, no prompt text | blocked, as for Codex | when the tool reports an error, or an exit code shows | not captured yet |
| Copilot CLI | ✅ | blocked, as for Codex | ✅ reported | not captured yet |
| opencode | ✅ | blocked, as for Codex | only when an exit code shows in the output | not captured yet |
| `zerostel run` | no | no rules: it sees files, not tool calls | its own exit code | no |

"A command that failed" decides what `zerostel checks` can say about a test or build the agent ran: when the agent doesn't report it, the result shows as "not reported", never as passed. `zerostel check -- <command>` always knows, since it runs the command itself.

## Agents that run Claude Code's hooks

Some agents also run the hooks in Claude Code's settings: Cursor (by default), Copilot CLI (a project's `.claude/settings.json`, such as one a team commits), and Continue CLI and Devin (`~/.claude/settings.json` too). Zerostel tells them apart by what they put in the hook's payload or environment, so their calls aren't recorded as Claude Code's:

- when the agent has Zerostel hooks of its own, those record the call and check the rules, and the Claude Code hook stays out of it;
- otherwise the call is recorded under the agent's own name, and a rule set to "ask" blocks there, as for Codex.

Crush and OpenHands are told apart the same way, should one of them run Zerostel's Claude Code hook. A Claude Code started from inside another agent stays Claude Code: it names its own session to its hooks.
