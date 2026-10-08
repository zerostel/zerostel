# The MCP server

`zerostel mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so the agent itself can save a checkpoint before something risky, read its timeline, see which checks still hold for the code as it is now (`checks`), pick up an earlier session (`handoff`), check a command against your rules, and rewind when you ask it to ("go back to step 12", "back to point zero"). Rewinds only preview until the call says to apply them, with the confirm code the preview gave (so nothing is applied that wasn't shown first, and a project that changed in between needs a new preview), can leave files other sessions changed since then alone (`keep_others`), and work only on the project the agent was started in: watched files in your home folder and Windows user variables go back only when you run `zerostel rewind` yourself.

The tools are `checkpoint`, `timeline`, `rewind`, `checks`, `handoff`, `verify` and `check_policy`. Each one says what it does to your machine through MCP tool annotations, for clients that use them to decide what to approve on their own: `rewind` is the only one that can change or delete project files, and only with a confirm code; `checkpoint` adds a snapshot; the others only read; none of them reach the network.

With `zerostel` installed globally (`npm install -g zerostel`), add it to Claude Code:

```bash
claude mcp add zerostel -- zerostel mcp
```

On Windows, use `claude mcp add zerostel -- cmd /c zerostel mcp`. Codex reads it from `~/.codex/config.toml`:

```toml
[mcp_servers.zerostel]
command = "zerostel"
args = ["mcp"]
```

Other agents take the same command and argument in their MCP settings.

The server is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.zerostel/zerostel`.
