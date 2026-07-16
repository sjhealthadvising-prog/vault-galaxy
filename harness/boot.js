// Evaluate the real (untouched) main.js as CommonJS, capture the view class
// via a mocked Plugin surface, and boot a GalaxyView into #host.
const src = await (await fetch('../main.js')).text();
const mod = { exports: {} };
new Function('module', 'exports', 'require', src)(mod, mod.exports, window.require);

const PluginClass = mod.exports;
const p = new PluginClass();
p.app = window.__mockApp;
let viewFactory = null;
p.registerView = (_type, factory) => { viewFactory = factory; };
p.addRibbonIcon = () => {};
p.addCommand = () => {};
p.addSettingTab = () => {};
p.loadData = async () => ({ opened: true });
p.saveData = async () => {};
await p.onload();

const view = viewFactory({ /* mock leaf */ });
await view.onOpen();
window.__view = view; // for console poking
console.log('[harness] galaxy booted:',
  view.model ? `${view.model.nodes.size} nodes, ${view.model.edges.length} edges` : 'NO MODEL');
