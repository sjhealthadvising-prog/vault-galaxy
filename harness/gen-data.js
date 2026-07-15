#!/usr/bin/env node
'use strict';
// Generate harness/vault-data.json from the real vault: markdown file list +
// an approximation of Obsidian's resolvedLinks ([[wikilink]] resolution by
// basename, first match wins). Good enough for visual development.
const fs = require('fs');
const path = require('path');

const VAULT = process.env.VAULT || path.join(process.env.HOME, 'Claude');
const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash']);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name.endsWith('.md')) files.push(path.relative(VAULT, full));
  }
})(VAULT);

// basename (lowercase, no .md) -> path (first wins, like Obsidian's shortest-path-ish default)
const byName = new Map();
for (const f of files) {
  const key = path.basename(f, '.md').toLowerCase();
  if (!byName.has(key)) byName.set(key, f);
}

const bySet = new Set(files);
function resolveTarget(raw, fromFile) {
  let t = raw.trim();
  try { t = decodeURIComponent(t); } catch { /* keep as-is */ }
  t = t.replace(/^<|>$/g, '').replace(/^~\/Claude\//, '').replace(/^\.\//, '');
  if (!t || /^[a-z]+:\/\//i.test(t)) return null; // external URL
  if (!t.endsWith('.md')) t += '.md';
  // 1. relative to the linking file's folder
  const rel = path.normalize(path.join(path.dirname(fromFile), t));
  if (bySet.has(rel)) return rel;
  // 2. vault-absolute
  if (bySet.has(t)) return t;
  // 3. basename fallback (Obsidian shortest-path behavior)
  return byName.get(path.basename(t, '.md').toLowerCase()) || null;
}

const resolved = {};
const wikiRe = /\[\[([^\]|#\n]+)/g;
const mdRe = /\]\((<[^)>]+\.md(?:#[^)>]*)?>|[^)\s#]+\.md)(?:#[^)]*)?\)/g;
for (const f of files) {
  let text;
  try { text = fs.readFileSync(path.join(VAULT, f), 'utf8'); } catch { continue; }
  const add = (dst) => {
    if (!dst || dst === f) return;
    (resolved[f] = resolved[f] || {})[dst] = (resolved[f][dst] || 0) + 1;
  };
  let m;
  while ((m = wikiRe.exec(text))) {
    let target = m[1].trim().toLowerCase().replace(/\.md$/, '');
    if (target.includes('/')) target = target.split('/').pop();
    add(byName.get(target));
  }
  while ((m = mdRe.exec(text))) add(resolveTarget(m[1], f));
}

const out = path.join(__dirname, 'vault-data.json');
fs.writeFileSync(out, JSON.stringify({ files, resolved }));
const nLinks = Object.values(resolved).reduce((s, o) => s + Object.keys(o).length, 0);
console.log(`wrote ${out}: ${files.length} files, ${nLinks} resolved link pairs`);
