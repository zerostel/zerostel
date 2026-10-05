# FAQ

**How much does it slow the agent down?** Measured with [`scripts/bench.mjs`](../scripts/bench.mjs) on Windows 11 (a laptop i9), where starting processes is slowest:

| | 1,000 files | 10,000 files | 50,000 files |
|---|---|---|---|
| a tool call that only reads | 0.16 s | 0.16 s | 0.16 s |
| a tool call that edits (snapshot before and after) | 1.0 s | 1.2 s | 1.9 s |
| the first snapshot of a project, in the background | 3 s | 35 s | 5 min |

The first snapshot reads every file once; it starts as the session opens and the agent doesn't wait for it. Steps taken before it's done are recorded without one. Snapshots take roughly the size of the project, compressed, plus what changes. Run `npm run build && node scripts/bench.mjs` to measure your machine.

**Isn't git enough?** If you commit or stash at the right moments, git is a fine recovery tool. Agents change things between commits, often through shell commands, and nobody commits before every tool call. Zerostel does the equivalent automatically, in a repository of its own, so your history stays clean. Keep git and normal backups for durable history.

**What about jj?** Jujutsu snapshots the working copy whenever you run a `jj` command and has an operation log with undo. If your agents run jj at the right moments, it covers much of the same need. Zerostel adds the per-step timeline, guardrails and reports, and doesn't need anyone to run anything.

**Shouldn't this be built into the agent?** Several agents have checkpoints and permission rules, and if yours covers your workflow, use them. Zerostel is for when you want one record, one set of rules and one undo that work the same way across agents. They don't conflict.

**How is it different from snap-back or Entire?** snap-back also keeps shadow-git snapshots with undo. Entire links agent sessions to your commits. Zerostel ties snapshots to individual agent steps and adds the timeline, guardrails, a verifiable log, the web view and shareable reports.

**Is it a sandbox?** No. Guardrails stop the tool calls your rules name, and rewinds put files back. For untrusted code, also run the agent in a container or a separate account.

**Does undo reverse everything the agent did?** No. It puts captured files back: the project, and the files you listed under `watch`. Global packages a command installed or removed (npm, pip, Homebrew) show up as a step with the commands that would undo them; Zerostel lists them on rewind but never runs them. On Windows, user environment variables changed with `setx` and the like are put back. It doesn't undo network requests, deployments, database writes or changes to your real `.git`, and it doesn't rewind the agent's conversation. Rewind that in the agent too, or start a new session.

**Can I undo one agent while another keeps working?** Not safely. An undo restores the whole project (or the paths you give `--only`), including changes another agent or you made in the meantime. Preview with `--dry-run`, and give agents that run at the same time separate worktrees.

**How much disk does it use?** Identical content is stored once and compressed. `zerostel status` shows the total, and `zerostel prune` drops old sessions.

**Is the token count my bill?** No. It's read from the agent's transcript where the format is known, and shows "not captured" when it isn't. `zerostel run` can't see tokens at all. Your provider's dashboard is the source of truth.

**What does Zerostel keep, and where?** Everything stays on your machine; nothing is uploaded. `~/.zerostel` is readable only by you. The timeline keeps prompts, commands and the tail of command output. API keys, tokens and passwords are masked on a best-effort basis; don't rely on it for secrets in unusual formats. File contents live only in the snapshot repo. Reports leave `.env`-style files out, and `--share` leaves out prompts, commands, output and diffs entirely. File paths and timing stay in.

**How does it protect itself from the projects it records?** Zerostel treats the project as untrusted: file names can't turn into git options or patterns, links can't lead a snapshot or rewind outside the project, programs in the project folder are never started in place of git or the shell, and terminal escape codes in output are stripped. `zerostel ui` listens on 127.0.0.1 only and needs a random token from the link it prints. [security-model.md](security-model.md) explains what Zerostel protects and what it doesn't; see [SECURITY.md](../SECURITY.md) to report a problem.

**Why the name?** **Zero** trust + **Stella**, the stars. AI agents are multiplying like stars in the night sky; Zerostel is the single point they all come back to: a record you can check and a way back to point zero.
