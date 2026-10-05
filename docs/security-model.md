# Security model

What Zerostel protects, what it doesn't, and how it's built to stay trustworthy itself. To report a problem, see [SECURITY.md](../SECURITY.md).

## What it's for

An AI coding agent runs commands and edits files with your permissions. Zerostel assumes it will sometimes get things wrong and gives you:

1. **A record** of every prompt, tool call, command, file change, duration and token count.
2. **A way back**: snapshots around every tool call that can change files, so any step can be undone.
3. **Guardrails**: rules you write that stop a tool call, or make the agent ask you, before it runs.
4. **A log you can check**: each event is chained to the previous one with a keyed hash.

## What it doesn't do

- **It isn't a sandbox.** An agent running as you can do anything you can do. Guardrails match what a tool call names; a script or command can reach a file without naming it.
- **It can't undo what leaves your machine**: network requests, deployments, database writes, published packages. The starter guardrails ask before the common ones.
- **It only restores what it captured**: the project folder, files you list under `watch`, and Windows user environment variables. Ignored folders, nested repositories and new files above the size limit are not captured, and `zerostel log` says so.
- **The audit chain can't stop someone with your account.** The key lives in `~/.zerostel/audit.key`. Anyone who can read it can rewrite a log completely. The chain catches everything short of that: edits, removed or reordered lines, lines cut off the end, a stripped chain, a log swapped between sessions. Keep `~/.zerostel/**` in a deny rule (the starter policy does) so the agent can't reach it.
- **It can't stop an agent from switching it off.** The starter rules ask before an agent runs `zerostel uninstall` or edits an agent's hook settings, but rules match what a command says, and a determined agent can phrase it differently. What it can't do is go unseen: an agent keeps running the hooks it started with, so the next hook call notices the change and writes it into the log, and `zerostel status` shows the agent as not recording. For a hard guarantee, make the hook settings read-only for the account the agent runs as, or use the agent's managed settings (for Claude Code, managed hooks that users can't remove).
- **Masking secrets is best effort.** Known key formats, passwords and tokens are masked in the timeline and reports, but unusual formats can slip through. Share reports with `--share`, which leaves out prompts, commands, output and diffs entirely.

## The adversary Zerostel assumes

Zerostel runs inside every agent session, in projects you didn't necessarily write. It treats these as hostile:

| Input | How it's handled |
|---|---|
| **Project contents** (file names, links, a planted `git.exe`, `.gitattributes`, hooks) | Programs are started by absolute path only, never from the project folder. git runs with an isolated config, no hooks, no filters, literal pathspecs. File names can't become options. Snapshots and rewinds never follow symlinks or junctions out of the project, and nothing is deleted that the pre-rewind snapshot doesn't hold. |
| **Hook payloads** from the agent | Parsed as data. Tool and event names are looked up as own keys only. Paths are found in any argument that names one, nested or not, in patches sent as plain text, and in shell commands; a new file under a linked folder is checked where it will land. Guardrail matching runs in linear time. A call that names more than the rules look at (over 1,000 paths, or a command over 256 KB) is asked about, never let through unchecked. |
| **Command output** shown in the terminal | Escape sequences are stripped except plain colors. |
| **Other local programs** reaching the web UI | `zerostel ui` listens on 127.0.0.1 with a random token passed in the URL fragment and required in a header, checks Host and Origin, accepts JSON only, defaults rewinds to a preview, and serves a strict CSP. On Linux, the browser is opened through a private redirect file so the token never appears in a command line. |
| **The release pipeline** | The job that runs tests and dev dependencies has no secrets. The job that publishes has the npm credentials, runs no project code, needs approval, and publishes with provenance. The standalone executables are signed with build provenance in a job that runs no project code, and land in a draft release a maintainer publishes. Actions are pinned to commit SHAs. |

## Design choices that matter for security

- **Zero runtime dependencies.** One bundled file plus git.
- **Never in the way, never silent on a decision.** Hooks always exit 0 and log their own errors, so a Zerostel problem doesn't stop your agent. A guardrail decision is made, and sent to the agent, before anything is recorded, so neither a failure nor a slow snapshot can turn a "deny" into silence. A broken `policy.json` falls back to the last version that worked.
- **Private by default.** `~/.zerostel` is owner-only; the audit key, policy and error log are owner-only files. Nothing is sent anywhere.
- **Everything reversible is reversible twice.** Every rewind snapshots first, so it can be undone, including the files outside the project and the environment variables it put back.

## Reviews

Zerostel's code has been reviewed for security in several rounds, by more than one reviewer, each covering what was added since the previous one: the snapshot and restore engine, program lookup on Windows, the web UI, the agent adapters, plugins and installers, the release workflow, the audit chain, guardrails, the MCP server and the watched-file feature. Findings are fixed with a regression test; the tests live in `test/security.test.ts`, `test/security-boundaries.test.ts`, `test/ui.test.ts`, `test/zerotrust.test.ts`, `test/guard-gaps.test.ts` and `test/review7.test.ts`. A review finds what it finds; report anything else through [SECURITY.md](../SECURITY.md).

Notable fixes, so you know the kind of thing that's checked:

- A `git.exe` or `node.bat` placed in a project could have been run instead of the real program on Windows.
- A report written with `-o` could follow a link out of the project.
- On Windows, a scan that ran out of budget could let git walk through a junction.
- Without the key, a log could be cut short and continued, or have its chain stripped, without `verify` noticing.
- A guardrail decision could be lost if recording failed.
