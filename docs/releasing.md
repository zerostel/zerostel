# Releasing

How a maintainer cuts a release. Zerostel ends up inside every user's agent hooks, so a hijacked release is the worst thing that can happen to it; the steps below are built around that.

## Once, before the first release

- **npm:** two-factor authentication on the account. Releases are built and staged by CI only, through npm trusted publishing, so no npm token exists anywhere, and each one goes live only when a maintainer approves it with 2FA. npm only lets a package that already exists name a trusted publisher, so the name was claimed with a placeholder `0.0.0` (no code) published by hand with 2FA and removed after the first release. The package's settings on npmjs.com name GitHub Actions, `zerostel/zerostel`, `release.yml` and the environment `npm` as its trusted publisher, with neither "Allow npm publish" nor "Allow npm dist-tag", so CI can only stage. Its publishing access is "Require two-factor authentication and disallow bypass 2fa tokens".
- **The `npm` environment** (Settings → Environments): requires a reviewer and is limited to `v*` tags. It holds no secrets.
- **Tags:** a tag ruleset protecting `v*`, so only maintainers can create release tags and none can be moved or deleted.
- **Package repositories:** `zerostel/homebrew-tap` (`Formula/`) and `zerostel/scoop-bucket` (`bucket/`).

## Every release

1. Update `version` in `package.json` and `CHANGELOG.md`, then run `node scripts/plugin.mjs` so every plugin manifest and `server.json` carry the same version (a test checks this). Commit.
2. Check locally:

   ```bash
   npm run typecheck && npm test && npm run smoke
   ```

3. Tag the commit on `main` and push the tag. This is what starts the release:

   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```

4. The `Release` workflow then runs:
   - `build`: checks that the tag is on `main` and matches `package.json`, runs the tests, builds, and packs the tarball. It holds no secrets.
   - `publish`: waits for a reviewer to approve the `npm` environment, then stages the tarball on npm with provenance and `--ignore-scripts`, using the short-lived credential npm trusted publishing gives it. It runs no project code.
   - `manifests`: computes the Homebrew formula and Scoop manifest from the staged tarball.
   - `standalone`: builds the executables with Node inside for Linux, macOS and Windows on x64 and arm64.
   - `release-assets`: checks it has exactly the six expected archives, writes `SHA256SUMS`, signs each archive's build provenance, and creates a **draft** GitHub release. It runs no project code.
5. On npmjs.com, open the package's **Staged Packages** tab, check the version and its files, and approve it with 2FA (or `npm stage list zerostel`, then `npm stage approve <id>`). Only now is it on npm.
6. Review the draft release and publish it.
7. Move the `v0` tag the GitHub Action is used by (`uses: zerostel/zerostel@v0`) to the release. The `Release` workflow only runs for full version tags, so this starts nothing:

   ```bash
   git tag -f v0 v0.1.0 && git push -f origin v0
   ```

8. Check that the formula's hash matches what npm now serves (`node scripts/release-manifests.mjs <version>` prints it), then commit the formula to the tap and the manifest to the bucket (artifact `package-manifests`).
9. Update the MCP Registry entry: Actions → **MCP Registry** → Run workflow. It logs in with the run's GitHub OIDC token, which the registry accepts for `io.github.zerostel/*`, so no token is involved. (`mcp-publisher login github` on a laptop only grants a personal namespace unless the registry's GitHub App can see the organization.)

Users can check a downloaded executable with `gh attestation verify <file> --repo zerostel/zerostel`.

## Where each package lives

| Channel | Files | Installed with |
|---|---|---|
| npm | the tarball | `npm i -g zerostel`, `npx zerostel` |
| Homebrew, Scoop | `packaging/` templates, filled in by `manifests` | `brew install zerostel/tap/zerostel`, `scoop install zerostel` |
| Executables | GitHub release assets | download, then `zerostel install` |
| Claude Code plugin | `.claude-plugin/`, `hooks/claude-code.json`, `skills/` | `/plugin marketplace add zerostel/zerostel` |
| Codex plugin | `plugin.json`, `skills/` | `codex plugin marketplace add zerostel/zerostel` |
| Antigravity plugin | `plugin.json`, `skills/` | `agy plugin install https://github.com/zerostel/zerostel` |
| Gemini CLI extension | `gemini-extension.json`, `skills/` | `gemini extensions install https://github.com/zerostel/zerostel`; the `gemini-cli-extension` topic lists it in the gallery |
| MCP Registry | `server.json`, `mcpName` in `package.json` | MCP clients that read the registry |
| GitHub Action | `action.yml` | `uses: zerostel/zerostel@v0` |

Claude Code's plugin hooks live in `hooks/claude-code.json` rather than `hooks/hooks.json`, because Codex and Gemini CLI load that path from any plugin and would run them under their own name. No plugin starts the MCP server by itself.

## Website

`site/` is static and deploys as is (Cloudflare Pages, with `site/_headers` for the security headers). See `site/README.md`.
