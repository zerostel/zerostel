# Architecture

Zerostel is a single Node script (bundled to `dist/cli.js`, no runtime dependencies) plus git. Everything it stores lives under `~/.zerostel`.

## In short

```
 agent ──hook──▶ zerostel ──▶ policy.json      block or ask before the tool runs
 (before and after  │
  every tool call)  └──────▶ ~/.zerostel/projects/<name>-<hash>/
                              ├─ snapshots.git      shadow repo, work tree = your project
                              └─ sessions/*.jsonl   prompts, commands, files, tokens, time (hash-chained)
```

- **Hooks.** The agent calls Zerostel before and after each tool call and at the start and end of each turn. Read-only tools are only logged; anything that can change files gets a snapshot before and after.
- **Shadow git repo.** Snapshots live in a separate repository whose work tree is your project. Your `.git`, branches, index and stash are never touched, and the project doesn't need to be a git repo. Files are stored byte for byte and identical content is stored once.
- **What's snapshotted.** Everything `.gitignore` doesn't exclude, minus dependency folders like `node_modules`. Small ignored files such as `.env` are still backed up, because an agent deleting them is exactly when you need them back. Files you list under `watch` (outside the project) are kept in a repo of their own.
- **Safe rewinds.** Before restoring, Zerostel snapshots the current state, so every rewind can be undone. It only removes what that snapshot holds a copy of, never follows a symlink or junction out of the project, and checks the result afterwards.
- **A log you can check.** Each event line carries an HMAC of the previous line and itself, keyed by `~/.zerostel/audit.key`.
- **Never in the way.** Hooks print nothing unless a rule fires, always exit 0 and log their own errors. If Zerostel has a problem, the agent carries on.

## What lives where

```
~/.zerostel/
├─ bin/zerostel.mjs              copy of the CLI that agent hooks run
├─ bin/zerostel-hook.cmd         Windows shim for agents that run hooks through cmd.exe
├─ config.json                   optional settings
├─ policy.json                   optional guardrail rules
├─ audit.key                     key for the session log chain (owner-only)
├─ home/snapshots.git/           snapshots of the watched files outside projects
├─ errors.log                    hook errors (rotates at 1 MB)
├─ reports/                      default output of `zerostel report`
└─ projects/<name>-<hash>/       one per project folder
   ├─ project.json               the folder this belongs to
   ├─ snapshots.git/             shadow repository (work tree = the project)
   ├─ sessions/<agent>__<id>.jsonl         event log per agent session (hash-chained)
   ├─ sessions/<agent>__<id>.jsonl.head    last chain value and log size
   ├─ sessions/<agent>__<id>.state.json    hook state between calls
   ├─ paused.json                present while snapshots are paused
   └─ lock                       held while git is working
```

## Flow of one tool call

1. The agent runs `node ~/.zerostel/bin/zerostel.mjs hook <agent>` with a JSON payload on stdin.
2. The agent's **adapter** (`src/agents/adapters.ts`) turns the payload into a `HookInput` with one of seven moments: `start`, `prompt`, `pre`, `post`, `post-fail`, `stop`, `end`. Other agents run Claude Code's hooks too, so first its `ranBy()` reads the payload and the environment for who really ran the hook: that agent's own Zerostel hooks, when installed, record the call instead; otherwise its adapter (or, with no adapter of its own, a guest in `GUESTS`) takes over, and the call is recorded and answered as that agent's.
3. `handleHook` (`src/agents/hooks.ts`) finds the project and takes the session lock. On `pre` it first checks the call against `policy.json` (`src/guard/policy.ts`); a `deny` is recorded and the tool never runs. Otherwise, for tools that can change files, it takes a **snapshot** (`src/store/shadow.ts`) on `pre` and `post`, and snapshots the watched files (`src/store/home.ts`). Any difference between the previous snapshot and the new `pre` snapshot is recorded as an "outside" change.
4. An event line is appended to the session's `.jsonl` with its chain value (`src/store/audit.ts`). Nothing is printed unless a rule fired (the adapter's `decide()` writes the agent's own format) or the agent requires an acknowledgement (Cursor expects `{}`), and the process exits 0 even on errors.

## Snapshots

- `git add -A` into the shadow repo's index, then `write-tree`, then `commit-tree` with the previous snapshot as parent. If the tree hasn't changed, the previous commit is reused.
- The first snapshot of a project has to read every file, which on a big project (and on Windows, where a virus scanner looks at each file git reads) takes minutes; later ones only look at what changed. So the first one is staged in chunks of a few hundred files, each of which leaves the index saved. When a session opens, the hook starts `zerostel baseline --project <root>` as a detached process, which works through the chunks taking the project lock for a few seconds at a time; a hook that finds no snapshot yet either finishes the job within 8 seconds or leaves it to that worker and records the step without one. `scripts/bench.mjs` measures all of this.
- The shadow repo ignores the user's global and system git config and all `GIT_*` variables, stores bytes exactly (`* -text -filter -ident`), and treats every path as a literal pathspec.
- Excluded on top of `.gitignore`: dependency folders (`node_modules`, `.venv`…), new files above `maxFileMB`, patterns from `config.json`, and on Windows any junction or directory symlink (git would otherwise walk through it). Exclusions are pathspecs on the command line, so a project's `.gitignore` can't re-include them.
- Small ignored files (≤ 1 MB, not in build/dependency folders) such as `.env` are force-added.
- All snapshots form one chain, so git never garbage-collects one a session still uses. `zerostel prune` rebuilds the chain without the snapshots only old sessions used and rewrites the ids in the remaining session files.

## Restore

`restore(target)` in `src/store/shadow.ts`:

0. `applyRestore` first records a `rewinding` event with the current snapshot, so a rewind cut short can still be undone and `prune` keeps what it would go back to.
1. Snapshot the current state (so the restore can be undone).
2. Diff current → target. Every path must be a plain repo-relative path. Zerostel's own data folder, if it sits inside the project, is left out.
3. Leave alone any file the snapshot from step 1 has no exact copy of: one git couldn't read (`diff-files` still shows it changed), or one snapshots leave out (excluded, too large, ignored) that the target would overwrite. These are reported, in the preview too.
4. Delete files that exist now but not in the target, unless a parent folder is a symlink, junction or file (then it's reported, not touched).
5. Clear anything in the way of a file to write back, but only if the pre-restore snapshot holds a copy of it.
6. `git checkout <target> -- <paths>` for the rest.
7. `applyRestore` (`src/commands/rewind.ts`) snapshots again, compares the result with the target, and reports anything that still differs.

## Adding an agent

Add an `Adapter` to `ADAPTERS` in `src/agents/adapters.ts`:

| Field | What it is |
|---|---|
| `configFile(ctx)` | the hooks file to edit |
| `layout` | `nested` (`{ Event: [{ matcher, hooks: [entry] }] }`), `flat` (`{ event: [entry] }`), `group` (one named group, Antigravity), `owned` (a file only Zerostel writes, from `render`) or `block` (a marked block in a text file the user also edits, from `block`) |
| `companion` | a second file Zerostel owns, such as the plugin a `block` points to (DeepSeek Harness) |
| `events` | which events to register, with matcher and timeout |
| `windowsRunner` | how the agent runs a command on Windows: `exec` (command + args), `cmd` (`cmd /C`), `powershell` |
| `ack` | stdout the agent requires from a hook with no opinion (a string, or a function of the payload) |
| `decide(d)` | stdout that blocks a tool call; `asks` when the agent can pause to ask the user |
| `normalize(raw)` | payload → `HookInput`, or `null` to ignore |
| `experimental` | only installed with `--agent <id>` |

Agents with no command hooks (opencode, DeepSeek Harness) get a small plugin that forwards events to `zerostel hook <id>` in a payload of Zerostel's own.

Then add tests with real payloads (see `test/experimental.test.ts`). To try the real agent without a model account, point it at a scripted model: most agents take a base URL for their API (`GOOGLE_GEMINI_BASE_URL` for Gemini CLI and Antigravity, `DEEPSEEK_BASE_URL` for DeepSeek Harness), and a small local server can answer with the tool calls you want to see, one per request. Keep the agent's home folder, Zerostel's data folder and the project in a temporary folder.

## Audit chain

Every event line gets `chain` = HMAC-SHA256(key, previous chain + "
" + the event without `chain`), cut to 32 hex characters; the first chained line starts from a fixed value. Appends take `<log>.chain` as a lock, read the previous value from `<log>.head` (checked against the log's size, rescanned if they disagree) and write the new one back. `verify` recomputes every line and compares the end with `.head`, so edited, removed, reordered or cut-off lines show. Lines written before chaining existed are counted, not checked. `prune` recomputes the chain after it renames snapshot ids.

## Guardrails

`policy.json` is a list of rules: `action` (`deny` or `ask`), and any of `paths`, `commands`, `tools`, with optional `access: "write"` and `reason`. Paths come from the tool input (`file_path`, `path`, …, apply_patch headers) and from path-like words in shell commands. Commands are matched whole and split at `&&`, `||`, `;`, `|`. Deny wins over ask. A missing file means no rules; a broken one keeps the last version that worked (no rules if there never was one), and the problem is reported in `errors.log`, `status` and `doctor`.

## Watched files

`config.json` `watch` lists files under the home folder. `snapshotHome` lstat's each one, skips the ones whose size, mtime and inode haven't changed, reads the rest itself (without following links), stores them with `hash-object` and `update-index --index-info`, and commits a tree. Git never scans the home folder. `home` events record changes; every step carries the home snapshot before and after it, and `applyRestore` restores watched files along with the project unless `--only` is used.

## MCP server

`zerostel mcp` (`src/mcp/server.ts`) reads JSON-RPC lines on stdin and answers on stdout: `initialize`, `tools/list`, `tools/call` for `checkpoint`, `timeline`, `rewind` (preview unless `apply: true` comes with the `confirm` code of a preview of the same state), `verify` and `check_policy`. It works on the project in its current directory only.

## Session files

Each line of `sessions/*.jsonl` is one event (`src/store/session.ts`). The first `start` event carries `v`, the format version. `loadSession` folds events into the steps the timeline shows: `prompt`, `tool` (a `pre` merged with its `post`), `outside`, `change` (from `zerostel run`), `snapshot`, `restore`, `guard` (a rule fired), `home` (watched files changed), and `turn` markers with token usage.

## Tests

- `npm test` — unit and integration tests with real git in temp folders, including `test/security.test.ts` for hostile project contents.
- `npm run smoke` — the built CLI end to end in a temp folder, with hooks invoked the way each agent invokes them on the current OS. CI runs both on Linux, macOS and Windows with Node 20, 22, 24 and 26.
