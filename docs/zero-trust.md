# Zero trust, in practice

The idea behind the name: don't trust an agent because it usually behaves. Assume it can go wrong, see everything it does, and keep a way back. What Zerostel does today:

| Principle | What it means here |
|---|---|
| **Assume breach** | A snapshot before and after every tool call that can change files. Undo any turn, rewind to any step, or go back to point zero. |
| **See everything** | Every prompt, tool call, command, file change, duration and token count, in one timeline per session. |
| **Verify the record** | Each log line is chained to the one before with a keyed hash. `zerostel verify` says which line was edited, removed or reordered. |
| **The recorder isn't the agent's** | The starter rules keep `~/.zerostel` off limits and ask you before an agent uninstalls Zerostel or edits its hook settings. Rules can be talked around; the log can't: if the hooks disappear mid-session, the next hook call records it. |
| **Least privilege, your rules** | Guardrails in `~/.zerostel/policy.json` block a tool call, or make the agent ask you first, before it runs. |
| **Limit the blast radius** | Rewinds cover the project, the files you list (like `~/.zshrc`) and, on Windows, user environment variables, and every rewind can itself be undone. What a rewind can't take back is asked about first (see the starter rules) or listed with the commands that would undo it. |
| **Trust nothing it reads** | Zerostel treats every project as hostile: it never runs programs found in it, never follows links out of it, and strips terminal escape codes. |

What it doesn't do: it isn't a sandbox. It can't undo network requests, deployments or database writes, and an agent running as you can still do what you can do. See the [limits](../README.md#limits).
