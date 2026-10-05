# Configuration

`~/.zerostel/config.json` (all keys optional):

```json
{
  "maxFileMB": 25,
  "snapshotTimeoutSec": 20,
  "retentionDays": 30,
  "exclude": ["data/**", "*.sqlite"],
  "watch": ["~/.zshrc", "~/.bashrc", "~/.gitconfig"]
}
```

- **`maxFileMB`** — new files above this size aren't snapshotted. The timeline says so.
- **`snapshotTimeoutSec`** — if one snapshot takes longer, snapshots pause for an hour in that project and the timeline keeps recording.
- **`exclude`** — git pathspec globs that are never snapshotted.
- **`watch`** — files under your home folder to snapshot and rewind along with every project (up to 1 MB each). A change to one shows up as its own step.

Guardrails live in their own file, `~/.zerostel/policy.json`: see [guardrails.md](guardrails.md).
