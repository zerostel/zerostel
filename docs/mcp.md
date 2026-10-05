# The MCP server

`zerostel mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so the agent itself can save a checkpoint before something risky, read its timeline, check a command against your rules, and rewind when you ask it to ("go back to step 12", "back to point zero"). Rewinds only preview until the call says to apply them, and work only on the project the agent was started in.

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
