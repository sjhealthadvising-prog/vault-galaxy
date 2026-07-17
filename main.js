'use strict';

/* Vault Galaxy 1.1.2 — your vault as a living orbital galaxy.
 *
 * Core idea: choreographed orbits, not simulated gravity. Every node gets an
 * assigned parent, radius, speed and phase -> deterministic ellipses that read
 * as physics and can never destabilize. Orbit radius encodes link strength
 * (more linked = tighter orbit). Layout is seeded by file-path hashes, so the
 * galaxy looks the same every time you open it.
 *
 * On top of the orbits sits a coupled displacement field: grab any node and
 * drag it — its linked neighbors are tugged toward it (spring stiffness scales
 * with link weight); release and the disturbed web wobbles back to rest.
 */

const { Plugin, ItemView, TFile, Notice, PluginSettingTab, Setting } = require('obsidian');

const VIEW_TYPE = 'vault-galaxy-view';
const GOLDEN = 2.399963229728653; // golden angle, for collision-free phase spacing

// fixed tiers; folder groups get palette colors (overridable in the view panel)
const TIERS = {
  core:    { color: '#ffd54a', label: 'core' },
  hub:     { color: '#ff9d2e', label: 'hub' },
  other:   { color: '#93a4b8', label: 'misc' },
  archive: { color: '#5c6470', label: 'archive' },
};
const GROUP_PALETTE = [
  '#9fc7a5', '#b18cff', '#5fdd8f', '#59c2f0', '#e88bc4', '#43d9c0',
  '#f2a65a', '#8fa8ff', '#d4c95a', '#f28b8b', '#7fd0c0', '#c39bd3',
];
const MAX_GROUPS = 12;

// Kepler-ish speed constants per tier: omega = K / r^1.5  (rad/s at speed 1x)
const SPEED_K = { core: 46, hub: 210, leaf: 64, anchor: 260, archive: 200, disc: 335 };

// displacement-field physics (the interactive grab/ripple layer).
// Damping is NOT a constant: each node gets a damping coefficient scaled to
// its own total stiffness and mass (c = zeta * 2 * sqrt(k_total * m)), so
// every node shares one designed damping ratio (the "bounciness" setting)
// instead of inheriting whatever its link count implies. Mass follows tier:
// suns lumber and carry momentum, dust gets whipped around.
const PHYS = {
  K_HOME: 14,   // home spring toward the natural orbit
  K_LINK: 7,    // per-link coupling spring (scaled by link weight)
  F_CAP: 1500,  // per-node force clamp (stability guard, not a tuning knob)
  V_CAP: 900,   // velocity clamp — also the max throw speed
  MASS: { sun: 10, hub: 3.5, note: 1, archive: 0.8 },
};

// galaxy-mode disc: unlinked notes seeded along spiral arms that shear
// naturally under differential rotation
const DISC_TWIST = 0.0045;   // rad per world-unit of radius
const DISC_INNER = 240;
const DISC_SPAN = 560;

const DEFAULT_SETTINGS = {
  // --- vault structure rules (Settings tab). Empty = auto-detect.
  coreRules: '',      // one glob per line, e.g. "notes/core_*" — these become suns
  hubRules: '',       // one glob per line — these become orange hub stars
  archiveFolders: '', // one folder per line — rendered as dim rim debris
  folderGroups: '',   // one folder per line for colored clusters; empty = top-level folders
  // --- view
  mode: 'galaxy',     // 'galaxy' | 'expand'
  gravity: 1,         // orbit tightness; radii /= g, omega *= g^1.5 (Kepler-consistent)
  bounciness: 0.6,    // 0 = grabbed nodes return dead, 1 = long pendulum ring (damping ratio)
  speed: 1,           // rotation speed multiplier
  arms: 3,            // spiral arms (galaxy mode)
  nodeSize: 1,        // node radius multiplier
  sunLabels: true,    // core names always on; off = fade in on zoom like everything else
  labelZoom: 1,       // label fade threshold: higher = must zoom in further before names appear
  glow: 1,            // glow intensity (0 disables the glow pass)
  linkWidth: 1,       // constellation line thickness
  linkAlpha: 1,       // constellation line brightness
  colors: {},         // per-tier/per-group overrides, e.g. { core: '#ffd54a', 'g:Projects': '#5fdd8f' }
};

/* ------------------------------------------------- structure rules */

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function compileGlobs(text) {
  const pats = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const res = pats.map((p) => new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '(\\.md)?$'));
  return (path) => res.some((r) => r.test(path));
}

function compileFolders(text) {
  const dirs = String(text || '').split(/\n+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return (path) => dirs.find((d) => path === d || path.startsWith(d + '/')) || null;
}

// --- deterministic per-path randomness so the layout is stable across opens
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand01(seed) { // one-shot mulberry32 step
  let t = (seed + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function prettify(path) {
  let n = path.split('/').pop().replace(/\.md$/, '');
  n = n.replace(/^core_/, '').replace(/^hub_/, '').replace(/[_-]+/g, ' ');
  return n.length > 30 ? n.slice(0, 29) + '…' : n;
}

/* ------------------------------------------------------------------ model */

function buildModel(app, settings) {
  const mode = settings.mode === 'expand' ? 'expand' : 'galaxy';
  const isArchive = compileFolders(settings.archiveFolders);
  const isCore = compileGlobs(settings.coreRules);
  const isHub = compileGlobs(settings.hubRules);
  const groupOf = compileFolders(settings.folderGroups);
  const autoGroups = !String(settings.folderGroups || '').trim();

  const files = app.vault.getMarkdownFiles();
  const resolved = app.metadataCache.resolvedLinks || {};

  const nodes = new Map(); // path -> node
  for (const f of files) {
    let tier;
    if (isArchive(f.path)) tier = 'archive';
    else if (isCore(f.path)) tier = 'core';
    else if (isHub(f.path)) tier = 'hub';
    else {
      const g = groupOf(f.path);
      if (g) tier = 'g:' + g;
      else if (autoGroups && f.path.includes('/')) tier = 'g:' + f.path.split('/')[0];
      else tier = 'other';
    }
    nodes.set(f.path, {
      path: f.path, tier, label: prettify(f.path), seed: hash32(f.path),
      bytes: (f.stat && f.stat.size) || 0,
      wdeg: 0, adj: new Map(), // path -> weight
      parent: null, children: [],
      orbitR: 0, omega: 0, phase: 0, theta: 0, x: 0, y: 0, drawR: 3,
      ox: 0, oy: 0, vx: 0, vy: 0, // grab-offset + spring velocity (world units)
      nx: 0, ny: 0, fx: 0, fy: 0, // natural position + coupling force accumulators
      isAnchor: false,
    });
  }

  // cap folder groups: keep the MAX_GROUPS largest, everything else -> misc
  const groupCounts = new Map();
  for (const n of nodes.values()) {
    if (n.tier.startsWith('g:')) groupCounts.set(n.tier, (groupCounts.get(n.tier) || 0) + 1);
  }
  const keptGroups = [...groupCounts.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GROUPS).map(([k]) => k);
  const keptSet = new Set(keptGroups);
  for (const n of nodes.values()) {
    if (n.tier.startsWith('g:') && !keptSet.has(n.tier)) n.tier = 'other';
  }
  // stable palette assignment: sorted group keys -> palette order
  const groupColors = new Map();
  [...keptGroups].sort().forEach((k, i) => groupColors.set(k, GROUP_PALETTE[i % GROUP_PALETTE.length]));

  // undirected weighted adjacency from resolved links
  const edges = [];
  for (const src in resolved) {
    const a = nodes.get(src);
    if (!a) continue;
    for (const dst in resolved[src]) {
      const b = nodes.get(dst);
      if (!b || src === dst) continue;
      const w = resolved[src][dst];
      a.adj.set(dst, (a.adj.get(dst) || 0) + w);
      b.adj.set(src, (b.adj.get(src) || 0) + w);
    }
  }
  const seenPair = new Set();
  for (const n of nodes.values()) {
    for (const [other, w] of n.adj) {
      const key = n.path < other ? n.path + ' ' + other : other + ' ' + n.path;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      edges.push({ a: n.path, b: other, w });
    }
    n.wdeg = [...n.adj.values()].reduce((s, v) => s + v, 0);
  }

  const weightTo = (n, m2) => (n.adj.get(m2.path) || 0);
  const bestParent = (n, candidates) => {
    let best = null, bw = 0;
    for (const c of candidates) { const w = weightTo(n, c); if (w > bw) { bw = w; best = c; } }
    return { best, bw };
  };
  const adopt = (child, parent) => { child.parent = parent; parent.children.push(child); };
  const setOrbit = (n, r, K, phase) => {
    n.orbitR = r; // base radius; the view scales it live by gravity
    const vary = 0.9 + 0.2 * rand01(n.seed ^ 0xA5A5);
    n.omega = (K / Math.pow(Math.max(r, 8), 1.5)) * vary;
    n.phase = phase;
    n.theta = phase; // advanced incrementally each frame
  };

  // --- suns: rule-matched core notes, else auto-detect the most-linked notes
  const ranked = [...nodes.values()].filter((n) => !n.isAnchor && n.tier !== 'archive')
    .sort((a, b) => b.wdeg - a.wdeg);
  let suns = ranked.filter((n) => n.tier === 'core');
  if (suns.length === 0) {
    suns = ranked.slice(0, 5).filter((n) => n.wdeg > 0);
    if (suns.length === 0) suns = ranked.slice(0, 1); // empty-link vault: one lonely star
    suns.forEach((n) => { n.tier = 'core'; });
  }
  suns.sort((a, b) => b.wdeg - a.wdeg);
  const central = suns[0];
  central.parent = null; central.orbitR = 0; central.omega = 0;
  for (let i = 1; i < suns.length; i++) {
    const ring = Math.floor((i - 1) / 4);
    const r = 115 + ring * 85 + (i % 2) * 14;
    adopt(suns[i], central);
    setOrbit(suns[i], r, SPEED_K.core, ((i - 1) % 4) * (Math.PI / 2) + ring * 0.45 + rand01(suns[i].seed) * 0.3);
  }
  const sunSet = new Set(suns.map((s) => s.path));

  // --- hubs: rule-matched, else auto-detect the next most-linked notes
  let hubs = [...nodes.values()].filter((n) => n.tier === 'hub');
  if (hubs.length === 0) {
    hubs = ranked.filter((n) => !sunSet.has(n.path) && n.wdeg >= 4).slice(0, 8);
    hubs.forEach((n) => { n.tier = 'hub'; });
  }
  const hubKids = new Map(); // sun path -> [{hub, w}]
  for (const h of hubs) {
    const { best, bw } = bestParent(h, suns);
    const sun = best || central;
    if (!hubKids.has(sun.path)) hubKids.set(sun.path, []);
    hubKids.get(sun.path).push({ h, w: bw });
  }
  for (const [sunPath, list] of hubKids) {
    const sun = nodes.get(sunPath);
    list.sort((x, y) => y.w - x.w);
    list.forEach(({ h }, idx) => {
      adopt(h, sun);
      setOrbit(h, 95 + 40 * idx, SPEED_K.hub, idx * GOLDEN + rand01(h.seed) * 0.5);
    });
  }
  const hubSet = new Set(hubs.map((h) => h.path));

  // --- category anchors (invisible) for satellite clusters, on an outer ring
  //     (expand mode only; galaxy mode spreads unlinked notes into the disc)
  const anchors = new Map(); // group tier -> anchor node
  const present = mode === 'expand'
    ? [...keptGroups, 'other'].filter((t) => [...nodes.values()].some((n) => n.tier === t && !n.isAnchor))
    : [];
  present.forEach((t, i) => {
    const a = {
      path: ' anchor:' + t, tier: t,
      label: t.startsWith('g:') ? t.slice(2).split('/').pop() : TIERS[t] ? TIERS[t].label : t,
      seed: hash32('anchor' + t),
      wdeg: 0, adj: new Map(), parent: null, children: [], isAnchor: true,
      orbitR: 0, omega: 0, phase: 0, theta: 0, x: 0, y: 0, drawR: 0,
      ox: 0, oy: 0, vx: 0, vy: 0, nx: 0, ny: 0, fx: 0, fy: 0,
    };
    adopt(a, central);
    setOrbit(a, 560 + (i % 2) * 90, SPEED_K.anchor, (i / present.length) * 2 * Math.PI + rand01(a.seed) * 0.4);
    anchors.set(t, a);
    nodes.set(a.path, a);
  });

  // --- everything else: orbit best-linked hub, else best-linked sun, else the
  //     group anchor (expand) or the spiral disc (galaxy)
  const leafCount = new Map(); // parent path -> count so far (for sunflower spacing)
  const placeLeaf = (n, parent, tight) => {
    const idx = leafCount.get(parent.path) || 0;
    leafCount.set(parent.path, idx + 1);
    const grow = tight ? 8 : 11;
    const base = tight ? 42 : parent.isAnchor ? 20 : 24;
    adopt(n, parent);
    setOrbit(n, base + grow * Math.sqrt(idx) + rand01(n.seed ^ 7) * 4, SPEED_K.leaf, idx * GOLDEN + rand01(n.seed) * 0.4);
  };

  for (const n of nodes.values()) {
    if (n.parent || n === central || n.isAnchor) continue;
    if (n.tier === 'archive') {
      adopt(n, central);
      setOrbit(n, 760 + rand01(n.seed) * 90, SPEED_K.archive, rand01(n.seed ^ 99) * 2 * Math.PI);
      continue;
    }
    const asHubChild = bestParent(n, hubs);
    if (asHubChild.bw > 0) { placeLeaf(n, asHubChild.best, false); continue; }
    const asSunChild = bestParent(n, suns);
    if (asSunChild.bw > 0) { placeLeaf(n, asSunChild.best, true); continue; }
    if (mode === 'expand') {
      placeLeaf(n, anchors.get(n.tier) || anchors.get('other') || central, false);
    } else {
      // galaxy disc: denser toward the center, seeded on spiral arms
      const u = rand01(n.seed ^ 5);
      const r = DISC_INNER + DISC_SPAN * Math.pow(u, 1.6); // density falls off with radius
      const nArms = Math.max(1, settings.arms || 3);
      const arm = n.seed % nArms;
      const phase = arm * (2 * Math.PI / nArms) + r * DISC_TWIST + (rand01(n.seed ^ 11) - 0.5) * 0.6;
      adopt(n, central);
      setOrbit(n, r, SPEED_K.disc, phase);
    }
  }

  // --- draw radii: content-sized within strict tier bands. A fat note can
  //     never outgrow the tier above it (hierarchy beats content). Sizes are
  //     RANK-normalized within each tier: smallest file -> band min, largest
  //     -> band max, so every tier shows its full visual spread.
  const bandOf = (n) => {
    if (sunSet.has(n.path)) return 'sun';
    if (hubSet.has(n.path)) return 'hub';
    if (n.tier === 'archive') return 'archive';
    return 'note';
  };
  const BANDS = { sun: [12, 26], hub: [5.5, 11], note: [1.6, 5.0], archive: [1.0, 2.2] };
  const groups = { sun: [], hub: [], note: [], archive: [] };
  for (const n of nodes.values()) {
    if (n.isAnchor) { n.drawR = 0; continue; }
    groups[bandOf(n)].push(n);
  }
  for (const key of Object.keys(groups)) {
    const g = groups[key].sort((a, b) => a.bytes - b.bytes);
    const [lo, hi] = BANDS[key];
    g.forEach((n, i) => {
      const f = g.length > 1 ? i / (g.length - 1) : 0.7;
      n.drawR = lo + (hi - lo) * f;
    });
  }

  // --- physics precompute: per-node mass (by tier) and total stiffness
  //     (home spring + every coupling spring touching the node), so the view
  //     can hold one designed damping ratio across the whole galaxy.
  for (const n of nodes.values()) {
    n.mass = n.isAnchor ? 1 : (PHYS.MASS[bandOf(n)] || 1);
    n.kTotal = PHYS.K_HOME;
  }
  for (const e of edges) {
    e.k = PHYS.K_LINK * Math.min(1, e.w / 2);
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (a) a.kTotal += e.k;
    if (b) b.kTotal += e.k;
  }

  // gravity is applied LIVE by the view each frame (r/g, omega*g^1.5), so the
  // slider feels analog instead of rebuilding to snapped positions.
  return { nodes, edges, central, suns, sunSet, hubSet, groupColors };
}

/* ------------------------------------------------------------------- view */

class GalaxyView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.model = null;
    this.raf = 0;
    this.T = 0;               // accumulated sim time
    this.lastTs = 0;
    this.timeScale = 1;
    this.paused = false;
    this.linkMode = 'auto';   // resolved to 'all' | 'hover' at build
    this.gLive = this.settings.gravity; // eased toward the slider each frame
    this._nodeDrag = null;
    this.cam = { scale: 0.5, offX: 0, offY: 0 };
    this.hover = null;
    this.hoverSet = null;
    this.dash = 0;
    this.stars = null;
    this.glowCache = new Map();
    this._resolvedOnce = false;
    this._drag = null;
  }

  get settings() { return this.plugin.settings; }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Vault Galaxy'; }
  getIcon() { return 'orbit'; }

  saveSettings() { this.plugin.saveSettings(); }

  colorOf(tier) {
    const s = this.settings.colors[tier];
    if (s) return s;
    if (TIERS[tier]) return TIERS[tier].color;
    return (this.model && this.model.groupColors.get(tier)) || '#93a4b8';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('vault-galaxy-root');

    this.canvas = root.createEl('canvas', { cls: 'vg-canvas' });
    this.ctx = this.canvas.getContext('2d');

    const controls = root.createDiv({ cls: 'vg-controls' });
    this.btnMode = controls.createEl('button', { text: this.settings.mode });
    this.btnPause = controls.createEl('button', { text: '⏸' });
    this.btnSpeed = controls.createEl('button', { text: '1×' });
    this.btnLinks = controls.createEl('button', { text: 'links' });
    this.btnFit = controls.createEl('button', { text: '⤢ fit' });
    this.btnRebuild = controls.createEl('button', { text: '↻' });
    this.btnGear = controls.createEl('button', { text: '⚙' });
    this.statusEl = root.createDiv({ cls: 'vg-status' });

    this.registerDomEvent(this.btnMode, 'click', () => {
      this.settings.mode = this.settings.mode === 'galaxy' ? 'expand' : 'galaxy';
      this.saveSettings();
      this.btnMode.setText(this.settings.mode);
      this.build();
    });
    this.registerDomEvent(this.btnPause, 'click', () => {
      this.paused = !this.paused;
      this.btnPause.setText(this.paused ? '▶' : '⏸');
    });
    this.registerDomEvent(this.btnSpeed, 'click', () => {
      const s = this.settings.speed;
      this.settings.speed = s < 1 ? 1 : s < 2 ? 2 : 0.5;
      this.saveSettings();
      this.syncSpeedUI();
    });
    this.registerDomEvent(this.btnLinks, 'click', () => {
      this.linkMode = this.linkMode === 'all' ? 'hover' : 'all';
      this.btnLinks.setText('links: ' + this.linkMode);
    });
    this.registerDomEvent(this.btnFit, 'click', () => this.fitView());
    this.registerDomEvent(this.btnRebuild, 'click', () => { this.build(); new Notice('Galaxy rebuilt'); });
    this.registerDomEvent(this.btnGear, 'click', () => {
      this.panelEl.classList.toggle('vg-open');
    });

    this.registerDomEvent(this.canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(this.canvas, 'pointerdown', (e) => this.onPointerDown(e));
    this.registerDomEvent(this.canvas, 'pointermove', (e) => this.onPointerMove(e));
    this.registerDomEvent(this.canvas, 'pointerup', (e) => this.onPointerUp(e));
    this.registerDomEvent(this.canvas, 'pointerleave', () => {
      this._nodeDrag = null; // released off-canvas: spring home
      this.hover = null; this.hoverSet = null;
    });

    // if the metadata cache finishes resolving after we open (cold app start),
    // rebuild once so the galaxy isn't sparse
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      if (!this._resolvedOnce) { this._resolvedOnce = true; this.build(); }
    }));

    this.syncSpeedUI();
    this.build();
    this.buildPanel(root);
    this.resizeCanvas();
    this.fitView();
    // re-measure whenever the pane's size actually changes (covers late layout,
    // sidebar drags, window resizes)
    this._ro = new ResizeObserver(() => {
      this.resizeCanvas();
      if (!this._userMoved) this.fitView();
    });
    this._ro.observe(this.contentEl);
    this.lastTs = performance.now();
    const loop = (ts) => { this.frame(ts); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  async onClose() {
    cancelAnimationFrame(this.raf);
    if (this._ro) this._ro.disconnect();
  }

  onResize() {
    this.resizeCanvas();
  }

  syncSpeedUI() {
    this.btnSpeed.setText((Math.round(this.settings.speed * 10) / 10) + '×');
    if (this._speedSlider) this._speedSlider.value = this.settings.speed;
  }

  buildPanel(root) {
    if (this.panelEl) this.panelEl.remove();
    const panel = root.createDiv({ cls: 'vg-panel' });
    this.panelEl = panel;

    const section = (title) => {
      panel.createEl('div', { cls: 'vg-sec', text: title });
    };
    const slider = (label, min, max, step, get, onInput, rebuilds) => {
      const row = panel.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: label });
      const inp = row.createEl('input');
      inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = get();
      this.registerDomEvent(inp, 'input', () => {
        onInput(parseFloat(inp.value));
        this.saveSettings();
        if (rebuilds) this.build();
      });
      return inp;
    };
    const s = this.settings;

    section('Forces');
    slider('gravity', 0.5, 1.8, 0.01, () => s.gravity, (v) => { s.gravity = v; }, false);
    slider('bounciness', 0, 1, 0.05, () => (s.bounciness === undefined ? 0.6 : s.bounciness), (v) => { s.bounciness = v; }, false);
    this._speedSlider = slider('speed', 0, 3, 0.1, () => s.speed, (v) => { s.speed = v; this.syncSpeedUI(); }, false);
    slider('spiral arms', 1, 6, 1, () => s.arms, (v) => { s.arms = v; }, true);

    section('Display');
    {
      const row = panel.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'core names always on' });
      const inp = row.createEl('input');
      inp.type = 'checkbox'; inp.checked = s.sunLabels;
      this.registerDomEvent(inp, 'change', () => { s.sunLabels = inp.checked; this.saveSettings(); });
    }
    slider('node size', 0.5, 2.2, 0.05, () => s.nodeSize, (v) => { s.nodeSize = v; }, false);
    slider('label threshold', 0.3, 3, 0.05, () => s.labelZoom, (v) => { s.labelZoom = v; }, false);
    slider('glow', 0, 2, 0.05, () => s.glow, (v) => { s.glow = v; }, false);
    slider('link thickness', 0.4, 3, 0.1, () => s.linkWidth, (v) => { s.linkWidth = v; }, false);
    slider('link brightness', 0.2, 3, 0.1, () => s.linkAlpha, (v) => { s.linkAlpha = v; }, false);

    section('Colors');
    const colorKeys = ['core', 'hub',
      ...(this.model ? [...this.model.groupColors.keys()].sort() : []),
      'other', 'archive'];
    for (const tier of colorKeys) {
      const row = panel.createDiv({ cls: 'vg-row' });
      row.createEl('span', {
        text: tier.startsWith('g:') ? tier.slice(2).split('/').pop() : TIERS[tier].label,
      });
      const inp = row.createEl('input');
      inp.type = 'color'; inp.value = this.colorOf(tier);
      this.registerDomEvent(inp, 'input', () => {
        s.colors[tier] = inp.value;
        this.saveSettings();
      });
    }

    const reset = panel.createEl('button', { cls: 'vg-reset', text: 'reset to defaults' });
    this.registerDomEvent(reset, 'click', () => {
      const keepRules = {
        coreRules: s.coreRules, hubRules: s.hubRules,
        archiveFolders: s.archiveFolders, folderGroups: s.folderGroups,
      };
      this.plugin.settings = { ...DEFAULT_SETTINGS, colors: {}, ...keepRules };
      this.saveSettings();
      this.buildPanel(root);
      this.panelEl.classList.add('vg-open');
      this.syncSpeedUI();
      this.btnMode.setText(this.settings.mode);
      this.build();
    });
  }

  build() {
    try {
      this.model = buildModel(this.app, this.settings);
      if (this.linkMode === 'auto' || this.linkMode === 'all' || this.linkMode === 'hover') {
        const auto = this.model.edges.length > 2600 ? 'hover' : 'all';
        if (this.linkMode === 'auto') this.linkMode = auto;
        this.btnLinks.setText('links: ' + this.linkMode);
      }
      const nNotes = [...this.model.nodes.values()].filter((n) => !n.isAnchor).length;
      this.statusEl.setText(`${this.settings.mode} · ${nNotes} notes · ${this.model.edges.length} links · hover to inspect · click to open · drag to disturb`);
      if (!this.stars) this.makeStars();
    } catch (e) {
      console.error('[vault-galaxy] build failed', e);
      new Notice('Vault Galaxy: build failed — see console');
    }
  }

  makeStars() {
    this.stars = [];
    for (let i = 0; i < 420; i++) {
      const s = hash32('star' + i);
      this.stars.push({
        x: (rand01(s) - 0.5) * 3400,
        y: (rand01(s ^ 1) - 0.5) * 3400,
        r: 0.4 + rand01(s ^ 2) * 1.3,
        tw: 0.5 + rand01(s ^ 3) * 2,
        ph: rand01(s ^ 4) * 6.28,
      });
    }
  }

  resizeCanvas() {
    const rect = this.contentEl.getBoundingClientRect();
    this.w = Math.max(50, rect.width);
    this.h = Math.max(50, rect.height);
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
  }

  fitView() {
    const world = 930; // archive rim + margin
    this.cam.scale = Math.max(0.08, (Math.min(this.w, this.h) / (2 * world)) * 0.95);
    this.cam.offX = this.w / 2;
    this.cam.offY = this.h / 2;
  }

  /* ---- interaction */

  onWheel(e) {
    e.preventDefault();
    this._userMoved = true;
    const f = Math.exp(-e.deltaY * 0.0012);
    const ns = Math.min(6, Math.max(0.08, this.cam.scale * f));
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // zoom to cursor
    this.cam.offX = mx - ((mx - this.cam.offX) / this.cam.scale) * ns;
    this.cam.offY = my - ((my - this.cam.offY) / this.cam.scale) * ns;
    this.cam.scale = ns;
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.updateHover(e.clientX - rect.left, e.clientY - rect.top);
    if (this.hover && !this.hover.isAnchor) {
      // grab the node: drag it anywhere, throw it, gravity reels it home
      const n = this.hover;
      this._nodeDrag = {
        node: n, x: e.clientX, y: e.clientY, ox0: n.ox, oy0: n.oy, moved: false,
        lastX: e.clientX, lastY: e.clientY, lastT: performance.now(), tvx: 0, tvy: 0,
      };
      this._excited = true; // wake the coupled displacement field
      this.canvas.style.cursor = 'grabbing';
    } else {
      this._drag = { x: e.clientX, y: e.clientY, offX: this.cam.offX, offY: this.cam.offY, moved: false };
    }
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  }

  onPointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (this._nodeDrag) {
      const nd = this._nodeDrag;
      const dx = e.clientX - nd.x, dy = e.clientY - nd.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) nd.moved = true;
      nd.node.ox = nd.ox0 + dx / this.cam.scale;
      nd.node.oy = nd.oy0 + dy / this.cam.scale;
      nd.node.vx = nd.node.vy = 0; // held = kinematic
      // track flick velocity (world units/s, EMA over ~40ms) for throw-on-release
      const now = performance.now();
      const dtm = now - nd.lastT;
      if (dtm > 0) {
        const w = 1 - Math.exp(-dtm / 40);
        nd.tvx = nd.tvx * (1 - w) + (((e.clientX - nd.lastX) / this.cam.scale) / (dtm / 1000)) * w;
        nd.tvy = nd.tvy * (1 - w) + (((e.clientY - nd.lastY) / this.cam.scale) / (dtm / 1000)) * w;
        nd.lastX = e.clientX; nd.lastY = e.clientY; nd.lastT = now;
      }
      return;
    }
    if (this._drag) {
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) this._drag.moved = true;
      if (this._drag.moved) {
        this._userMoved = true;
        this.cam.offX = this._drag.offX + dx;
        this.cam.offY = this._drag.offY + dy;
        return;
      }
    }
    this.updateHover(mx, my);
  }

  onPointerUp(e) {
    if (this._nodeDrag) {
      const nd = this._nodeDrag;
      this._nodeDrag = null; // spring takes over from here
      this.canvas.style.cursor = 'pointer';
      if (!nd.moved && !nd.node.isAnchor) {
        const file = this.app.vault.getAbstractFileByPath(nd.node.path);
        if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
      } else if (nd.moved) {
        // throw: carry the flick velocity into the release (stale flick = plain drop)
        const clamp = (v) => Math.max(-PHYS.V_CAP, Math.min(PHYS.V_CAP, v));
        const stale = performance.now() - nd.lastT > 100;
        nd.node.vx = stale ? 0 : clamp(nd.tvx);
        nd.node.vy = stale ? 0 : clamp(nd.tvy);
      }
      return;
    }
    this._drag = null;
  }

  updateHover(mx, my) {
    if (!this.model) return;
    let best = null, bd = 1e9;
    for (const n of this.model.nodes.values()) {
      if (n.isAnchor) continue;
      const dx = n.sx - mx, dy = n.sy - my;
      const d = Math.hypot(dx, dy);
      const hitR = Math.max(7, n.drawR * this.settings.nodeSize * this.cam.scale + 4);
      if (d < hitR && d < bd) { bd = d; best = n; }
    }
    if (best !== this.hover) {
      this.hover = best;
      if (best) {
        this.hoverSet = new Set([best.path]);
        for (const p of best.adj.keys()) this.hoverSet.add(p);
      } else this.hoverSet = null;
      this.canvas.style.cursor = best ? 'pointer' : 'default';
    }
  }

  /* ---- rendering */

  glow(color, size) {
    const key = color + '|' + Math.round(size);
    let c = this.glowCache.get(key);
    if (!c) {
      const s = Math.max(4, Math.round(size));
      c = document.createElement('canvas');
      c.width = c.height = s * 2;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(s, s, 0, s, s, s);
      grad.addColorStop(0, color + 'cc');
      grad.addColorStop(0.35, color + '55');
      grad.addColorStop(1, color + '00');
      g.fillStyle = grad;
      g.fillRect(0, 0, s * 2, s * 2);
      if (this.glowCache.size > 300) this.glowCache.clear();
      this.glowCache.set(key, c);
    }
    return c;
  }

  frame(ts) {
    const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
    this.lastTs = ts;

    // eased time-scale: pause -> 0, hover -> slow-mo, else speed setting
    const target = this.paused ? 0 : (this.hover ? 0.15 : 1) * this.settings.speed;
    this.timeScale += (target - this.timeScale) * Math.min(1, dt * 6);
    this.T += dt * this.timeScale;
    this.dash -= dt * 26;

    const m = this.model;
    if (!m || !this.ctx) return;
    const { scale, offX, offY } = this.cam;
    const ctx = this.ctx;

    // live gravity: ease toward the slider, contract radii, speed up Kepler-style
    this.gLive += (Math.max(0.3, this.settings.gravity || 1) - this.gLive) * Math.min(1, dt * 4);
    const g15 = Math.pow(this.gLive, 1.5);
    const dtSim = dt * this.timeScale;

    // advance orbital positions, parents before children (BFS from center).
    // theta advances incrementally so gravity/speed changes never snap angles.
    // NATURAL positions (nx, ny) nest on the parent's NATURAL position —
    // displacement does NOT travel down the hierarchy; it travels along links.
    const stepNode = (n, pnx, pny) => {
      n.theta += n.omega * g15 * dtSim;
      const r = n.orbitR / this.gLive;
      n.nx = pnx + r * Math.cos(n.theta);
      n.ny = pny + r * Math.sin(n.theta);
    };
    stepNode(m.central, 0, 0); // orbitR 0 -> natural position is the origin
    const queue = [m.central];
    while (queue.length) {
      const p = queue.pop();
      for (const c of p.children) {
        stepNode(c, p.nx, p.ny);
        queue.push(c);
      }
    }

    // coupled displacement field: every node feels a home-spring back to its
    // natural orbit PLUS coupling springs along its links (stiffness ~ link
    // weight). Drag one node and its constellation is tugged toward it,
    // second-order neighbors less; release (or THROW) and the web swings —
    // pendulum overshoot, energy sloshing between neighbors — then re-rests.
    if (this._excited) {
      // bounciness -> damping ratio: 0 -> ~critically damped (dead return),
      // 1 -> zeta 0.08 (long ring). Default 0.6 -> zeta ~0.22, 4-5 swings.
      const b = this.settings.bounciness === undefined ? 0.6 : this.settings.bounciness;
      const zeta = Math.max(0.05, 0.9 * Math.pow(1 - b, 2) + 0.08);
      const total = Math.min(0.033, dt); // springs run on real time, even paused
      const steps = total > 0.02 ? 2 : 1; // sub-step big frames for stiff-node stability
      const sdt = total / steps;
      const clamp = (v, c) => (v > c ? c : v < -c ? -c : v);
      let energy = 0;
      for (let s = 0; s < steps; s++) {
        // accumulate SPRING forces only — damping is applied implicitly below,
        // outside the force cap, so friction survives even when the springs
        // saturate F_CAP (capped damping was an energy leak: violent throws
        // rang forever at high bounciness because the cap truncated friction).
        for (const n of m.nodes.values()) {
          n.fx = -PHYS.K_HOME * n.ox;
          n.fy = -PHYS.K_HOME * n.oy;
        }
        for (const e of m.edges) {
          const a = m.nodes.get(e.a), b2 = m.nodes.get(e.b);
          if (!a || !b2) continue;
          const dx = a.ox - b2.ox, dy = a.oy - b2.oy;
          if (!dx && !dy) continue;
          b2.fx += e.k * dx; b2.fy += e.k * dy;
          a.fx -= e.k * dx; a.fy -= e.k * dy;
        }
        energy = 0;
        for (const n of m.nodes.values()) {
          const held = this._nodeDrag && this._nodeDrag.node === n;
          if (!held) {
            // damping ratio applies to the HOME mode only — heavily-linked
            // nodes already dissipate by bleeding energy into their neighbors,
            // so scaling cD by kTotal double-penalized them into dead returns
            const cD = zeta * 2 * Math.sqrt(PHYS.K_HOME * n.mass);
            const damp = 1 / (1 + (cD / n.mass) * sdt); // implicit: unconditionally stable
            n.vx = clamp((n.vx + (clamp(n.fx, PHYS.F_CAP) / n.mass) * sdt) * damp, PHYS.V_CAP);
            n.vy = clamp((n.vy + (clamp(n.fy, PHYS.F_CAP) / n.mass) * sdt) * damp, PHYS.V_CAP);
            n.ox += n.vx * sdt; n.oy += n.vy * sdt;
          }
          energy += Math.abs(n.ox) + Math.abs(n.oy) + Math.abs(n.vx) + Math.abs(n.vy);
        }
      }
      if (!this._nodeDrag && energy < 8) {
        for (const n of m.nodes.values()) { n.ox = n.oy = n.vx = n.vy = 0; }
        this._excited = false;
      }
    }
    for (const n of m.nodes.values()) { n.x = n.nx + n.ox; n.y = n.ny + n.oy; }
    for (const n of m.nodes.values()) { n.sx = n.x * scale + offX; n.sy = n.y * scale + offY; }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#04050d';
    ctx.fillRect(0, 0, this.w, this.h);

    // starfield with parallax + twinkle
    ctx.fillStyle = '#c8d4ee';
    for (const s of this.stars) {
      const sx = s.x * scale * 0.35 + offX, sy = s.y * scale * 0.35 + offY;
      if (sx < -5 || sy < -5 || sx > this.w + 5 || sy > this.h + 5) continue;
      ctx.globalAlpha = 0.18 + 0.14 * Math.sin(ts / 1000 * s.tw + s.ph);
      ctx.beginPath();
      ctx.arc(sx, sy, s.r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const onScreen = (n, pad) =>
      n.sx > -pad && n.sy > -pad && n.sx < this.w + pad && n.sy < this.h + pad;

    // constellation lines
    const st = this.settings;
    if (this.linkMode === 'all') {
      ctx.strokeStyle = '#6f87c9';
      ctx.lineWidth = st.linkWidth;
      for (const e of m.edges) {
        const a = m.nodes.get(e.a), b = m.nodes.get(e.b);
        if (!a || !b) continue;
        if (!onScreen(a, 60) && !onScreen(b, 60)) continue;
        const modeDim = st.mode === 'galaxy' ? 0.45 : 1; // links whisper in galaxy mode
        ctx.globalAlpha = Math.min(0.85,
          Math.min(0.16, 0.05 + e.w * 0.02) * (this.hoverSet ? 0.35 : 1) * modeDim * st.linkAlpha);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (this.hover) {
      // hovered constellation, lit and gently flowing
      ctx.strokeStyle = '#cfe3ff';
      ctx.lineWidth = 1.4 * st.linkWidth;
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = this.dash;
      ctx.globalAlpha = 0.8;
      for (const [other] of this.hover.adj) {
        const b = m.nodes.get(other);
        if (!b) continue;
        ctx.beginPath(); ctx.moveTo(this.hover.sx, this.hover.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // glow pass (additive)
    if (st.glow > 0) {
      ctx.globalCompositeOperation = 'lighter';
      const glowSize = Math.sqrt(st.glow);
      for (const n of m.nodes.values()) {
        if (n.isAnchor || !onScreen(n, 80)) continue;
        const isSun = m.sunSet.has(n.path), isHub = m.hubSet.has(n.path);
        if (!isSun && !isHub && scale < 0.2) continue; // skip tiny glows when far out
        const dim = this.hoverSet && !this.hoverSet.has(n.path) ? 0.35 : 1;
        const pulse = isSun ? 1 + 0.05 * Math.sin(this.T * 0.9 + n.seed % 7) : 1;
        const gs = n.drawR * st.nodeSize * (isSun ? 5.5 : isHub ? 4.2 : 3) * scale * pulse * glowSize;
        const spr = this.glow(this.colorOf(n.tier), Math.min(160, gs));
        ctx.globalAlpha = (isSun ? 0.95 : isHub ? 0.8 : 0.5) * dim * Math.min(1, st.glow);
        ctx.drawImage(spr, n.sx - gs, n.sy - gs, gs * 2, gs * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // solid bodies
    for (const n of m.nodes.values()) {
      if (n.isAnchor || !onScreen(n, 30)) continue;
      const isSun = m.sunSet.has(n.path);
      const dim = this.hoverSet && !this.hoverSet.has(n.path) ? 0.3 : 1;
      const pulse = isSun ? 1 + 0.04 * Math.sin(this.T * 0.9 + n.seed % 7) : 1;
      const r = Math.max(0.7, n.drawR * st.nodeSize * scale * pulse);
      ctx.globalAlpha = dim;
      ctx.fillStyle = this.colorOf(n.tier);
      ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, 6.2832); ctx.fill();
      if (isSun) { // hot white center
        ctx.fillStyle = '#fff7d8';
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r * 0.45, 0, 6.2832); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // labels (screen space)
    const label = (n, font, alpha, dy) => {
      ctx.font = font;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#dde6f5';
      ctx.textAlign = 'center';
      ctx.fillText(n.label, n.sx, n.sy + dy);
    };
    const ls = scale / st.labelZoom; // label-gating zoom: threshold slider shifts when names appear
    for (const n of m.nodes.values()) {
      if (!onScreen(n, 40)) continue;
      const dimmed = this.hoverSet && !this.hoverSet.has(n.path);
      const inHover = this.hoverSet && this.hoverSet.has(n.path);
      if (n.isAnchor) {
        if (ls > 0.25 && !this.hoverSet) label(n, 'italic 11px sans-serif', 0.28, 4);
        continue;
      }
      const lr = n.drawR * st.nodeSize * scale;
      if (m.sunSet.has(n.path)) {
        if (st.sunLabels) {
          if (!dimmed) label(n, 'bold 12px sans-serif', 0.9, lr + 14);
        } else { // zoom-gated like the rest of the galaxy
          const a = Math.min(0.9, Math.max(0, (ls - 0.35) * 2.6));
          if ((a > 0.05 && !dimmed) || inHover) label(n, 'bold 12px sans-serif', inHover ? 0.95 : a, lr + 14);
        }
      } else if (m.hubSet.has(n.path)) {
        const a = Math.min(0.8, Math.max(0, (ls - 0.18) * 2.6));
        if ((a > 0.05 && !dimmed) || inHover) label(n, '11px sans-serif', inHover ? 0.9 : a, lr + 12);
      } else if (inHover || ls > 1.1) {
        // ramp saturates by ls≈1.9 so max zoom is fully readable even with the
        // label threshold maxed (scale 6 / threshold 3 -> ls 2)
        if (!dimmed) label(n, '10px sans-serif', inHover ? 0.85 : Math.min(0.85, (ls - 1.1) * 1.1), lr + 10);
      }
    }
    ctx.globalAlpha = 1;

    // hover tooltip: full path, bottom-center
    if (this.hover) {
      ctx.font = '11px sans-serif';
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = '#aebedd';
      ctx.textAlign = 'center';
      ctx.fillText(this.hover.path, this.w / 2, this.h - 10);
      ctx.globalAlpha = 1;
    }
  }
}

/* --------------------------------------------------------- settings tab */

class GalaxySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const rebuildViews = () => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view && leaf.view.build) { leaf.view.build(); leaf.view.buildPanel(leaf.view.contentEl); }
      }
    };
    const textRule = (name, desc, key, placeholder) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addTextArea((ta) => {
          ta.setPlaceholder(placeholder)
            .setValue(this.plugin.settings[key])
            .onChange(async (v) => {
              this.plugin.settings[key] = v;
              await this.plugin.saveSettings();
              rebuildViews();
            });
          ta.inputEl.rows = 3;
        });
    };

    new Setting(containerEl).setName('Vault structure').setHeading();
    containerEl.createEl('p', {
      text: 'All fields optional — leave them empty and the galaxy auto-detects: ' +
        'your 5 most-linked notes become suns, the next most-linked become hubs, ' +
        'and top-level folders become colored groups. Patterns are vault paths, ' +
        'one per line, * matches anything.',
      cls: 'setting-item-description',
    });

    textRule('Core notes (suns)',
      'Notes that anchor the center of the galaxy. Example: notes/index.md or MOCs/*',
      'coreRules', 'MOCs/*\nhome.md');
    textRule('Hub notes (orange stars)',
      'Router/index notes that orbit the suns and collect their own moons.',
      'hubRules', 'MOCs/sub-*');
    textRule('Archive folders',
      'Folders rendered as dim debris at the galaxy rim.',
      'archiveFolders', 'archive');
    textRule('Folder groups (colored clusters)',
      'Folders that get their own color (and their own satellite cluster in expand mode). Empty = every top-level folder automatically.',
      'folderGroups', 'Projects\nAreas\nResources');
  }
}

/* ----------------------------------------------------------------- plugin */

class VaultGalaxyPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new GalaxyView(leaf, this));
    this.addRibbonIcon('orbit', 'Open Vault Galaxy', () => this.activateView());
    this.addCommand({ id: 'open', name: 'Open galaxy view', callback: () => this.activateView() });
    this.addSettingTab(new GalaxySettingTab(this.app, this));

    // first-ever load: open the galaxy once so it introduces itself
    this.app.workspace.onLayoutReady(async () => {
      if (!this.data.opened) {
        await this.activateView();
        this.data.opened = true;
        await this.saveSettings();
      }
    });
  }

  async loadSettings() {
    this.data = (await this.loadData()) || {};
    this.settings = {
      ...DEFAULT_SETTINGS, ...(this.data.settings || {}),
      colors: { ...((this.data.settings || {}).colors || {}) },
    };
  }

  async saveSettings() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

module.exports = VaultGalaxyPlugin;
