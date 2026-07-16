# Contributing to Vault Galaxy

Thanks for your interest! A few notes on how this project works:

## Bugs & feature ideas

Open a GitHub issue. Please include your vault size (rough note count), the view mode (galaxy/expand), and — for visual glitches — a screenshot. Issues are usually triaged within a couple of days.

## Pull requests

PRs are welcome for bug fixes and small improvements. For anything bigger, open an issue first so we can agree on the design — the physics layer in particular has some hard-won invariants (documented in code comments) that are easy to regress.

Ground rules:

- Plain JavaScript, no build step, no dependencies — that's a deliberate constraint, not an accident.
- No network calls, no telemetry. Ever.
- Test against a real vault before submitting. `harness/` contains a browser dev harness that runs the untouched plugin against a mock Obsidian API with your real link graph: `node harness/gen-data.js` (set `VAULT=/path/to/vault`), serve the repo root, open `harness/index.html`.

## Releases (maintainer)

Bump `manifest.json` + `versions.json`, commit, then `git tag x.y.z && git push origin x.y.z` — the GitHub workflow attests provenance and publishes the release.
