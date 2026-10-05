# Changelog

## 0.1.2 (2026-10-05)

- A step that deleted files keeps its warning mark on its own line in `zerostel log`, instead of wrapping it onto the next one.
- After an undo or a rewind, the suggested commands start with `npx zerostel` when you ran Zerostel through npx, as the demo's already did.

## 0.1.1 (2026-10-05)

No changes to what Zerostel records or rewinds; this release brings the package page and the release process up to date.

- The README on npm links the website and the security model in every language, no longer promises Homebrew and Scoop packages that aren't out yet, and answers "does it slow the agent down?" once, with the measured numbers. The package's homepage is now zerostel.com.
- Contributor docs: how pull requests work, supported versions and how to report a vulnerability, a feature request form and a support page.
- Releases are built and staged on npm by CI through trusted publishing, with no npm token anywhere, and go live only when a maintainer approves them with two-factor authentication. The MCP Registry entry is published the same way, with GitHub OIDC.
- The GitHub Action uses `actions/upload-artifact` v7, which needs Actions Runner 2.327.1 or newer on self-hosted runners.

## 0.1.0 (2026-10-05)

Record

- Record Claude Code and Codex sessions through their hooks: prompts, tool calls, file changes, durations and token usage.
- Also records Cursor, Copilot CLI, opencode, Gemini CLI and Antigravity (CLI, desktop and IDE), each tested on Windows.
- Experimental support for DeepSeek Harness, through a native plugin, tested end to end.
- `zerostel run -- <command>` records any other agent or script by watching file changes.
- Snapshots in a separate shadow git repo per project; the project's own `.git` is never touched.
- Files outside the project (`watch` in config.json), global package installs and Windows user environment variables are recorded too.

Look and go back

- `log`, `sessions`, `show`, `diff` and `find` to look at what happened; `ui` for the same in a local web page.
- `undo`, `rewind <n>` (with `--after`, `--only`, `--dry-run`) and `snapshot` to go back; every rewind can itself be undone.
- `report` exports a session as a single HTML page with secrets masked; `--share` leaves out prompts, commands, output and diffs.
- `zerostel demo` sets up a throwaway project with one recorded agent turn to try it on.

Zero trust

- Guardrails in `~/.zerostel/policy.json` block a tool call, or make the agent ask first, before it runs. `policy init` writes a starter set, `policy test` shows what a command would hit.
- The starter rules ask before an agent uninstalls Zerostel or edits its own hook settings, and hooks removed mid-session are written into the log.
- Each session log is chained with a keyed hash; `zerostel verify` says which line was edited, removed or reordered.

Everywhere

- `zerostel mcp`: an MCP server with checkpoint, timeline, rewind (preview first), verify and policy checks.
- A Claude Code plugin, a Codex plugin, a Gemini CLI extension and a shared agent skill; an MCP Registry entry.
- A GitHub Action that records agents in CI, applies the guardrails and attaches the report.
- Standalone executables with Node inside for Windows, macOS and Linux on x64 and arm64, with build provenance.
- Tab completion for bash, zsh, fish and PowerShell; JSON schemas for policy.json and config.json.
