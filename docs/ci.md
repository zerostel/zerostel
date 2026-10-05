# Zerostel in CI

Agents increasingly run unattended: in GitHub Actions, on a schedule, on every issue. The Zerostel action records such a run, applies your guardrails, writes the timeline into the job summary and attaches the session report to the workflow run.

```yaml
name: Agent fixes the build
on: workflow_dispatch

permissions:
  contents: read

jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zerostel/zerostel@v0
        with:
          agent: claude-code            # hook it in: every tool call recorded and checked
          policy: .github/zerostel-policy.json
          run: claude -p "make npm test pass" --permission-mode acceptEdits
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Inputs

| Input | Default | |
|---|---|---|
| `run` | (required) | The command to run. |
| `agent` | `none` | `claude-code` or `codex` installs the hooks first, so each tool call is recorded and checked against the policy. `none` records file changes only, with `zerostel run`. |
| `policy` | | A `policy.json` in the repository, used as the guardrails for this run. |
| `report` | `share` | `share` leaves prompts, commands, output and diffs out of the report; `full` keeps them (mind who can download artifacts); `none` skips it. |
| `version` | `latest` | Pin a version for reproducible runs. |

The timeline and the `zerostel verify` result go to the job summary; the report is uploaded as the `zerostel-report` artifact. The `report` output holds its path.

## Security notes

- Inputs reach the shell through environment variables only, so text from a PR title or branch name can't become part of the script.
- Zerostel is installed with `--ignore-scripts`, and releases carry npm provenance.
- A deny rule stops the tool call inside the agent; the run continues and the block shows in the timeline. To fail the job on a block, check the summary or the report in a later step.
- Codex asks to approve new hooks the first time; in CI, check that your Codex setup runs them non-interactively, or use `agent: none`.
- Keep `permissions` as narrow as the agent needs. The action itself only needs to read the repository.
