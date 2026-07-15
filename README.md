# Vault Galaxy

A custom Obsidian graph view that renders the vault as a living 2D galaxy.
Design doc: `../DESIGN.md` (in the vault at `Projects/Vault Galaxy/DESIGN.md`).

- **Core notes** (`memory/core_*`, standing-orders, MEMORY.md, the TODO index) are gold suns clustered at the center, slowly rotating around the heaviest-linked one.
- **Hubs** (`memory/hub_*`) are orange stars orbiting their most-linked sun — more links = tighter orbit.
- **Notes** orbit their most-linked hub (or sun); unlinked notes drift in the halo or in per-folder satellite clusters (domains, Projects, Research, …).
- **Archive** is dim debris at the rim.
- Links draw as faint constellation lines; hovering a node lights up its constellation, slows time, and shows labels. Click opens the note.

Orbits are **choreographed, not simulated** — deterministic ellipses seeded by file-path hashes, so the layout is stable and collision-free by construction.

## Install (private plugin, no store)

Symlink or copy this folder to `<vault>/.obsidian/plugins/vault-galaxy/`, then enable "Vault Galaxy" in Settings → Community plugins. No build step — plain JS, zero dependencies.

## Files

- `manifest.json` — plugin manifest
- `main.js` — everything: model builder + canvas renderer + plugin shell
- `styles.css` — view chrome (controls, status line)
- `harness/` — browser test harness (mocks the Obsidian API, feeds real vault link data) for developing the visuals outside Obsidian
