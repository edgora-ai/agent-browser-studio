// Inert controlled DOM/IPC fixture. Register callbacks with the supplied public
// test API; execute actual modules/dictionaries, never a nested test runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function registerSkillCardI18nTests(test, options) {
const ROOT = options.root;
const REFERENCE = options.helperRoot || ROOT;
const BASELINE = options.baselineRoot;
const ts = createRequire(path.join(REFERENCE, 'package.json'))('typescript');
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const CORE = read(ROOT, 'src/renderer/js/app/core.js');
const OLD_CORE = BASELINE ? read(BASELINE, 'src/renderer/js/app/core.js') : null;
const DICTIONARIES = ['i18n.js', 'src/renderer/js/i18n.js'].map(rel => read(ROOT, rel));
const ICONS = read(REFERENCE, 'src/renderer/js/app/icons.js');
const SKILLS_MODULE = read(REFERENCE, 'src/renderer/js/app/agent-skills.js');
const HTML = read(REFERENCE, 'src/renderer/index.html');
const LOCALES = ['en-US', 'zh-CN'];
const THEMES = ['light', 'dark'];
const SOURCES = ['built-in', 'local', 'shared-catalog'];
const CARD_KEYS = [
  ['source.builtin', 'Built-in', '内置'], ['source.catalog', 'Shared catalog', '共享目录'], ['source.local', 'Local', '本地'],
  ['enabled', 'Enabled', '已启用'], ['disabled', 'Disabled', '已禁用'], ['yes', 'Yes', '是'], ['no', 'No', '否'],
  ['source', 'Source', '来源'], ['share', 'Share', '分享'], ['tools', 'Tools', '工具'],
  ['install-enable', 'Install / Enable', '安装 / 启用'], ['enable', 'Enable', '启用'], ['disable', 'Disable', '禁用'],
  ['edit', 'Edit', '编辑'], ['unshare', 'Unshare', '取消分享'], ['remove', 'Remove', '移除'],
];
// 'share' intentionally serves both the metadata heading and the action.
const TRANSLATIONS = CARD_KEYS.map(([suffix, en, zh]) => ['agent.skills.card.' + suffix, en, zh])
  .concat([['common.status', 'Status', '状态'], ['common.none', 'none', '无']]);
const encode = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class Element {
  constructor(doc, tag, text = '') {
    this.doc = doc; this.tagName = tag.toUpperCase(); this.nodeType = tag === '#text' ? 3 : 1;
    this.text = text; this.attrs = {}; this.children = []; this.parentNode = null; this.style = {};
    this.value = ''; this.open = false; this.disabled = false; this.checked = false; this.listeners = new Map();
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())),
      set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value); return true; },
    });
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0]; }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; }
  get textContent() { return this.nodeType === 3 ? this.text : this.children.map(el => el.textContent).join(''); }
  set textContent(value) {
    this.children = [];
    if (this.nodeType === 3) this.text = String(value);
    else if (String(value)) this.appendChild(new Element(this.doc, '#text', String(value)));
  }
  get innerHTML() { return this.children.map(el => el.serialize()).join(''); }
  set innerHTML(value) { this.children = []; parse(String(value), this); }
  serialize() {
    if (this.nodeType === 3) return encode(this.text);
    const attrs = Object.entries(this.attrs).map(([key, value]) => ' ' + key + '="' + encode(value).replace(/"/g, '&quot;') + '"').join('');
    return '<' + this.tagName.toLowerCase() + attrs + '>' + this.innerHTML + '</' + this.tagName.toLowerCase() + '>';
  }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  removeChild(el) { this.children = this.children.filter(child => child !== el); el.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(el) { return this === el || this.children.some(child => child.contains(el)); }
  matches(selector) {
    if (this.nodeType !== 1) return false;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return attribute[2] === undefined ? this.getAttribute(attribute[1]) !== null : this.getAttribute(attribute[1]) === attribute[2];
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  closest(selector) { for (let el = this; el; el = el.parentNode) if (el.matches(selector)) return el; return null; }
  querySelectorAll(selector) { return this.children.flatMap(el => [...(el.matches(selector) ? [el] : []), ...el.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) { const callbacks = this.listeners.get(type) || []; callbacks.push(fn); this.listeners.set(type, callbacks); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent({ type: 'close', target: this }); }
  focus() { this.doc.activeElement = this; }
  click() { for (let el = this; el; el = el.parentNode) if (el.onclick) el.onclick({ target: this }); }
}
function parse(input, root) {
  input = input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const stack = [root];
  for (const token of input.match(/<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+/g) || []) {
    if (/^<!/.test(token)) continue;
    if (/^<\//.test(token)) {
      const tag = token.slice(2, -1).trim().toUpperCase();
      const index = stack.findLastIndex(el => el.tagName === tag);
      if (index > 0) stack.length = index;
    } else if (token.startsWith('<')) {
      const match = /^<([\w-]+)([\s\S]*?)\/?\s*>$/.exec(token);
      if (!match) continue;
      const el = new Element(root.doc, match[1]);
      for (const attr of match[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.attrs[attr[1]] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
      el.value = el.attrs.value || ''; el.checked = 'checked' in el.attrs; el.disabled = 'disabled' in el.attrs;
      for (const style of (el.attrs.style || '').split(';')) { const index = style.indexOf(':'); if (index >= 0) el.style[style.slice(0, index).trim()] = style.slice(index + 1).trim(); }
      stack.at(-1).appendChild(el);
      if (!/\/>$/.test(token) && !['INPUT', 'BR', 'HR', 'IMG', 'META', 'LINK', 'SOURCE'].includes(el.tagName)) stack.push(el);
    } else stack.at(-1).appendChild(new Element(root.doc, '#text', decode(token)));
  }
}
class Document {
  constructor(theme, markup = '') {
    this.readyState = 'loading'; this.root = new Element(this, '#document'); this.listeners = new Map(); parse(markup, this.root);
    this.documentElement = this.root.querySelector('html') || new Element(this, 'html');
    this.documentElement.setAttribute('data-theme', theme);
    this.body = this.root.querySelector('body') || this.root;
  }
  createElement(tag) { return new Element(this, tag); }
  createTextNode(text) { return new Element(this, '#text', text); }
  querySelectorAll(selector) { return this.root.querySelectorAll(selector); }
  getElementById(id) { return this.root.querySelector('#' + id); }
  addEventListener(type, fn) { const callbacks = this.listeners.get(type) || []; callbacks.push(fn); this.listeners.set(type, callbacks); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
}
function load({ dictionary = DICTIONARIES[1], core = CORE, locale = 'zh-CN', theme = 'light', rows = [], agents = false, markup = false, icons = true } = {}) {
  const document = new Document(theme, markup ? HTML : '');
  const store = new Map(rows.map(row => [row.id, structuredClone(row)]));
  const calls = [];
  // Only the IPC boundary is controlled. Core and agent-skills mutation/refresh
  // methods, delegated clicks, editor and confirmation handlers are real modules.
  const skills = {
    list: async () => [...store.values()].map(row => structuredClone(row)),
    marketplace: async () => [...store.values()].map(row => structuredClone(row)),
    setMeta: async (id, meta) => { calls.push(['setMeta', id, structuredClone(meta)]); assert.ok(store.has(id)); Object.assign(store.get(id), structuredClone(meta)); return { success: true }; },
    install: async id => { calls.push(['install', id]); assert.ok(store.has(id)); store.get(id).enabled = true; return { success: true }; },
    remove: async id => { calls.push(['remove', id]); assert.ok(store.has(id)); if (store.get(id).source === 'built-in') store.get(id).enabled = false; else store.delete(id); return { success: true }; },
  };
  const window = { agentBrowserAPI: { agent: { skills } } };
  const storage = new Map();
  const context = vm.createContext({ window, document, console, navigator: { language: locale },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout: () => 1, clearTimeout: () => {},
  });
  vm.runInContext(dictionary, context, { filename: 'actual-i18n.js' });
  if (icons) vm.runInContext(ICONS, context, { filename: 'actual-icons.js' });
  vm.runInContext(core, context, { filename: 'actual-core.js' });
  if (agents) vm.runInContext(SKILLS_MODULE, context, { filename: 'unchanged-agent-skills.js' });
  return { window, document, context, store, calls, helpers: window.agentBrowser.helpers, app: window.agentBrowser };
}
function ast(source, filename = 'fixture.js') {
  const result = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  assert.equal(result.parseDiagnostics.length, 0, filename + ': TypeScript parser diagnostics');
  return result;
}
function declaration(tree, name) {
  let result;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) result = node; ts.forEachChild(node, visit); }
  visit(tree); assert.ok(result, name); return result;
}
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(prop => [prop.name.text, literal(prop.initializer)]));
  throw new Error('Expected a static builtin payload, got ' + ts.SyntaxKind[node.kind]);
}
const BUILTINS = literal(declaration(ast(read(REFERENCE, 'src/main/services/skill-repository.ts'), 'skill-repository.ts'), 'BUILTIN_SKILLS').initializer);
function skill(source, enabled, shared, tools = true) {
  const payload = BUILTINS.find(row => row.name === 'profile-manager'); assert.ok(payload);
  return { ...structuredClone(payload), id: payload.name, title: payload.name, source, enabled, shared, tags: ['built-in', 'management'], tools: tools ? payload.tools : [] };
}
function bundles(dictionary) {
  const marker = '  // Expose\n'; assert.equal(dictionary.split(marker).length, 2);
  // Introspection only; execute all three actual merges before exposing the result.
  return load({ dictionary: dictionary.replace(marker, '  window.__bundles = dict;\n' + marker) }).window.__bundles;
}
function validateBundles(dictionary) {
  const effective = bundles(dictionary);
  for (const locale of LOCALES) {
    const runtime = load({ dictionary, locale }).window.i18n;
    for (const [key, en, zh] of TRANSLATIONS) {
      const expected = locale === 'en-US' ? en : zh;
      assert.ok(Object.hasOwn(effective[locale], key), locale + ': missing own ' + key);
      assert.equal(effective[locale][key], expected, locale + ': merged ' + key);
      assert.equal(runtime.t(key, '__MISSING_TRANSLATION__'), expected, locale + ': runtime ' + key);
    }
  }
}
function expectedActions(row, market, zh) {
  const actions = [[market ? (row.enabled ? 'skill-disable' : 'skill-install') : 'skill-toggle', market ? (row.enabled ? (zh ? ' 已启用' : ' Enabled') : (zh ? '安装 / 启用' : 'Install / Enable')) : (row.enabled ? (zh ? '禁用' : 'Disable') : (zh ? '启用' : 'Enable'))]];
  if (row.source !== 'built-in') actions.push(['skill-edit', zh ? '编辑' : 'Edit']);
  actions.push(['skill-share', row.shared ? (zh ? '取消分享' : 'Unshare') : (zh ? '分享' : 'Share')]);
  actions.push(['skill-remove', row.source === 'built-in' ? (zh ? '禁用' : 'Disable') : (zh ? '移除' : 'Remove')]);
  return actions;
}
function validateCard(runtime, row, market, locale) {
  const html = runtime.helpers.renderSkillCard(row, market);
  const root = runtime.document.createElement('section'); root.innerHTML = html;
  const card = root.querySelector('.skill-card'); assert.ok(card);
  assert.equal(card.dataset.skillId, row.id);
  assert.equal(card.querySelector('h4').textContent, row.title || row.name || row.id);
  assert.equal(card.querySelector('.skill-desc').textContent, row.description || '');
  const zh = locale === 'zh-CN';
  const source = { 'built-in': zh ? '内置' : 'Built-in', local: zh ? '本地' : 'Local', 'shared-catalog': zh ? '共享目录' : 'Shared catalog' }[row.source];
  const tools = (row.tools || []).join(', ');
  const metadata = card.querySelector('.skill-meta').children.filter(el => el.nodeType === 1);
  assert.deepEqual(metadata.map(el => el.textContent), [
    (zh ? '来源' : 'Source') + ': ' + source,
    (zh ? '状态' : 'Status') + ': ' + (row.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '已禁用' : 'Disabled')),
    (zh ? '分享' : 'Share') + ': ' + (row.shared ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')),
    (zh ? '工具' : 'Tools') + ': ' + (tools ? tools.slice(0, 120) : (zh ? '无' : 'none')),
  ], locale + ': fixed metadata');
  assert.equal(metadata[3].getAttribute('title'), tools);
  assert.deepEqual(card.querySelector('.skill-tags')?.children.filter(el => el.nodeType === 1).map(el => el.textContent) || [], row.tags || []);
  const buttons = card.querySelectorAll('[data-action]');
  assert.deepEqual(buttons.map(el => [el.dataset.action, el.textContent]), expectedActions(row, market, zh), locale + ': fixed actions');
  assert.equal(card.querySelectorAll('svg').length, market && row.enabled && runtime.window.icons ? 1 : 0);
  if (zh) {
    // Whitelist actual repository payload nodes only. Do not ban legitimate
    // product names, descriptions, tags, tool identifiers or data-action IDs.
    const fixedCopy = metadata.slice(0, 3).map(el => el.textContent).concat(metadata[3].textContent.slice(0, 3), buttons.map(el => el.textContent)).join(' ');
    assert.doesNotMatch(fixedCopy, /[A-Za-z]/, 'English fixed-copy leakage');
  }
  return html;
}
function removeRanges(source, ranges) { for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + source.slice(end); return source; }
function functionRanges(tree) { return tree.statements[0].expression.expression.expression.body.statements.filter(node => ts.isFunctionDeclaration(node) && ['skillSourceLabel', 'renderSkillCard'].includes(node.name.text)).map(node => [node.getFullStart(), node.end]); }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('actual mirrored dictionaries resolve every card key after all three merges', () => {
  assert.equal(DICTIONARIES[0], DICTIONARIES[1]);
  for (const dictionary of DICTIONARIES) {
    validateBundles(dictionary);
    const tree = ast(dictionary);
    const layers = ['dict', 'extraDict', 'auditFixDict'].map(name => declaration(tree, name).initializer);
    for (const locale of LOCALES) for (const [suffix] of CARD_KEYS) {
      const key = 'agent.skills.card.' + suffix;
      const occurrences = layers.flatMap(layer => layer.properties.filter(prop => prop.name.text === locale).flatMap(prop => prop.initializer.properties.filter(item => item.name.text === key)));
      assert.equal(occurrences.length, 1, locale + ': unique across dictionary layers ' + key);
    }
  }
});

test('384 controlled render cases cover both dictionaries/locales/themes/sources/views/states/tools', () => {
  let count = 0;
  for (const dictionary of DICTIONARIES) for (const locale of LOCALES) for (const theme of THEMES) {
    const runtime = load({ dictionary, locale, theme });
    for (const source of SOURCES) for (const market of [false, true]) for (const enabled of [false, true]) for (const shared of [false, true]) for (const tools of [false, true]) {
      const row = skill(source, enabled, shared, tools); const before = JSON.stringify(row);
      validateCard(runtime, row, market, locale);
      assert.equal(JSON.stringify(row), before, 'rendering must not mutate source enums or payload'); count++;
    }
    assert.equal(runtime.document.documentElement.getAttribute('data-theme'), theme);
  }
  assert.equal(count, 384);
});

if (BASELINE) test('archive control: old whole module stays RED while the new module is GREEN', () => {
  let red = 0; let green = 0;
  for (const dictionary of DICTIONARIES) for (const locale of LOCALES) for (const theme of THEMES) {
    const current = load({ dictionary, locale, theme });
    const old = load({ dictionary, core: OLD_CORE, locale, theme });
    for (const source of SOURCES) for (const market of [false, true]) for (const enabled of [false, true]) for (const shared of [false, true]) for (const tools of [false, true]) {
      const row = skill(source, enabled, shared, tools);
      const html = validateCard(current, row, market, locale); green++;
      if (locale === 'zh-CN') {
        assert.throws(() => validateCard(old, row, market, locale), assert.AssertionError, 'old whole module must fail even with the new dictionaries'); red++;
      } else assert.equal(old.helpers.renderSkillCard(row, market), html);
    }
  }
  assert.equal(red, 192); assert.equal(green, 384);
});

// Independent literal English snapshot oracle, mandatory without any archive.
function expectedEnglishCard(row, marketplace, icons) {
  const text = value => value ? encode(String(value)) : '';
  const attr = value => text(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const tags = (row.tags || []).map(tag => '<span style="background:var(--surface2);border:1px solid var(--border);padding:1px 6px;border-radius:4px;font-size:10px;">' + text(tag) + '</span>').join(' ');
  const tools = (row.tools || []).join(', ');
  const source = row.source === 'built-in' ? 'Built-in' : row.source === 'shared-catalog' ? 'Shared catalog' : 'Local';
  let actions = marketplace
    ? (row.enabled ? '<button class="btn btn-secondary btn-sm" data-action="skill-disable">' + (icons ? icons.svg('check', { size: 12 }) : '') + ' Enabled</button> ' : '<button class="btn btn-primary btn-sm" data-action="skill-install">Install / Enable</button> ')
    : '<button class="btn btn-secondary btn-sm" data-action="skill-toggle">' + (row.enabled ? 'Disable' : 'Enable') + '</button> ';
  if (row.source !== 'built-in') actions += '<button class="btn btn-secondary btn-sm" data-action="skill-edit">Edit</button> ';
  actions += '<button class="btn btn-secondary btn-sm" data-action="skill-share">' + (row.shared ? 'Unshare' : 'Share') + '</button> ';
  actions += '<button class="btn btn-danger btn-sm" data-action="skill-remove">' + (row.source === 'built-in' ? 'Disable' : 'Remove') + '</button>';
  return '<div class="skill-card" data-skill-id="' + attr(row.id) + '"><div class="skill-layout"><div class="skill-main">' +
    '<h4>' + text(row.title || row.name || row.id) + '</h4><p class="skill-desc">' + text(row.description || '') + '</p>' +
    '<div class="skill-meta"><span>Source: ' + text(source) + '</span><span>Status: ' + (row.enabled ? 'Enabled' : 'Disabled') + '</span>' +
    '<span>Share: ' + (row.shared ? 'Yes' : 'No') + '</span><span title="' + attr(tools) + '">Tools: ' + text(tools ? tools.slice(0, 120) : 'none') + '</span></div>' +
    (tags ? '<div class="skill-tags">' + tags + '</div>' : '') + '</div><div class="skill-actions">' + actions + '</div></div></div>';
}

test('mandatory exact English snapshots preserve every state, real SVG spacing and missing-icons fallback', () => {
  for (const dictionary of DICTIONARIES) for (const theme of THEMES) for (const icons of [false, true]) {
    const current = load({ dictionary, locale: 'en-US', theme, icons });
    const old = BASELINE ? load({ dictionary, core: OLD_CORE, locale: 'en-US', theme, icons }) : null;
    for (const source of SOURCES) for (const market of [false, true]) for (const enabled of [false, true]) for (const shared of [false, true]) {
      for (const tools of [false, true]) {
        const row = skill(source, enabled, shared, tools);
        const actual = current.helpers.renderSkillCard(row, market);
        assert.equal(actual, expectedEnglishCard(row, market, current.window.icons));
        if (old) assert.equal(actual, old.helpers.renderSkillCard(row, market));
      }
    }
  }
});

test('whole-module live locale switches preserve card payload, labels, icon and source presentation contract', () => {
  const runtime = load({ locale: 'en-US', markup: true });
  const row = skill('built-in', true, true);
  runtime.window.i18n.apply();
  const en = validateCard(runtime, row, true, 'en-US');
  runtime.window.i18n.set('zh-CN');
  validateCard(runtime, row, true, 'zh-CN');
  assert.equal(row.source, 'built-in');
  runtime.window.i18n.set('en-US');
  assert.equal(validateCard(runtime, row, true, 'en-US'), en);
  for (const title of ['', null]) { const fallback = { ...row, title }; validateCard(runtime, fallback, false, 'en-US'); }
  const idFallback = { ...row, title: '', name: '' }; validateCard(runtime, idFallback, false, 'en-US');
  assert.equal(runtime.helpers.skillSourceLabel({ source: 'other-user-value' }), 'Local');
});

test('real page/marketplace handlers dispatch untouched IDs and mutate only IPC-boundary fixture state', async () => {
  for (const locale of LOCALES) for (const theme of THEMES) for (const source of SOURCES) for (const market of [false, true]) for (const enabled of [false, true]) for (const shared of [false, true]) {
    const row = skill(source, enabled, shared);
    const runtime = load({ locale, theme, rows: [row], agents: true, markup: true });
    const view = runtime.document.getElementById('agent-view-skills'); view.style.display = 'block';
    if (market) runtime.app.skillMarket(); else runtime.app.agentLoadSkills();
    await settle();
    const list = runtime.document.getElementById(market ? 'skill-market-list' : 'agent-skills-list');
    const toggle = list.querySelector('[data-action="' + (market ? (enabled ? 'skill-disable' : 'skill-install') : 'skill-toggle') + '"]'); assert.ok(toggle);
    toggle.click(); await settle();
    assert.equal(runtime.store.get(row.id).enabled, !enabled);
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.calls[0])), market && !enabled ? ['install', row.id] : ['setMeta', row.id, { enabled: !enabled }]);
    list.querySelector('[data-action="skill-share"]').click(); await settle();
    assert.equal(runtime.store.get(row.id).shared, !shared);
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.calls[1])), ['setMeta', row.id, { shared: !shared, tags: row.tags }]);
    const updated = runtime.store.get(row.id);
    validateCard(runtime, updated, market, locale);
    if (source !== 'built-in') {
      list.querySelector('[data-action="skill-edit"]').click(); await settle();
      assert.equal(runtime.document.getElementById('skill-id').value, row.id);
      assert.equal(runtime.document.getElementById('skill-title').value, row.title);
      assert.equal(runtime.document.getElementById('skill-tools').value, row.tools.join(', '));
      assert.equal(runtime.document.getElementById('dlg-skill-editor').open, true);
    } else assert.equal(list.querySelector('[data-action="skill-edit"]'), null);
    list.querySelector('[data-action="skill-remove"]').click();
    assert.equal(runtime.document.getElementById('dlg-confirm').open, true);
    assert.equal(runtime.calls.length, 2, 'remove cannot bypass confirmation');
    runtime.app.doConfirm(); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.calls[2])), ['remove', row.id]);
    if (source === 'built-in') assert.equal(runtime.store.get(row.id).enabled, false); else assert.equal(runtime.store.has(row.id), false);
  }
});

test('translated fixed labels and arbitrary payload remain HTML-escaped without translating user content', () => {
  const dictionary = DICTIONARIES[1]; const tree = ast(dictionary); const ranges = [];
  for (const prop of declaration(tree, 'dict').initializer.properties) if (prop.name.text === 'zh-CN') {
    for (const item of prop.initializer.properties) if (item.name.text.startsWith('agent.skills.card.') || item.name.text === 'common.status') ranges.push([item.initializer.getStart(tree), item.initializer.end]);
  }
  // Change only real dictionary literal values; keep the runtime and lookup logic.
  const hostile = ranges.sort((a, b) => b[0] - a[0]).reduce((source, [start, end]) => source.slice(0, start) + JSON.stringify('<img src=x onerror="bad()"> & label') + source.slice(end), dictionary);
  const runtime = load({ dictionary: hostile });
  const row = { ...skill('local', true, false), id: 'raw"<&', title: '<User title & name>', description: 'Literal <description>', tags: ['<tag>'], tools: ['<tool>', 'quoted"tool'] };
  const root = runtime.document.createElement('section'); root.innerHTML = runtime.helpers.renderSkillCard(row, false);
  assert.equal(root.querySelector('img'), null); assert.equal(root.querySelector('script'), null);
  assert.equal(root.querySelector('.skill-card').dataset.skillId, row.id);
  assert.equal(root.querySelector('h4').textContent, row.title);
  assert.equal(root.querySelector('.skill-desc').textContent, row.description);
  assert.equal(root.querySelector('.skill-tags').children[0].textContent, row.tags[0]);
  assert.equal(root.querySelector('.skill-meta').children[3].getAttribute('title'), row.tools.join(', '));
  assert.ok(root.querySelector('.skill-meta').textContent.includes('<img src=x onerror="bad()"> & label'));
  assert.ok(root.querySelector('[data-action="skill-share"]').textContent.includes('<img'));
});

test('TypeScript AST syntax and baseline parity permit only two core functions and unique dictionary additions', () => {
  const currentTree = ast(CORE, 'core.js');
  assert.equal(functionRanges(currentTree).length, 2);
  if (BASELINE) {
    const oldTree = ast(OLD_CORE, 'old-core.js');
    assert.equal(removeRanges(CORE, functionRanges(currentTree)), removeRanges(OLD_CORE, functionRanges(oldTree)), 'all other code, including bindSkillCardActions, stays byte-identical');
  }
  for (let index = 0; index < DICTIONARIES.length; index++) {
    const tree = ast(DICTIONARIES[index], 'i18n.js'); const additions = [];
    const base = declaration(tree, 'dict').initializer;
    for (const locale of base.properties) for (const item of locale.initializer.properties) if (item.name.text.startsWith('agent.skills.card.')) {
      let end = item.end; if (DICTIONARIES[index][end] === ',') end++;
      additions.push([item.getFullStart(), end]);
    }
    assert.equal(additions.length, CARD_KEYS.length * 2);
    if (BASELINE) {
      const rel = index ? 'src/renderer/js/i18n.js' : 'i18n.js';
      assert.equal(removeRanges(DICTIONARIES[index], additions), read(BASELINE, rel), 'dictionary changes must be additions only');
    }
  }
  new vm.Script(CORE); DICTIONARIES.forEach(source => new vm.Script(source)); new vm.Script(read(ROOT, 'tests/unit/renderer-skill-card-i18n.fixture.cjs'));
});

test('every old fixed-label literal mutation is killed by the actual-module Chinese render oracle', () => {
  const tree = ast(CORE); const replacements = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'pi18n' && node.arguments.length === 2 && TRANSLATIONS.some(([key]) => key === node.arguments[0].text)) replacements.push([node.getStart(tree), node.end, node.arguments[1].text]);
    ts.forEachChild(node, visit);
  }
  for (const node of tree.statements[0].expression.expression.expression.body.statements) if (ts.isFunctionDeclaration(node) && ['skillSourceLabel', 'renderSkillCard'].includes(node.name.text)) visit(node);
  assert.ok(replacements.length >= 20, 'mutations must cover every fixed label occurrence');
  for (const [start, end, oldLiteral] of replacements) {
    const mutant = CORE.slice(0, start) + JSON.stringify(oldLiteral) + CORE.slice(end);
    const runtime = load({ core: mutant }); let killed = false;
    for (const source of SOURCES) for (const market of [false, true]) for (const enabled of [false, true]) for (const shared of [false, true]) for (const tools of [false, true]) {
      try { validateCard(runtime, skill(source, enabled, shared, tools), market, 'zh-CN'); }
      catch (error) { assert.ok(error instanceof assert.AssertionError); killed = true; }
    }
    assert.ok(killed, 'old literal survived: ' + oldLiteral + ' at ' + start);
  }
});

test('removing any new Chinese key is detected after real English fallback and dictionary merges', () => {
  const dictionary = DICTIONARIES[1]; const tree = ast(dictionary);
  const zh = declaration(tree, 'dict').initializer.properties.find(prop => prop.name.text === 'zh-CN').initializer;
  for (const [suffix] of CARD_KEYS) {
    const key = 'agent.skills.card.' + suffix; const property = zh.properties.find(prop => prop.name.text === key); assert.ok(property, key);
    let end = property.end; if (dictionary[end] === ',') end++;
    const mutant = removeRanges(dictionary, [[property.getFullStart(), end]]);
    assert.throws(() => validateBundles(mutant), assert.AssertionError, 'missing translation must fail: ' + key);
  }
});

}

module.exports = { registerSkillCardI18nTests };
