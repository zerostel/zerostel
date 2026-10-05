# Security

Zerostel runs locally, reads your agents' hook payloads and transcripts, and stores snapshots of your project files in `~/.zerostel`. If you find a way it could leak data, damage files outside what a rewind should touch, get around a guardrail it promises to enforce, make a session log verify after it was changed, or be abused by a malicious repository, please report it privately rather than in a public issue.

## Reporting a vulnerability

- The "Report a vulnerability" button on this repository's [Security tab](https://github.com/zerostel/zerostel/security/advisories/new), or
- email security@zerostel.com.

Please include the version (`zerostel --version`), your OS, the agent and its version if hooks are involved, steps to reproduce, and what an attacker gains. You'll hear back within three working days. Confirmed problems are fixed in a patch release as quickly as their severity calls for, and published as a GitHub security advisory that credits you, unless you'd rather not be named. Please keep the details private until the fix is released, or for 90 days, whichever comes first.

## Supported versions

Security fixes go into the latest release. Zerostel is at 0.x, so upgrade rather than wait for a backport: `npm i -g zerostel@latest`, or the newest executable from [Releases](https://github.com/zerostel/zerostel/releases).

| Version | Gets security fixes |
|---|---|
| 0.1.x | ✅ |

## Checking a release

- The npm package is published from this repository's release workflow with provenance, which its npm page shows; in a project that depends on it, `npm audit signatures` checks it.
- Each executable has a build attestation: `gh attestation verify <file> --repo zerostel/zerostel`. Every release also lists the files' hashes in `SHA256SUMS`.

## Not a vulnerability on its own

What Zerostel doesn't claim: it isn't a sandbox, guardrails only match what a tool call names, and someone using your own account can read `~/.zerostel/audit.key`. The [Limits](README.md#limits) section lists the rest.
