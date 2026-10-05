# Guardrails

Rules live in `~/.zerostel/policy.json`. With no file there are no rules. `zerostel policy init` writes a starter set; besides the rules below, it asks before running as administrator (`sudo`), installing or removing software globally (`npm -g`, `pip --user`, `brew`, `winget`…), changing system or user settings (`setx`, `reg`, `crontab`…), writing to system folders, publishing or deploying (`npm publish`, `terraform apply`, `vercel --prod`…) dropping database tables, and switching Zerostel itself off (`zerostel uninstall`, `zerostel prune`, or editing an agent's hook settings). Rules match what a command says, so they slow an agent down rather than wall it in; hooks removed anyway show up in the log. An excerpt:

```jsonc
{
  "rules": [
    { "action": "deny", "paths": ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.kube/**", "~/.config/gcloud/**", "~/.zerostel/**"],
      "reason": "credentials, and Zerostel's own records, are off limits" },
    { "action": "ask", "paths": ["**/.env", "**/.env.*"], "access": "write", "reason": "changes a .env file" },
    { "action": "ask", "commands": ["git push --force*", "git push -f*", "git reset --hard*", "git clean -*f*", "* --no-verify*"],
      "reason": "rewrites or throws away git history" }
  ]
}
```

`zerostel policy init` writes a `$schema` line, so editors such as VS Code complete and check the file as you type (the schema is at `https://zerostel.com/schema/policy.json`; `config.json` has one too).

## How rules match

- `paths` match files a tool names, and paths that appear in shell commands. `~/` is your home folder; other relative globs start at the project root. `**` crosses folders, `*` doesn't.
- `commands` match each part of a shell command, split at `&&`, `||`, `;`, `|`, `&`, `( )`, `$( )` and backticks, without regard to case. A pattern matches a whole part, and `*` matches anything, spaces included: `curl *-d *` catches `curl -H 'x: y' -d @data.json https://...`.
- `tools` match tool names: Claude Code's names (`Bash`, `Edit`, `WebFetch`...) for every agent, and `mcp__<server>__<tool>` for MCP tools.
- One rule fires when any of its lists matches. A `deny` anywhere wins over an `ask`.
- `"access": "write"` limits a rule to tools that can change files.
- **`deny`** stops the call before it runs, and the agent is told why. **`ask`** makes Claude Code ask you; agents that can't pause to ask block the call and tell the agent to check with you.

Paths like `$HOME/.ssh`, `%USERPROFILE%\.ssh` or Git Bash's `/c/Users/...` are recognised for what they are.

Rules match what a tool call says, not what it does: a script can reach a file without naming it. They catch mistakes and slow a misled agent down; they are not a sandbox. Blocked and asked-about calls show up in the timeline, the web UI and reports. A broken `policy.json` is reported by `zerostel status` and `doctor`, and the last version that worked stays in force. A problem inside Zerostel never blocks a tool. One exception, on purpose: a call too big to check in full (a command over 256 KB, more than 1,000 paths) is asked about rather than waved through when you have path or command rules, since padding a call is an easy way around them. Agents that can't ask treat that as a block.

## Recipes

Ready-made rules for `~/.zerostel/policy.json`. Start from the starter set (`zerostel policy init`), then paste the rules you want into its `"rules"` list. Check what a rule catches before you rely on it:

```bash
zerostel policy test "git push origin main"
zerostel policy test ./migrations/0042_drop_users.sql
```

### Keep secrets out of reach

The starter set already denies `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, gcloud and Zerostel's own folder. Add key files and credentials kept elsewhere:

```json
{
  "action": "deny",
  "paths": ["**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/*.p12", "**/*.pfx", "~/.docker/config.json", "~/.npmrc", "~/.pypirc", "~/.netrc", "~/.azure/**", "~/.config/gh/hosts.yml"],
  "reason": "keys and credentials stay out of the agent's reach"
}
```

To keep the agent from even reading `.env` files (the starter set only asks before writing them):

```json
{ "action": "deny", "paths": ["**/.env", "**/.env.*"], "reason": "the agent works from .env.example, not real values" }
```

### Ask before anything leaves the machine

A rewind can't take back what was sent. Ask before uploads and posts:

```json
{
  "action": "ask",
  "commands": ["curl *-d *", "curl *--data*", "curl *-F *", "curl *-T *", "curl *--upload-file*", "wget *--post-*", "scp *", "rsync * *:*", "nc *", "Invoke-WebRequest *-Method Post*", "Invoke-RestMethod *-Method Post*"],
  "reason": "sends data off this machine"
}
```

And before the agent fetches web pages, if you'd rather it worked from what's in the project:

```json
{ "action": "ask", "tools": ["WebFetch", "WebSearch"], "reason": "goes to the web" }
```

### Protect what's hard to redo

Database migrations, infrastructure and CI definitions are where a wrong edit costs the most:

```json
{
  "action": "ask",
  "paths": ["**/migrations/**", "**/prisma/schema.prisma", "infra/**", "terraform/**", ".github/workflows/**"],
  "access": "write",
  "reason": "changes migrations, infrastructure or CI"
}
```

Commands that reset or drop a database:

```json
{
  "action": "ask",
  "commands": ["*prisma migrate reset*", "* db:drop*", "* db:reset*", "dropdb *", "mongo* --eval *drop*", "redis-cli *FLUSHALL*", "redis-cli *FLUSHDB*"],
  "reason": "resets or drops a database"
}
```

### Keep the main branch for people

```json
{
  "action": "ask",
  "commands": ["git push * main", "git push * main:*", "git push * HEAD:main", "git push * master", "git push * HEAD:master", "gh pr merge *"],
  "reason": "pushes or merges into the main branch"
}
```

### Deletions outside the project

`rm -rf` inside the project can be rewound. Outside it, it can't. These are the classic wrong-folder deletions; an absolute path inside the project is still fine:

```json
{
  "action": "deny",
  "commands": ["rm -rf /", "rm -rf ~", "rm -rf ~/", "rm -rf ~/*", "rm -rf $HOME", "rm -rf $HOME/*", "rm -rf ..", "rm -rf ../*", "Remove-Item -Recurse -Force ~*", "Remove-Item -Recurse -Force $HOME*"],
  "reason": "deletes outside the project, where a rewind can't help"
}
```

### MCP tools

MCP tools are named `mcp__<server>__<tool>`. Ask before anything that writes on another service, and block what you never want an agent to do:

```json
{ "action": "ask", "tools": ["mcp__*__create_*", "mcp__*__update_*", "mcp__*__delete_*", "mcp__*__send_*", "mcp__*__merge_*"], "reason": "changes something on another service" }
```

```json
{ "action": "deny", "tools": ["mcp__github__delete_*", "mcp__*__drop_*"], "reason": "not something an agent should do here" }
```

### Dependencies

New dependencies are where supply-chain trouble comes in. Ask before the agent adds one:

```json
{
  "action": "ask",
  "commands": ["npm install *", "npm i *", "pnpm add *", "yarn add *", "bun add *", "pip install *", "uv add *", "poetry add *", "cargo add *", "go get *"],
  "reason": "adds or changes a dependency"
}
```

### For CI

An agent running unattended in CI has nobody to ask, so `ask` blocks there. A strict file for the [GitHub Action](ci.md) (`policy: .github/zerostel-policy.json`) can be short:

```json
{
  "rules": [
    { "action": "deny", "paths": ["~/.ssh/**", "**/.env", "**/.env.*", "**/*.pem"], "reason": "no secrets in CI runs" },
    { "action": "deny", "commands": ["git push*", "gh *", "npm publish*", "curl *-d *", "curl *--data*"], "reason": "the workflow pushes and publishes, not the agent" },
    { "action": "deny", "paths": [".github/workflows/**"], "access": "write", "reason": "the agent can't change its own workflow" }
  ]
}
```
