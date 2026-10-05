# Security

Zerostel runs locally, reads your agents' hook payloads and transcripts, and stores snapshots of your project files in `~/.zerostel`. If you find a way it could leak data, damage files outside what a rewind should touch, get around a guardrail it promises to enforce, make a session log verify after it was changed, or be abused by a malicious repository, please report it privately rather than in a public issue:

- GitHub's "Report a vulnerability" button on this repository, or
- email security@zerostel.com.

Please include the version (`zerostel --version`), your OS, and steps to reproduce. You'll get an answer within a few days.

What Zerostel doesn't claim, so isn't a vulnerability on its own: it isn't a sandbox, guardrails only match what a tool call names, and someone using your own account can read `~/.zerostel/audit.key`. The [Limits](README.md#limits) section lists the rest.
