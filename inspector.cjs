// The target views shared by the Run pane and the Kryon preview: one tab per
// target, each with the shared stages (Source, LIR, Optimized, ZX) and the
// target's own output (Native's from the Platform dropdown), a file tree with texts loaded on request, and
// a paged hex view. Binaries stay on disk; the webview asks for bytes.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { binaryRegions } = require('./binary-layout.cjs');
const { highlightedFile } = require('./highlight.cjs');
const { TARGETS, buildTarget, enabledTargets, platformChoice, startPipeline } = require('./targets.cjs');

// The most one hex view request reads from a binary.
const HEX_REQUEST_LIMIT = 1024 * 1024;

// Highlighting runs inside the webview. It is plain source so the page needs
// no external script, and tests can execute it directly.
const HIGHLIGHT_SOURCE = String.raw`
const KEYWORDS = {
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL',
  cpp: 'auto break case char const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new noexcept nullptr operator private protected public return short signed sizeof static static_cast struct switch template this true typedef typename union unsigned using virtual void volatile while bool',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil',
  rust: 'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  py: 'and as assert break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False',
  wat: 'module type func param result local global memory table export import data elem call return block loop if else end br br_if unreachable drop select',
  zir: 'module function stmt expr global type define import from',
};
const TYPES = /^(u?int(8|16|32|64)_t|size_t|String|Slice|u8|u16|u32|u64|usize|i8|i16|i32|i64|isize|f32|f64|s8|s16|s32|s64|float32|float64|string|bool|int8|int16|int32|int64|uint8|uint16|uint32|uint64|float|double|byte|rune|str)$/;
function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
}
function languageOf(name) {
  if (/\.(zir|zx)(\.txt)?$|\.lir$/.test(name)) return 'zir';
  if (/\.(cpp|hpp)$/.test(name)) return 'cpp';
  if (/\.wat$/.test(name)) return 'wat';
  if (/\.(s|disasm|asm)$/.test(name)) return 'asm';
  if (/\.go$/.test(name)) return 'go';
  if (/\.rs$/.test(name)) return 'rust';
  if (/\.py$/.test(name)) return 'py';
  if (/\.(c|h)$/.test(name)) return 'c';
  return '';
}
// Assembly listings, Go's and objdump's: comments, labels, directives,
// registers and numbers.
function highlightAssembly(text) {
  const token = /(#[^\n]*|\/\/[^\n]*|;[^\n]*)|(^[ \t]*\.[A-Za-z_.]+)|(^[ \t]*[0-9a-f]+ <[^>\n]+>:|<[^>\n]+>:?|^[A-Za-z_.$][^\s:]*:)|(%[a-z0-9]+\b|\b[xyzr]mm[0-9]+\b|\b[re]?[abcd]x\b|\b[re]?[sd]il?\b|\b[re]?[sb]pl?\b|\br[0-9]+[dwb]?\b)|(\$?-?\b0[xX][0-9a-fA-F]+\b|\$-?\d+\b|\b\d+\b)/gm;
  let html = '';
  let last = 0;
  for (const match of text.matchAll(token)) {
    html += escapeHtml(text.slice(last, match.index));
    last = match.index + match[0].length;
    const kind = match[1] ? 'comment' : match[2] ? 'directive' : match[3] ? 'function' : match[4] ? 'type' : 'number';
    html += '<span class="tok-' + kind + '">' + escapeHtml(match[0]) + '</span>';
  }
  return html + escapeHtml(text.slice(last));
}
function highlight(text, language) {
  if (language === 'asm') return highlightAssembly(text);
  if (!KEYWORDS[language]) return escapeHtml(text);
  const keywords = new Set(KEYWORDS[language].split(' '));
  // Python comments start with #, and its strings can be triple-quoted.
  const python = language === 'py';
  const token = python ?
    /(#[^\n]*)|("""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(a^)|(\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/gm :
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.){1,8}')|(^[ \t]*#[a-z]+)|(%\d+|\b0[xX][0-9a-fA-F]+[uUlL]*\b|\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[uUlLf]*\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/gm;
  let html = '';
  let last = 0;
  for (const match of text.matchAll(token)) {
    html += escapeHtml(text.slice(last, match.index));
    last = match.index + match[0].length;
    let kind = '';
    let word = match[0];
    let rest = '';
    if (match[1]) kind = 'comment';
    else if (match[2]) kind = 'string';
    else if (match[3]) kind = 'directive';
    else if (match[4]) kind = 'number';
    else {
      word = match[5];
      rest = match[6] || '';
      kind = keywords.has(word) ? 'keyword' : TYPES.test(word) ? 'type' :
        rest ? 'function' : /^[A-Z][A-Za-z0-9]*_?[A-Za-z0-9_]*$/.test(word) && /[a-z]/.test(word) ? 'type' : '';
    }
    html += kind ? '<span class="tok-' + kind + '">' + escapeHtml(word) + '</span>' + escapeHtml(rest) :
      escapeHtml(match[0]);
  }
  return html + escapeHtml(text.slice(last));
}
`;

// The hex view's rows: each shown region starts with a label row, then its
// bytes in rows of sixteen at their real file offsets. Showing only the
// program keeps code and data regions. Shared by the webview and unit tests.
const HEX_VIEW_SOURCE = String.raw`
const HEX_PROGRAM_KINDS = ['code', 'data'];
function hexFilterable(regions) {
  return Boolean(regions && regions.some((region) => HEX_PROGRAM_KINDS.includes(region.kind)) &&
    regions.some((region) => !HEX_PROGRAM_KINDS.includes(region.kind)));
}
function hexLayout(regions, size, programOnly) {
  const labelled = Boolean(regions && regions.length);
  const all = labelled ? regions : [{ start: 0, end: size, kind: 'other', label: '' }];
  let shown = programOnly ? all.filter((region) => HEX_PROGRAM_KINDS.includes(region.kind)) : all;
  if (!shown.length) shown = all;
  const blocks = [];
  let rows = 0;
  for (const region of shown) {
    if (region.end <= region.start) continue;
    const first = Math.floor(region.start / 16);
    const count = Math.floor((region.end - 1) / 16) - first + 1;
    blocks.push({ region, row: rows, first, count, labelled });
    rows += count + (labelled ? 1 : 0);
  }
  return { blocks, rows };
}
function hexRowAt(layout, row) {
  let low = 0;
  let high = layout.blocks.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (layout.blocks[middle].row <= row) low = middle; else high = middle - 1;
  }
  const block = layout.blocks[low];
  return block ? { block, line: row - block.row - (block.labelled ? 1 : 0) } : null;
}
function hexRowOf(layout, offset) {
  for (const block of layout.blocks) {
    if (offset >= block.region.start && offset < block.region.end) {
      return block.row + (block.labelled ? 1 : 0) + Math.floor(offset / 16) - block.first;
    }
  }
  return -1;
}
function hexLabel(region) {
  return '── ' + region.label + ' · 0x' + region.start.toString(16) + '–0x' + region.end.toString(16) +
    ' · ' + (region.end - region.start) + ' bytes';
}
`;

// A viewport of room under the open Targets section keeps the page where it
// is when another tab or view shows a shorter block.
const INSPECTOR_STYLE = `
  #code-section { margin-top: 16px; }
  #code-section[open] { padding-bottom: 100vh; }
  #code-section > summary { cursor: pointer; font-weight: bold; margin-bottom: 8px; }
  #code-section button, #code-section select { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
  #code-section select { max-width: 100%; }
  #code-section pre { box-sizing: border-box; overflow: auto; white-space: pre; font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.35; border: 1px solid var(--vscode-panel-border); padding: 10px; margin: 0; background: var(--vscode-textCodeBlock-background, transparent); }
  #code-section pre.problems { white-space: pre-wrap; color: var(--vscode-errorForeground); border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  .targets { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
  #code-section .targets select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 3px 6px; }
  .tabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; }
  #code-section .tab { background: transparent; color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
  #code-section .tab:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
  .tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); font-weight: bold; }
  #code-section .tab.failed { color: var(--vscode-errorForeground); }
  .tab.pending { opacity: .7; }
  .file-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
  .file-row:empty { display: none; }
  .file-row label { color: var(--vscode-descriptionForeground); }
  .file-workspace { display: flex; align-items: flex-start; gap: 12px; }
  .file-content { flex: 1; min-width: 0; }
  #file-tree { flex: 0 0 220px; max-width: 35%; max-height: 70vh; overflow: auto; padding: 4px 0; border-right: 1px solid var(--vscode-panel-border); }
  #file-tree summary { cursor: pointer; padding: 4px; white-space: nowrap; }
  #file-tree [role="group"] { padding-left: 14px; }
  #code-section #file-tree button { display: block; width: 100%; text-align: left; padding: 4px 8px; background: transparent; color: var(--vscode-foreground); white-space: nowrap; }
  #code-section #file-tree button:hover { background: var(--vscode-list-hoverBackground); }
  #code-section #file-tree [aria-selected="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
  #file-name { overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
  @media (max-width: 600px) { .file-workspace { flex-direction: column; } #file-tree { flex: auto; width: 100%; max-width: none; max-height: 180px; border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); } .file-content { width: 100%; } }
  #problem-details { margin-top: 8px; }
  #problem-details summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
  .views:empty { display: none; }
  .views .tab { font-size: .9em; }
  [hidden] { display: none !important; }
  .hex-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
  .hex-bar input[type="text"] { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 14em; }
  .hex-scroll { position: relative; height: 60vh; overflow: auto; border: 1px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background, transparent); }
  #hex-spacer { width: 1px; }
  #code-section #hex-rows { position: absolute; left: 0; top: 0; margin: 0; border: 0; padding: 0 10px; line-height: 18px; overflow: visible; background: transparent; }
  .tok-keyword { color: #569cd6; }
  .tok-type { color: #4ec9b0; }
  .tok-function { color: #dcdcaa; }
  .tok-string { color: #ce9178; }
  .tok-number { color: #b5cea8; }
  .tok-comment { color: #6a9955; font-style: italic; }
  .tok-directive { color: #c586c0; }
  body.vscode-light .tok-keyword { color: #0000ff; }
  body.vscode-light .tok-type { color: #267f99; }
  body.vscode-light .tok-function { color: #795e26; }
  body.vscode-light .tok-string { color: #a31515; }
  body.vscode-light .tok-number { color: #098658; }
  body.vscode-light .tok-comment { color: #008000; }
  body.vscode-light .tok-directive { color: #af00db; }
`;

const INSPECTOR_MARKUP = `<details id="code-section" open><summary>Targets</summary>
<div class="targets" id="targets"></div>
<div class="tabs" id="tabs" role="tablist" aria-label="Target"></div>
<div class="tabs views" id="views" role="tablist" aria-label="View"></div>
<div class="file-workspace"><nav id="file-tree" role="tree" aria-label="Files" hidden></nav><div class="file-content">
<div class="file-row" id="file-row"></div>
<pre id="code"></pre>
<details id="problem-details" hidden><summary>Full output</summary><pre id="problem-text"></pre></details>
<div id="hex" hidden><div class="hex-bar"><span id="hex-title"></span><input id="hex-goto" type="text" placeholder="Go to offset (hex)" aria-label="Go to offset"></div>
<div class="hex-scroll" id="hex-scroll" tabindex="0" role="region" aria-label="Hex view"><div id="hex-spacer"></div><pre id="hex-rows"></pre></div></div></div></div></details>`;

// The webview side. The page defines api and byId, passes every message to
// inspector.receive and each state to inspector.render.
const INSPECTOR_SCRIPT = String.raw`
${HIGHLIGHT_SOURCE}
${HEX_VIEW_SOURCE}
const inspector = (() => {
  const saved = api.getState() || {};
  let state = null;
  let selected = saved.selected || '';
  const files = saved.files || {};
  const views = saved.views || {};
  const folders = saved.folders || {};
  // Dependency files arrive from the extension when first shown.
  const texts = new Map();
  const htmls = new Map();
  let textGeneration = -1;
  let programOnly = saved.programOnly === true;
  const remember = () => api.setState({ ...(api.getState() || {}), selected, files, views, folders, programOnly,
    codeOpen: byId('code-section').open });
  if (saved.codeOpen === false) byId('code-section').open = false;
  byId('code-section').addEventListener('toggle', () => { remember(); renderHex(); });

  // Rows are drawn only for the visible window; bytes come in pages.
  const HEX_ROW = 18;
  const HEX_PAGE = 65536;
  const HEX_MAX_HEIGHT = 8000000;
  const hexPages = new Map();
  let hex = null;
  const hexScaled = () => hex.layout.rows * HEX_ROW > HEX_MAX_HEIGHT;
  const hexVisible = () => Math.max(1, Math.ceil(byId('hex-scroll').clientHeight / HEX_ROW));
  const hexFirst = () => {
    const box = byId('hex-scroll');
    if (!hexScaled()) return Math.floor(box.scrollTop / HEX_ROW);
    const last = Math.max(0, hex.layout.rows - hexVisible());
    const range = Math.max(1, HEX_MAX_HEIGHT - box.clientHeight);
    return Math.min(last, Math.round(box.scrollTop / range * last));
  };
  const hexByte = (offset) => {
    const page = Math.floor(offset / HEX_PAGE);
    const id = hex.key + ':' + page;
    if (!hexPages.has(id)) {
      hexPages.set(id, null);
      api.postMessage({ type: 'bytes', key: hex.key, offset: page * HEX_PAGE, length: HEX_PAGE });
    }
    const data = hexPages.get(id);
    const at = offset - page * HEX_PAGE;
    return data && at < data.length ? data[at] : -1;
  };
  const hexLine = (block, line, digits) => {
    if (line < 0) return hexLabel(block.region);
    const offset = (block.first + line) * 16;
    let bytes = '';
    let text = '';
    for (let index = 0; index < 16; index++) {
      if (index === 8) bytes += ' ';
      const at = offset + index;
      if (at < block.region.start || at >= block.region.end) { bytes += '   '; text += ' '; continue; }
      const value = hexByte(at);
      bytes += (value < 0 ? '··' : value.toString(16).padStart(2, '0')) + ' ';
      text += value < 0 ? ' ' : value >= 32 && value < 127 ? String.fromCharCode(value) : '.';
    }
    return offset.toString(16).padStart(digits, '0') + '  ' + bytes + ' |' + text + '|';
  };
  function renderHex() {
    if (!hex || byId('hex').hidden) return;
    const box = byId('hex-scroll');
    const first = hexFirst();
    const digits = Math.max(8, Math.max(0, hex.size - 1).toString(16).length);
    const lines = [];
    for (let row = first; row < first + hexVisible() + 2 && row < hex.layout.rows; row++) {
      const at = hexRowAt(hex.layout, row);
      if (at) lines.push(hexLine(at.block, at.line, digits));
    }
    const rows = byId('hex-rows');
    rows.textContent = lines.join('\n');
    rows.style.top = (hexScaled() ? box.scrollTop : first * HEX_ROW) + 'px';
  }
  const layoutHex = () => {
    hex.programOnly = programOnly;
    hex.layout = hexLayout(hex.regions, hex.size, programOnly);
    byId('hex-spacer').style.height = Math.min(hex.layout.rows * HEX_ROW, HEX_MAX_HEIGHT) + 'px';
    byId('hex-scroll').scrollTop = 0;
  };
  const showHex = (file) => {
    byId('code').hidden = true;
    byId('hex').hidden = false;
    if (!hex || hex.key !== file.binary.key) {
      hex = { key: file.binary.key, size: file.binary.size, regions: file.binary.regions || null };
      byId('hex-title').textContent = file.name + ' · ' + file.binary.size.toLocaleString() + ' bytes';
      layoutHex();
    } else if (hex.programOnly !== programOnly) {
      layoutHex();
    }
    renderHex();
  };
  const hideHex = () => { byId('hex').hidden = true; byId('code').hidden = false; };
  let hexFrame = 0;
  const scheduleHex = () => {
    if (hexFrame) return;
    hexFrame = requestAnimationFrame(() => { hexFrame = 0; renderHex(); });
  };
  byId('hex-scroll').addEventListener('scroll', scheduleHex);
  window.addEventListener('resize', scheduleHex);
  // An offset the filter hides shows the whole file again.
  byId('hex-goto').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !hex) return;
    const offset = parseInt(event.target.value.trim().replace(/^0x/i, ''), 16);
    if (!Number.isFinite(offset) || offset < 0) return;
    const wanted = Math.min(Math.max(0, hex.size - 1), offset);
    if (programOnly && hexRowOf(hex.layout, wanted) < 0) {
      programOnly = false;
      remember();
      render();
    }
    const row = hexRowOf(hex.layout, wanted);
    if (row < 0) return;
    const box = byId('hex-scroll');
    const last = Math.max(0, hex.layout.rows - hexVisible());
    const top = Math.min(row, last);
    box.scrollTop = hexScaled() ? top / Math.max(1, last) * (HEX_MAX_HEIGHT - box.clientHeight) : top * HEX_ROW;
    renderHex();
  });
  const decode = (text) => {
    const raw = atob(text || '');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return bytes;
  };

  const tab = (label, chosen, failed, select, pending = false) => {
    const button = document.createElement('button');
    button.className = 'tab' + (failed ? ' failed' : '') + (pending ? ' pending' : '');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(chosen));
    button.textContent = label + (failed ? ' ✕' : '') + (pending ? ' …' : '');
    button.addEventListener('click', select);
    return button;
  };
  // A failure reads as one line; the tool's full output stays collapsed.
  const showProblem = (message) => {
    hideHex();
    const text = String(message || '').trim();
    const lines = text.split('\n');
    const code = byId('code');
    code.className = 'problems';
    code.textContent = lines[0];
    byId('problem-text').textContent = lines.length > 1 ? text : '';
    byId('problem-details').hidden = lines.length < 2;
  };
  const fileTree = (items, chosen, fileKey, focusKey, scrollTop) => {
    const tree = byId('file-tree');
    tree.hidden = false;
    const roots = new Map();
    for (const file of items) {
      const parts = [file.dependency ? 'Packages' : 'Project', ...file.name.split('/').filter(Boolean)];
      let level = roots;
      for (const name of parts.slice(0, -1)) {
        if (!level.has(name)) level.set(name, { children: new Map() });
        level = level.get(name).children;
      }
      level.set(parts.at(-1), { file });
    }
    const append = (parent, entries, prefix) => {
      const ordered = [...entries].sort(([a, left], [b, right]) =>
        (prefix ? 0 : Number(b === 'Project') - Number(a === 'Project')) ||
        Number(Boolean(right.children)) - Number(Boolean(left.children)) || a.localeCompare(b, undefined, { numeric: true }));
      for (const [name, node] of ordered) {
        if (node.children) {
          const directory = document.createElement('details');
          const key = fileKey + '/' + prefix + name;
          directory.open = folders[key] !== false;
          const label = document.createElement('summary');
          label.textContent = name;
          label.dataset.treeKey = prefix + name + '/';
          label.tabIndex = -1;
          label.setAttribute('role', 'treeitem');
          label.setAttribute('aria-expanded', String(directory.open));
          const group = document.createElement('div');
          group.setAttribute('role', 'group');
          append(group, node.children, prefix + name + '/');
          directory.append(label, group);
          directory.addEventListener('toggle', () => {
            folders[key] = directory.open;
            label.setAttribute('aria-expanded', String(directory.open));
            remember();
          });
          parent.append(directory);
        } else {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = name;
          button.title = node.file.name;
          button.dataset.file = node.file.name;
          button.dataset.treeKey = prefix + name;
          button.tabIndex = node.file === chosen ? 0 : -1;
          button.setAttribute('role', 'treeitem');
          button.setAttribute('aria-selected', String(node.file === chosen));
          button.addEventListener('click', () => {
            files[fileKey] = node.file.name;
            remember();
            button.focus();
            render();
          });
          parent.append(button);
        }
      }
    };
    append(tree, roots, '');
    tree.scrollTop = scrollTop;
    if (focusKey) [...tree.querySelectorAll('[data-tree-key]')]
      .find(item => item.dataset.treeKey === focusKey)?.focus({ preventScroll: true });
  };
  byId('file-tree').addEventListener('focusin', event => {
    if (!event.target.matches('[role=treeitem]')) return;
    for (const item of byId('file-tree').querySelectorAll('[role=treeitem]'))
      item.tabIndex = item === event.target ? 0 : -1;
  });
  byId('file-tree').addEventListener('keydown', event => {
    const item = event.target;
    if (!item.matches('[role=treeitem]')) return;
    const items = [...byId('file-tree').querySelectorAll('[role=treeitem]')]
      .filter(node => node.getClientRects().length);
    const index = items.indexOf(item);
    const directory = item.tagName === 'SUMMARY' ? item.parentElement : null;
    let next;
    switch (event.key) {
      case 'ArrowDown': next = items[Math.min(index + 1, items.length - 1)]; break;
      case 'ArrowUp': next = items[Math.max(index - 1, 0)]; break;
      case 'Home': next = items[0]; break;
      case 'End': next = items.at(-1); break;
      case 'ArrowRight':
        if (directory && !directory.open) directory.open = true;
        else if (directory) next = items[index + 1];
        break;
      case 'ArrowLeft':
        if (directory?.open) directory.open = false;
        else next = item.parentElement.closest('[role=group]')?.parentElement.querySelector('summary');
        break;
      default: return;
    }
    event.preventDefault();
    if (next) next.focus();
  });
  const filterToggle = (label) => {
    const wrap = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'program-only';
    box.checked = programOnly;
    box.addEventListener('change', () => { programOnly = box.checked; remember(); render(); });
    wrap.append(box, ' ' + label);
    return wrap;
  };
  function render() {
    if (!state) return;
    const boxes = byId('targets');
    boxes.replaceChildren();
    for (const target of state.targets) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.enabled.includes(target.id);
      box.addEventListener('change', () => {
        const enabled = state.targets.map((item) => item.id)
          .filter((id) => id === target.id ? box.checked : state.enabled.includes(id));
        api.postMessage({ type: 'targets', enabled });
      });
      label.append(box, ' ' + target.label);
      boxes.append(label);
    }
    // The platform Native lowers to and Run runs on; a gap is listed by name.
    if (state.platforms && state.platforms.length) {
      const label = document.createElement('label');
      const select = document.createElement('select');
      select.id = 'platform';
      select.setAttribute('aria-label', 'Platform');
      for (const platform of state.platforms) {
        const option = document.createElement('option');
        option.value = platform.id;
        option.textContent = platform.gap ? platform.label + ' — ' + platform.gap : platform.label;
        option.disabled = Boolean(platform.gap) && platform.id !== state.platform;
        select.append(option);
      }
      select.value = state.platform;
      select.addEventListener('change', () => api.postMessage({ type: 'platform', id: select.value }));
      label.append('Platform ', select);
      boxes.append(label);
    }
    const results = state.results;
    if (!results.some((result) => result.id === selected)) selected = results[0] ? results[0].id : '';
    const tabs = byId('tabs');
    tabs.replaceChildren();
    for (const result of results) {
      const target = state.targets.find((item) => item.id === result.id);
      tabs.append(tab(result.label || (target ? target.label : result.id), result.id === selected, !result.ok,
        () => { selected = result.id; remember(); render(); }, Boolean(result.pending)));
    }
    const result = results.find((item) => item.id === selected);
    const viewTabs = byId('views');
    viewTabs.replaceChildren();
    const row = byId('file-row');
    row.replaceChildren();
    const treeScroll = byId('file-tree').scrollTop;
    const treeFocus = byId('file-tree').contains(document.activeElement) ? document.activeElement.dataset.treeKey : '';
    byId('file-tree').replaceChildren();
    byId('file-tree').hidden = true;
    const code = byId('code');
    code.className = '';
    byId('problem-details').hidden = true;
    if (!result) {
      hideHex();
      code.textContent = state.enabled.length ? (state.codeRunning ? 'Generating…' : '') : 'Choose at least one target.';
      return;
    }
    if (!result.ok) { showProblem(result.message); return; }
    const available = result.views || [];
    if (result.pending && !available.length) {
      hideHex();
      const target = state.targets.find((item) => item.id === result.id);
      code.textContent = 'Building ' + (result.label || (target ? target.label : result.id)) + '…';
      return;
    }
    if (!available.some((item) => item.id === views[result.id])) {
      views[result.id] = available[0] ? available[0].id : '';
    }
    if (available.length > 1) {
      for (const item of available) {
        viewTabs.append(tab(item.label, item.id === views[result.id], !item.ok,
          () => { views[result.id] = item.id; remember(); render(); }));
      }
    }
    const current = available.find((item) => item.id === views[result.id]);
    if (!current) { hideHex(); code.textContent = ''; return; }
    if (!current.ok) { showProblem(current.message); return; }
    const fileKey = result.id + '/' + current.id;
    const chosen = current.files.find((file) => file.name === files[fileKey]) ||
      current.files.find(file => !file.dependency) || current.files[0];
    if (!chosen) { hideHex(); code.textContent = 'No files.'; return; }
    fileTree(current.files, chosen, fileKey, treeFocus, treeScroll);
    const name = document.createElement('span');
    name.id = 'file-name';
    name.textContent = chosen.name;
    row.append(name);
    if (typeof chosen.filtered === 'string') row.append(filterToggle(chosen.filterLabel || 'Hide headers'));
    if (chosen.binary) {
      if (hexFilterable(chosen.binary.regions)) row.append(filterToggle(chosen.binary.filterLabel || 'Hide headers'));
      showHex(chosen);
      return;
    }
    hideHex();
    let text = programOnly && typeof chosen.filtered === 'string' ? chosen.filtered : chosen.text;
    if (text === undefined && chosen.lazy) {
      text = texts.get(chosen.lazy);
      if (text === undefined) {
        texts.set(chosen.lazy, null);
        api.postMessage({ type: 'text', key: chosen.lazy });
      }
      if (typeof text !== 'string') { code.textContent = 'Loading ' + chosen.name + '…'; return; }
    }
    // Ziran source arrives colored by the extension's grammar.
    const colored = chosen.html || (chosen.lazy && htmls.get(chosen.lazy));
    code.innerHTML = colored || (text.length > 400000 ? escapeHtml(text) : highlight(text, languageOf(chosen.name)));
  }
  return {
    receive(data) {
      if (data.type === 'bytes') {
        hexPages.set(data.key + ':' + Math.floor(data.offset / HEX_PAGE), decode(data.data));
        if (hex && hex.key === data.key) renderHex();
        return true;
      }
      if (data.type === 'text') {
        texts.set(data.key, data.text);
        if (data.html) htmls.set(data.key, data.html);
        render();
        return true;
      }
      return false;
    },
    render(data) {
      state = data;
      if (state.generation !== textGeneration) { textGeneration = state.generation; texts.clear(); htmls.clear(); }
      render();
    },
  };
})();
`;

class TargetInspector {
  // STATE is the page's posted state, which gains the inspector's fields;
  // POST posts it, SEND posts one message, and RERUN runs inspection again
  // after the target checkboxes change.
  constructor({ vscode, state, post, send, storage, rerun }) {
    Object.assign(this, { vscode, state, post, send, rerun });
    this.root = path.join(storage, 'inspect', `${process.pid}-${randomBytes(6).toString('hex')}`);
    this.file = '';
    this.generation = 0;
    this.binaries = new Map();
    this.texts = new Map();
    this.choice = null;
    Object.assign(state, { targets: TARGETS, enabled: [], results: [], codeRunning: true, generation: 0,
      platforms: [], platform: '' });
  }

  // The toolchain's platforms and the selected one, shown in the dropdown.
  async choosePlatform({ command, folders }) {
    this.choice = await platformChoice(command, this.file, folders || [], this.vscode);
    this.state.platforms = this.choice.list.map(({ id, label, gap }) => ({ id, label, gap }));
    this.state.platform = this.choice.platform?.id || '';
    return this.choice;
  }

  workDirectory(file) {
    return path.join(this.root, createHash('sha256').update(file).digest('hex').slice(0, 16));
  }

  retarget(file) {
    if (file === this.file) return;
    if (this.file) fs.rm(this.workDirectory(this.file), { recursive: true, force: true }).catch(() => {});
    this.file = file;
    Object.assign(this.state, { enabled: enabledTargets(file, this.vscode), results: [], codeRunning: true });
  }

  refreshTargets() {
    if (this.file) this.state.enabled = enabledTargets(this.file, this.vscode);
  }

  beginRegistration() {
    this.generation++;
    this.state.generation = this.generation;
    this.binaries = new Map();
    this.texts = new Map();
  }

  lazyFile(id, view, file) {
    const { load, ...rest } = file;
    const key = `${this.generation}:${id}:${view}:${file.name}`;
    this.texts.set(key, { load, name: file.name });
    return { ...rest, lazy: key };
  }

  // Binaries reach the webview as a key, their size and their regions.
  async registerResult(result) {
    for (const item of result.views || []) {
      item.files = (item.files || []).map((file) => typeof file.load === 'function' ?
        this.lazyFile(result.id, item.id, file) : file);
      for (const file of item.files) {
        // Ziran source is colored by the extension's grammar.
        const html = await highlightedFile(file.name, file.text);
        if (html) file.html = html;
        if (!file.binary?.path) continue;
        const key = `${this.generation}:${result.id}:${item.id}:${file.name}`;
        this.binaries.set(key, file.binary.path);
        let layout = file.binary.regions ? file.binary : null;
        if (!layout) {
          try { layout = binaryRegions(await fs.readFile(file.binary.path)); } catch {}
        }
        file.binary = { key, size: file.binary.size,
          ...(layout ? { regions: layout.regions, filterLabel: layout.filterLabel } : {}) };
      }
    }
    return result;
  }

  // Build every enabled target for the current file; each tab fills in as
  // its own build finishes, while still showing the last run's output.
  async inspect({ command, paths, hasMain, entry, noMain, folders }) {
    const file = this.file;
    const previous = new Map(this.state.results.map((result) => [result.id, result]));
    this.state.results = this.state.enabled.map((target) =>
      ({ ...(previous.get(target) || { id: target, ok: true, views: [] }), pending: true }));
    this.state.codeRunning = true;
    this.beginRegistration();
    const generation = this.generation;
    this.post();
    const work = path.join(this.workDirectory(file), 'targets');
    const { platform } = await this.choosePlatform({ command, folders });
    if (generation !== this.generation) return;
    this.post();
    const options = { hasMain, entry, noMain, folders, platform };
    const pipeline = this.state.enabled.length ?
      startPipeline(command, file, path.join(work, 'pipeline'), paths, { ...options, targets: this.state.enabled }) : null;
    await Promise.all(this.state.enabled.map((target, index) =>
      buildTarget(command, target, file, work, paths, { ...options, pipeline }).then(async (result) => {
        if (generation !== this.generation) return;
        await this.registerResult(result);
        if (generation === this.generation && this.state.results[index]?.id === target) {
          this.state.results[index] = result;
          this.post();
        }
      })));
    if (generation === this.generation) this.state.codeRunning = false;
  }

  // Webview requests: pages of bytes, dependency texts, target and platform choices.
  // Returns whether MESSAGE was one of them.
  async message(message) {
    if (message.type === 'bytes') { await this.sendBytes(message); return true; }
    if (message.type === 'text') { await this.sendText(message); return true; }
    if (message.type === 'targets' && Array.isArray(message.enabled)) {
      const enabled = TARGETS.map((target) => target.id).filter((id) => message.enabled.includes(id));
      const uri = this.vscode.Uri.file(this.file);
      const scope = this.vscode.workspace.getWorkspaceFolder?.(uri) ?
        this.vscode.ConfigurationTarget.WorkspaceFolder : this.vscode.ConfigurationTarget.Global;
      this.state.enabled = enabled;
      await this.vscode.workspace.getConfiguration('ziran', uri).update('previewTargets', enabled, scope);
      this.rerun();
      return true;
    }
    if (message.type === 'platform' && typeof message.id === 'string') {
      const platform = this.state.platforms.find((item) => item.id === message.id);
      if (!platform || platform.gap) return true;
      const uri = this.vscode.Uri.file(this.file);
      const scope = this.vscode.workspace.getWorkspaceFolder?.(uri) ?
        this.vscode.ConfigurationTarget.WorkspaceFolder : this.vscode.ConfigurationTarget.Global;
      this.state.platform = platform.id;
      await this.vscode.workspace.getConfiguration('ziran', uri).update('previewPlatform', platform.id, scope);
      this.rerun();
      return true;
    }
    return false;
  }

  // One page of a binary, read only from files this run's results listed.
  async sendBytes(message) {
    const file = this.binaries.get(message.key);
    const offset = Number(message.offset);
    if (!file || !Number.isSafeInteger(offset) || offset < 0) return;
    const length = Math.min(Math.max(0, Number(message.length) || 0), HEX_REQUEST_LIMIT);
    let data = '';
    try {
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        data = buffer.subarray(0, bytesRead).toString('base64');
      } finally { await handle.close(); }
    } catch {}
    this.send({ type: 'bytes', key: message.key, offset, data });
  }

  // A dependency file's text, read or generated when the view first shows it.
  async sendText(message) {
    const entry = this.texts.get(message.key);
    let text = 'This file belongs to an earlier build; it returns when the current build finishes.';
    let html = null;
    if (entry) {
      try { text = await entry.load(); } catch (error) { text = error.message; }
      html = await highlightedFile(entry.name, String(text));
    }
    this.send({ type: 'text', key: message.key, text: String(text), ...(html ? { html } : {}) });
  }

  dispose() {
    this.generation++;
    fs.rm(this.root, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { HEX_REQUEST_LIMIT, HEX_VIEW_SOURCE, HIGHLIGHT_SOURCE, INSPECTOR_MARKUP, INSPECTOR_SCRIPT,
  INSPECTOR_STYLE, TargetInspector };
