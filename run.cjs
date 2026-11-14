const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { isKryonProgram, previewLocation, projectRoot, runCommand, safeEnvironment } = require('./preview.cjs');
const { TARGETS, buildTarget, bundleArgs, enabledTargets, importingPrograms, irArgs, mainLine,
  modulePaths, noMainMessage, packageRoot, ziranCommand, ziranTool } = require('./targets.cjs');

const RUN_TIMEOUT_MS = 10000;
// The portable runtime has no window host, so a kryon/app program is not run
// there: App.Run would only return its failure status.
const KRYON_PROGRAM_NOTICE = 'This Kryon program opens its own window. Run it with ▶ to see it live ' +
  'in the Kryon preview, or use Open in New Window there. The targets below show its generated code.';
// The most one hex view request reads from a binary.
const HEX_REQUEST_LIMIT = 1024 * 1024;

// Locate the most useful bytes in an ELF. A named main function wins over
// startup code, followed by .text and finally the executable entry segment.
// Every offset and table is checked before it is read; bad files return null.
function elfCodeStart(input) {
  try {
    if (!Buffer.isBuffer(input)) return null;
    const data = input;
    if (data.length < 16 || data[0] !== 0x7f || data[1] !== 0x45 ||
        data[2] !== 0x4c || data[3] !== 0x46 || data[6] !== 1) return null;
    const elfClass = data[4];
    const encoding = data[5];
    if ((elfClass !== 1 && elfClass !== 2) || (encoding !== 1 && encoding !== 2)) return null;
    const little = encoding === 1;
    const is64 = elfClass === 2;
    const headerSize = is64 ? 64 : 52;
    const sectionSize = is64 ? 64 : 40;
    const programSize = is64 ? 56 : 32;
    const symbolSize = is64 ? 24 : 16;
    const fits = (offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
      offset >= 0 && length >= 0 && offset <= data.length && length <= data.length - offset;
    const u16 = (offset) => fits(offset, 2) ?
      (little ? data.readUInt16LE(offset) : data.readUInt16BE(offset)) : null;
    const u32 = (offset) => fits(offset, 4) ?
      (little ? data.readUInt32LE(offset) : data.readUInt32BE(offset)) : null;
    const word = (offset) => {
      if (!is64) return u32(offset);
      if (!fits(offset, 8)) return null;
      const value = little ? data.readBigUInt64LE(offset) : data.readBigUInt64BE(offset);
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    };
    const tableFits = (offset, entrySize, count) => Number.isSafeInteger(count) && count >= 0 &&
      Number.isSafeInteger(entrySize) && entrySize > 0 && Number.isSafeInteger(offset) &&
      offset >= 0 && offset <= data.length && count <= Math.floor((data.length - offset) / entrySize);
    const cString = (offset, size, at) => {
      if (!fits(offset, size) || !Number.isSafeInteger(at) || at < 0 || at >= size) return null;
      const start = offset + at;
      const length = data.subarray(start, offset + size).indexOf(0);
      return length < 0 ? null : data.toString('ascii', start, start + length);
    };
    if (!fits(0, headerSize) || u32(20) !== 1) return null;

    const type = u16(16);
    const entry = word(24);
    const programOffset = word(is64 ? 32 : 28);
    const sectionOffset = word(is64 ? 40 : 32);
    const elfHeaderSize = u16(is64 ? 52 : 40);
    const programEntrySize = u16(is64 ? 54 : 42);
    let programCount = u16(is64 ? 56 : 44);
    const sectionEntrySize = u16(is64 ? 58 : 46);
    let sectionCount = u16(is64 ? 60 : 48);
    let stringSectionIndex = u16(is64 ? 62 : 50);
    if ([type, entry, programOffset, sectionOffset, elfHeaderSize, programEntrySize, programCount,
      sectionEntrySize, sectionCount, stringSectionIndex].some((value) => value === null) ||
      elfHeaderSize < headerSize || !fits(0, elfHeaderSize)) return null;

    const noSections = sectionOffset === 0 && sectionCount === 0;
    let sections = [];
    let sectionZero = null;
    if (!noSections) {
      if (sectionOffset === 0 || sectionEntrySize < sectionSize ||
          !tableFits(sectionOffset, sectionEntrySize, 1)) return null;
      sectionZero = sectionOffset;
      if (sectionCount === 0) sectionCount = word(sectionZero + (is64 ? 32 : 20));
      if (stringSectionIndex === 0xffff) stringSectionIndex = u32(sectionZero + (is64 ? 40 : 24));
      if (!Number.isSafeInteger(sectionCount) || sectionCount <= 0 ||
          !Number.isSafeInteger(stringSectionIndex) || stringSectionIndex >= sectionCount ||
          !tableFits(sectionOffset, sectionEntrySize, sectionCount)) return null;
      for (let index = 0; index < sectionCount; index++) {
        const header = sectionOffset + index * sectionEntrySize;
        const section = {
          index,
          nameOffset: u32(header),
          type: u32(header + 4),
          flags: word(header + 8),
          address: word(header + (is64 ? 16 : 12)),
          offset: word(header + (is64 ? 24 : 16)),
          size: word(header + (is64 ? 32 : 20)),
          link: u32(header + (is64 ? 40 : 24)),
          entrySize: word(header + (is64 ? 56 : 36)),
          name: '',
        };
        if (Object.values(section).some((value) => value === null)) return null;
        sections.push(section);
      }
      if (stringSectionIndex > 0) {
        const strings = sections[stringSectionIndex];
        if (strings.type !== 3 || !fits(strings.offset, strings.size)) return null;
        for (const section of sections) {
          section.name = cString(strings.offset, strings.size, section.nameOffset);
          if (section.name === null) return null;
        }
      }

      let qualifiedMain = null;
      const symbolTables = sections.filter((section) => section.type === 2 || section.type === 11)
        .sort((left, right) => left.type - right.type);
      for (const table of symbolTables) {
        if (table.entrySize < symbolSize || table.size % table.entrySize !== 0 ||
            !fits(table.offset, table.size) || table.link >= sections.length) return null;
        const names = sections[table.link];
        if (names.type !== 3 || !fits(names.offset, names.size)) return null;
        const count = table.size / table.entrySize;
        for (let index = 0; index < count; index++) {
          const symbol = table.offset + index * table.entrySize;
          const nameOffset = u32(symbol);
          const info = fits(symbol + (is64 ? 4 : 12), 1) ? data[symbol + (is64 ? 4 : 12)] : null;
          const sectionIndex = u16(symbol + (is64 ? 6 : 14));
          const value = word(symbol + (is64 ? 8 : 4));
          if ([nameOffset, info, sectionIndex, value].some((item) => item === null)) return null;
          if ((info & 0x0f) !== 2 || sectionIndex <= 0 || sectionIndex >= sections.length) continue;
          const name = cString(names.offset, names.size, nameOffset);
          if (name === null) return null;
          if (name !== 'main' && name !== 'main.main' && !name.endsWith(':main')) continue;
          const target = sections[sectionIndex];
          const delta = type === 1 ? value : value - target.address;
          const offset = target.offset + delta;
          if (!Number.isSafeInteger(delta) || delta < 0 || delta >= target.size ||
              target.type === 8 || !fits(offset, 1)) continue;
          const found = { offset, label: `${name} at 0x${offset.toString(16)} (${target.name || 'code'})`,
            toggleLabel: 'Show ELF headers' };
          if (name === 'main') return found;
          if (!qualifiedMain) qualifiedMain = found;
        }
      }
      if (qualifiedMain) return qualifiedMain;

      const text = sections.filter((section) => section.name === '.text' && (section.flags & 4) &&
        section.size > 0 && fits(section.offset, section.size))
        .sort((left, right) => left.offset - right.offset)[0];
      if (text) return { offset: text.offset,
        label: `code starts at 0x${text.offset.toString(16)} (.text)`,
        toggleLabel: 'Show ELF headers' };
    }

    if (programCount === 0xffff) {
      programCount = sectionZero === null ? null : u32(sectionZero + (is64 ? 44 : 28));
    }
    if (!Number.isSafeInteger(programCount) || programCount <= 0 || programOffset <= 0 ||
        programEntrySize < programSize ||
        !tableFits(programOffset, programEntrySize, programCount)) return null;
    for (let index = 0; index < programCount; index++) {
      const header = programOffset + index * programEntrySize;
      const segmentType = u32(header);
      const flags = u32(header + (is64 ? 4 : 24));
      const offset = word(header + (is64 ? 8 : 4));
      const address = word(header + (is64 ? 16 : 8));
      const fileSize = word(header + (is64 ? 32 : 16));
      const memorySize = word(header + (is64 ? 40 : 20));
      if ([segmentType, flags, offset, address, fileSize, memorySize]
        .some((value) => value === null)) return null;
      if (segmentType !== 1 || !(flags & 1) || memorySize <= 0 || entry < address ||
          entry - address >= memorySize) continue;
      const entryDelta = entry - address;
      if (fileSize <= 0 || entryDelta >= fileSize || !fits(offset, fileSize)) return null;
      return { offset, label: `code starts at 0x${offset.toString(16)} (entry segment)`,
        toggleLabel: 'Show ELF headers' };
    }
  } catch {}
  return null;
}

function wasmCodeStart(data) {
  try {
    if (!Buffer.isBuffer(data) || data.length < 8 ||
        !data.subarray(0, 8).equals(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))) return null;
    const varuint = (offset) => {
      let value = 0;
      let scale = 1;
      for (let index = 0; index < 5 && offset + index < data.length; index++) {
        const byte = data[offset + index];
        if (index === 4 && (byte & 0xf0)) return null;
        value += (byte & 0x7f) * scale;
        if (!(byte & 0x80)) return { value, next: offset + index + 1 };
        scale *= 128;
      }
      return null;
    };
    let offset = 8;
    while (offset < data.length) {
      const id = data[offset++];
      const length = varuint(offset);
      if (!length || length.value > data.length - length.next) return null;
      const end = length.next + length.value;
      if (id === 10 && length.value > 0) return { offset: length.next,
        label: `code starts at 0x${length.next.toString(16)} (Wasm code section)`,
        toggleLabel: 'Show full file' };
      offset = end;
    }
  } catch {}
  return null;
}

function zxInstructionStart(data) {
  try {
    if (!Buffer.isBuffer(data) || data.length < 64 || data[0] !== 0x5a || data[1] !== 0x58 ||
        data[2] !== 0 || data[3] !== 0 || data.readUInt32LE(4) !== 28 ||
        data.readUInt32LE(8) !== 64 || data.readUInt32LE(12) !== 32 ||
        data.readBigUInt64LE(16) !== 1n || data.readUInt32LE(36) !== 0 ||
        data.readBigUInt64LE(40) !== BigInt(data.length) || data.readBigUInt64LE(48) !== 64n ||
        data.readUInt32LE(56) !== 1 || data.readUInt32LE(60) !== 0) return null;
    const count = data.readUInt32LE(32);
    if (count < 3 || count > 1024 || count > Math.floor((data.length - 64) / 32)) return null;
    let previousKind = 0;
    let previousEnd = 64 + count * 32;
    let program = null;
    for (let index = 0; index < count; index++) {
      const record = 64 + index * 32;
      const kind = data.readUInt32LE(record);
      const flags = data.readUInt32LE(record + 4);
      const offset64 = data.readBigUInt64LE(record + 8);
      const length64 = data.readBigUInt64LE(record + 16);
      const alignment = data.readUInt32LE(record + 24);
      if (offset64 > BigInt(Number.MAX_SAFE_INTEGER) || length64 > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const offset = Number(offset64);
      const length = Number(length64);
      if (kind <= previousKind || flags > 1 || alignment === 0 || alignment > 4096 ||
          (alignment & (alignment - 1)) !== 0 || offset % alignment !== 0 ||
          offset < previousEnd || length > data.length - offset || data.readUInt32LE(record + 28) !== 0) return null;
      for (let byte = previousEnd; byte < offset; byte++) if (data[byte] !== 0) return null;
      if (kind === 2 && (flags & 1) && length > 0) program = offset;
      previousKind = kind;
      previousEnd = offset + length;
    }
    if (previousEnd !== data.length || program === null) return null;
    return { offset: program,
      label: `instructions start at 0x${program.toString(16)} (ZX program section)`,
      toggleLabel: 'Show full file' };
  } catch {}
  return null;
}

function binaryContentStart(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return null;
  if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) {
    return elfCodeStart(data);
  }
  if (data[0] === 0 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d) {
    return wasmCodeStart(data);
  }
  if (data[0] === 0x5a && data[1] === 0x58 && data[2] === 0 && data[3] === 0) {
    return zxInstructionStart(data);
  }
  return null;
}

// Shared by the webview and unit tests. Passing a goto offset inside a hidden
// prefix reveals the headers before the scroll position is calculated.
const HEX_VIEW_SOURCE = String.raw`
function hexWindow(codeStart, showFullFile, gotoOffset) {
  const code = Number.isSafeInteger(codeStart) && codeStart > 0 ? codeStart : 0;
  const reveal = Number.isSafeInteger(gotoOffset) && gotoOffset >= 0 && gotoOffset < code;
  const fullFile = Boolean(showFullFile || reveal);
  return { showFullFile: fullFile, start: fullFile ? 0 : code };
}
`;

// `ziran bundle --root . --entry hello:main -o hello.zx hello.zi`, then
// `ziran run hello.zx`: the file's main on the portable runtime. A project
// bundle is written by the project's pinned toolchain, such as a
// ziran.local.toml checkout, so `run --project` reads it with that same
// toolchain instead of whichever one the launcher belongs to.
function runSteps(command, file, paths, bundle, project = false) {
  return [{ command, args: bundleArgs(file, paths, bundle, project) },
    { command, args: project ? ['run', '--project', bundle] : ['run', bundle] }];
}

function versionMismatchProblem(message, ziran, zi2zx) {
  if (!/(?:unsupported ZIR version|invalid embedded ZIR)/i.test(message)) return message;
  return `${message}\n\nToolchain paths:\n  ziran: ${ziran}\n  zi2zx: ${zi2zx || 'not found'}`;
}

async function commandPath(command, cwd, environment = process.env) {
  if (path.isAbsolute(command)) return command;
  if (command.includes('/') || command.includes('\\')) return path.resolve(cwd, command);
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return command;
}

function execute(command, args, cwd, timeout) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: safeEnvironment(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

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
  if (/\.go$/.test(name)) return 'go';
  if (/\.rs$/.test(name)) return 'rust';
  if (/\.py$/.test(name)) return 'py';
  if (/\.(c|h)$/.test(name)) return 'c';
  return '';
}
function highlight(text, language) {
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

function runHtml(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  h1 { font-size: 1.1rem; margin: 0; }
  h2 { font-size: 0.95rem; }
  button, select { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  select { max-width: 100%; }
  #status { color: var(--vscode-descriptionForeground); }
  #status.failed { color: var(--vscode-errorForeground); }
  .window { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; background: var(--vscode-terminal-background, #10141a); }
  .window-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; background: var(--vscode-titleBar-activeBackground, #252526); border-bottom: 1px solid var(--vscode-panel-border); }
  .window-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .55; }
  #window-title { margin-left: 8px; font-size: .85rem; }
  #time { margin-left: auto; font-size: .8rem; color: var(--vscode-descriptionForeground); }
  #screen { box-sizing: border-box; min-height: 8em; margin: 0; padding: 12px 14px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--vscode-terminal-foreground, #d4d4d4); font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.4; border: 0; }
  #screen.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .problems:empty { display: none; }
  .problems { margin: 12px 0 0; padding: 10px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); white-space: pre-wrap; color: var(--vscode-errorForeground); }
  pre { box-sizing: border-box; overflow: auto; white-space: pre; font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.35; border: 1px solid var(--vscode-panel-border); padding: 10px; margin: 0; background: var(--vscode-textCodeBlock-background, transparent); }
  details { margin-top: 16px; }
  summary { cursor: pointer; font-weight: bold; margin-bottom: 8px; }
  .targets { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
  .tabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; }
  .tab { background: transparent; color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
  .tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); font-weight: bold; }
  .tab.failed { color: var(--vscode-errorForeground); }
  .tab.pending { opacity: .7; }
  .file-row { margin-bottom: 8px; }
  .file-row:empty { display: none; }
  .views:empty { display: none; }
  .views .tab { font-size: .9em; }
  .caption { color: var(--vscode-descriptionForeground); font-size: .85em; margin-bottom: 6px; }
  .caption:empty { display: none; }
  [hidden] { display: none !important; }
  .hex-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
  .hex-bar input[type="text"] { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 14em; }
  .hex-scroll { position: relative; height: 60vh; overflow: auto; border: 1px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background, transparent); }
  #hex-spacer { width: 1px; }
  #hex-rows { position: absolute; left: 0; top: 0; margin: 0; border: 0; padding: 0 10px; line-height: 18px; overflow: visible; background: transparent; }
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
</style></head><body>
<header><h1>Ziran Run</h1><button id="run">Run again</button><span id="status">Starting…</span></header>
<div class="window"><div class="window-bar"><span class="window-dot"></span><span class="window-dot"></span><span class="window-dot"></span><span id="window-title"></span><span id="time"></span></div><pre id="screen" role="log" aria-live="polite"></pre></div>
<pre class="problems" id="problems"></pre>
<details id="code-section" open><summary>Generated code</summary>
<div class="targets" id="targets"></div>
<div class="tabs" id="tabs" role="tablist" aria-label="Target"></div>
<div class="tabs views" id="views" role="tablist" aria-label="View"></div>
<div class="file-row" id="file-row"></div>
<div class="caption" id="caption"></div>
<pre id="code"></pre>
<div id="hex" hidden><div class="hex-bar"><span id="hex-title"></span><span id="hex-code"></span><label id="hex-headers-label" hidden><input id="hex-headers" type="checkbox"> <span id="hex-headers-text">Show full file</span></label><input id="hex-goto" type="text" placeholder="Go to offset (hex)" aria-label="Go to offset"></div>
<div class="hex-scroll" id="hex-scroll" tabindex="0" role="region" aria-label="Hex view"><div id="hex-spacer"></div><pre id="hex-rows"></pre></div></div></details>
<script nonce="${nonce}">
${HIGHLIGHT_SOURCE}
${HEX_VIEW_SOURCE}
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const saved = api.getState() || {};
  let state = null;
  let selected = saved.selected || '';
  const files = saved.files || {};
  const views = saved.views || {};
  let showFullFile = saved.showFullFile === true;
  const remember = () => api.setState({ selected, files, views, showFullFile,
    codeOpen: byId('code-section').open });
  if (saved.codeOpen === false) byId('code-section').open = false;
  byId('code-section').addEventListener('toggle', () => { remember(); renderHex(); });

  // Hex view: rows are drawn only for the visible window, and the bytes come
  // from the extension in pages as they scroll into view.
  const HEX_ROW = 18;
  const HEX_PAGE = 65536;
  const HEX_MAX_HEIGHT = 8000000;
  const hexPages = new Map();
  let hex = null;
  const hexStart = () => hexWindow(hex.contentStart, showFullFile).start;
  const hexRows = () => Math.max(1, Math.ceil(Math.max(0, hex.size - hexStart()) / 16));
  const hexScaled = () => hexRows() * HEX_ROW > HEX_MAX_HEIGHT;
  const hexVisible = () => Math.max(1, Math.ceil(byId('hex-scroll').clientHeight / HEX_ROW));
  const hexFirst = () => {
    const box = byId('hex-scroll');
    if (!hexScaled()) return Math.floor(box.scrollTop / HEX_ROW);
    const last = Math.max(0, hexRows() - hexVisible());
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
  const hexLine = (offset, digits) => {
    let bytes = '';
    let text = '';
    for (let index = 0; index < 16; index++) {
      if (index === 8) bytes += ' ';
      if (offset + index >= hex.size) { bytes += '   '; continue; }
      const value = hexByte(offset + index);
      bytes += (value < 0 ? '··' : value.toString(16).padStart(2, '0')) + ' ';
      text += value < 0 ? ' ' : value >= 32 && value < 127 ? String.fromCharCode(value) : '.';
    }
    return offset.toString(16).padStart(digits, '0') + '  ' + bytes + ' |' + text + '|';
  };
  function renderHex() {
    if (!hex || byId('hex').hidden) return;
    const box = byId('hex-scroll');
    const first = hexFirst();
    const start = hexStart();
    const digits = Math.max(8, Math.max(0, hex.size - 1).toString(16).length);
    const lines = [];
    for (let row = first; row < first + hexVisible() + 2 && start + row * 16 < hex.size; row++) {
      lines.push(hexLine(start + row * 16, digits));
    }
    const rows = byId('hex-rows');
    rows.textContent = lines.join('\\n');
    rows.style.top = (hexScaled() ? box.scrollTop : first * HEX_ROW) + 'px';
  }
  const resetHexGeometry = () => {
    byId('hex-spacer').style.height = Math.min(hexRows() * HEX_ROW, HEX_MAX_HEIGHT) + 'px';
    byId('hex-scroll').scrollTop = 0;
    renderHex();
  };
  const showHex = (file) => {
    byId('code').hidden = true;
    byId('hex').hidden = false;
    if (!hex || hex.key !== file.binary.key) {
      const hasContentStart = Number.isSafeInteger(file.binary.contentStart);
      hex = { key: file.binary.key, size: file.binary.size,
        contentStart: hasContentStart ? file.binary.contentStart : 0 };
      byId('hex-title').textContent = file.name + ' · ' + file.binary.size.toLocaleString() + ' bytes';
      byId('hex-code').textContent = hasContentStart ? file.binary.contentLabel : '';
      byId('hex-headers-label').hidden = !hasContentStart || file.binary.contentStart <= 0;
      byId('hex-headers-text').textContent = file.binary.toggleLabel || 'Show full file';
      byId('hex-headers').checked = showFullFile;
      resetHexGeometry();
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
  byId('hex-headers').addEventListener('change', (event) => {
    if (!hex || hex.contentStart <= 0) return;
    showFullFile = event.target.checked;
    remember();
    resetHexGeometry();
  });
  byId('hex-goto').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !hex) return;
    const offset = parseInt(event.target.value.trim().replace(/^0x/i, ''), 16);
    if (!Number.isFinite(offset) || offset < 0) return;
    const wanted = Math.min(Math.max(0, hex.size - 1), offset);
    const window = hexWindow(hex.contentStart, showFullFile, wanted);
    if (window.showFullFile !== showFullFile) {
      showFullFile = window.showFullFile;
      byId('hex-headers').checked = showFullFile;
      remember();
      resetHexGeometry();
    }
    const row = Math.min(hexRows() - 1, Math.max(0, Math.floor((wanted - hexStart()) / 16)));
    const box = byId('hex-scroll');
    const last = Math.max(0, hexRows() - hexVisible());
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
  const showProblem = (message) => {
    hideHex();
    const code = byId('code');
    code.className = 'problems';
    code.textContent = message;
  };
  const renderCode = () => {
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
    const zir = { id: 'zir', label: 'ZIR', ok: !state.irError, message: state.irError,
      views: [{ id: 'checked', label: 'Checked', ok: true, caption: '',
        files: state.irModules.map((module) => ({ name: module.name, text: module.text })) }] };
    const native = (result) => result.id === 'c' || result.id === 'go';
    const results = [...state.results.filter(native), zir,
      ...state.results.filter((result) => !native(result))];
    if (!results.some((result) => result.id === selected)) selected = results[0] ? results[0].id : '';
    const tabs = byId('tabs');
    tabs.replaceChildren();
    for (const result of results) {
      const target = state.targets.find((item) => item.id === result.id);
      tabs.append(tab(result.label || (target ? target.label : result.id), result.id === selected, !result.ok,
        () => { selected = result.id; remember(); renderCode(); }, Boolean(result.pending)));
    }
    const result = results.find((item) => item.id === selected);
    const viewTabs = byId('views');
    viewTabs.replaceChildren();
    const row = byId('file-row');
    row.replaceChildren();
    byId('caption').textContent = '';
    const code = byId('code');
    code.className = '';
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
          () => { views[result.id] = item.id; remember(); renderCode(); }));
      }
    }
    const current = available.find((item) => item.id === views[result.id]);
    if (!current) { hideHex(); code.textContent = ''; return; }
    if (!current.ok) { showProblem(current.message); return; }
    byId('caption').textContent = current.caption || '';
    const fileKey = result.id + '/' + current.id;
    if (current.files.length > 1) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Generated file');
      for (const file of current.files) {
        const option = document.createElement('option');
        option.value = option.textContent = file.name;
        select.append(option);
      }
      select.addEventListener('change', () => { files[fileKey] = select.value; remember(); renderCode(); });
      row.append(select);
    }
    const chosen = current.files.find((file) => file.name === files[fileKey]) || current.files[0];
    if (row.firstChild && chosen) row.firstChild.value = chosen.name;
    if (!chosen) { hideHex(); code.textContent = 'No files.'; return; }
    if (chosen.binary) { showHex(chosen); return; }
    hideHex();
    code.innerHTML = chosen.text.length > 400000 ? escapeHtml(chosen.text) :
      highlight(chosen.text, languageOf(chosen.name));
  };
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'bytes') {
      hexPages.set(data.key + ':' + Math.floor(data.offset / HEX_PAGE), decode(data.data));
      if (hex && hex.key === data.key) renderHex();
      return;
    }
    if (data.type !== 'state') return;
    state = data;
    byId('window-title').textContent = state.title;
    byId('status').textContent = state.status;
    byId('status').className = state.failed ? 'failed' : '';
    byId('time').textContent = state.time;
    const screen = byId('screen');
    screen.textContent = state.output || (state.running ? '' : state.hasMain ? 'No output.' : state.noMain);
    screen.className = state.output ? '' : 'empty';
    byId('problems').textContent = state.problems;
    renderCode();
  });
  byId('run').addEventListener('click', () => api.postMessage({ type: 'run' }));
  api.postMessage({ type: 'ready' });
</script></body></html>`;
}

function workDirectoryFor(file, buildRoot) {
  return path.join(buildRoot,
    createHash('sha256').update(file).digest('hex').slice(0, 16));
}

class RunPreview {
  constructor(file, context, vscode) {
    this.file = file;
    this.vscode = vscode;
    this.disposed = false;
    this.running = false;
    this.rerun = false;
    this.buildRoot = path.join(context.globalStorageUri.fsPath, 'run',
      `${process.pid}-${randomBytes(6).toString('hex')}`);
    this.workDirectory = workDirectoryFor(file, this.buildRoot);
    this.state = { type: 'state', title: path.basename(file), status: 'Starting…',
      output: '', problems: '', time: '', failed: false, running: true, hasMain: true,
      noMain: '', targets: TARGETS, enabled: enabledTargets(file, vscode), results: [],
      irModules: [], irError: '', codeRunning: true };
    this.generation = 0;
    this.binaries = new Map();
    this.panel = vscode.window.createWebviewPanel('ziranRun',
      `Run: ${path.basename(file)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = runHtml(randomBytes(16).toString('hex'));
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.message(message)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.fsPath.endsWith('.zi') &&
            path.dirname(document.uri.fsPath) === path.dirname(this.file)) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('ziran', vscode.Uri.file(this.file))) return;
        this.state.enabled = enabledTargets(this.file, vscode);
        this.schedule();
      }),
    ];
    context.subscriptions.push(this);
    this.run();
  }

  reveal() { this.panel.reveal(this.vscode.ViewColumn.Beside, true); }

  /* The pane follows the focused .zi file: it switches and reruns. */
  retarget(file) {
    if (this.disposed || file === this.file) return;
    fs.rm(this.workDirectory, { recursive: true, force: true }).catch(() => {});
    this.file = file;
    this.workDirectory = workDirectoryFor(file, this.buildRoot);
    this.panel.title = `Run: ${path.basename(file)}`;
    Object.assign(this.state, { title: path.basename(file), status: 'Starting…',
      output: '', problems: '', time: '', failed: false, running: true,
      enabled: enabledTargets(file, this.vscode), results: [], irModules: [],
      irError: '', codeRunning: true });
    this.post();
    this.schedule();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    fs.rm(this.buildRoot, { recursive: true, force: true }).catch(() => {});
  }

  post() { if (!this.disposed) this.panel.webview.postMessage(this.state); }

  schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 250);
  }

  async message(message) {
    if (message.type === 'ready') this.post();
    if (message.type === 'run') this.schedule();
    if (message.type === 'bytes') await this.sendBytes(message);
    if (message.type === 'targets' && Array.isArray(message.enabled)) {
      const enabled = TARGETS.map((target) => target.id)
        .filter((id) => message.enabled.includes(id));
      const uri = this.vscode.Uri.file(this.file);
      const scope = this.vscode.workspace.getWorkspaceFolder?.(uri) ?
        this.vscode.ConfigurationTarget.WorkspaceFolder :
        this.vscode.ConfigurationTarget.Global;
      this.state.enabled = enabled;
      await this.vscode.workspace.getConfiguration('ziran', uri)
        .update('previewTargets', enabled, scope);
      this.schedule();
    }
  }

  // One page of a binary the hex view shows, read only from files this
  // run's results listed.
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
    if (!this.disposed) this.panel.webview.postMessage({ type: 'bytes', key: message.key, offset, data });
  }

  // Binaries stay on disk; the webview receives a key and size and asks for
  // pages of bytes by key.
  beginRegistration() {
    this.generation++;
    this.binaries = new Map();
  }

  async registerResult(result) {
    for (const item of result.views || []) {
      for (const file of item.files || []) {
        if (!file.binary?.path) continue;
        const key = `${this.generation}:${result.id}:${item.id}:${file.name}`;
        this.binaries.set(key, file.binary.path);
        let content = null;
        try { content = binaryContentStart(await fs.readFile(file.binary.path)); } catch {}
        file.binary = { key, size: file.binary.size,
          ...(content ? { contentStart: content.offset, contentLabel: content.label,
            toggleLabel: content.toggleLabel } : {}) };
      }
    }
    return result;
  }

  async runProgram(command, paths, folders) {
    if (!this.state.hasMain) {
      Object.assign(this.state, { output: '', problems: '', time: '', failed: false,
        status: 'No main to run' });
      return;
    }
    if (await isKryonProgram(this.file)) {
      Object.assign(this.state, { output: '', problems: '', time: '', failed: false,
        hasMain: false, noMain: KRYON_PROGRAM_NOTICE, status: 'Runs in the Kryon preview' });
      return;
    }
    const bundle = path.join(this.workDirectory, 'program.zx');
    const project = await packageRoot(this.file);
    const cwd = project || path.dirname(this.file);
    const [bundleStep, runStep] = runSteps(command, this.file, paths, bundle, Boolean(project));
    const started = Date.now();
    const built = await execute(bundleStep.command, bundleStep.args, cwd,
      RUN_TIMEOUT_MS);
    if (built.code !== 0) {
      let problem = (built.stderr || built.stdout).trim() ||
        (built.code === null ? `Could not start ${command}` : `ziran bundle exited with ${built.code}`);
      if (/(?:unsupported ZIR version|invalid embedded ZIR)/i.test(problem)) {
        const resolved = await commandPath(command, cwd);
        const zi2zx = await ziranTool(resolved, 'zi2zx', this.file, folders);
        problem = versionMismatchProblem(problem, resolved, zi2zx);
      }
      Object.assign(this.state, { output: '', time: '', failed: true,
        problems: problem,
        status: 'Build failed' });
      return;
    }
    const ran = await execute(runStep.command, runStep.args, cwd,
      RUN_TIMEOUT_MS);
    const failed = ran.code !== 0 || ran.timedOut;
    Object.assign(this.state, {
      output: ran.stdout,
      problems: ran.stderr.trim(),
      time: `${((Date.now() - started) / 1000).toFixed(2)}s`,
      failed,
      status: ran.timedOut ? `Stopped after ${RUN_TIMEOUT_MS / 1000}s` :
        failed ? `Exited with ${ran.code}` : 'Up to date · reruns on save',
    });
  }

  async inspectIr(command, paths) {
    const output = path.join(this.workDirectory, 'ir');
    await fs.rm(output, { recursive: true, force: true });
    const project = await packageRoot(this.file);
    const saved = await runCommand(command, irArgs(this.file, paths, output, Boolean(project)),
      project || path.dirname(this.file));
    if (saved.code !== 0) {
      this.state.irModules = [];
      this.state.irError = (saved.stderr || saved.stdout).trim() || `ziran ir exited with ${saved.code}`;
      return;
    }
    let names = [];
    try { names = (await fs.readdir(output)).filter((name) => name.endsWith('.zir')).sort(); } catch {}
    const own = `${path.basename(this.file, '.zi')}.zir`;
    names.sort((left, right) => (right === own) - (left === own));
    const modules = [];
    for (const name of names) {
      const inspected = await runCommand(command, ['inspect', path.join(output, name)],
        path.dirname(this.file));
      modules.push({ name, text: inspected.code === 0 ? inspected.stdout : inspected.stderr });
    }
    this.state.irModules = modules;
    this.state.irError = '';
  }

  async run() {
    if (this.disposed) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    Object.assign(this.state, { status: 'Building and running…', running: true,
      failed: false, codeRunning: true });
    this.post();
    try {
      const command = await ziranCommand(this.file, this.vscode);
      const paths = await modulePaths(this.file, command, this.vscode);
      await fs.mkdir(this.workDirectory, { recursive: true });
      let source = '';
      try { source = await fs.readFile(this.file, 'utf8'); } catch {}
      const hasMain = mainLine(source) >= 0;
      const noMain = hasMain ? '' : noMainMessage(this.file, await importingPrograms(this.file));
      Object.assign(this.state, { hasMain, noMain });
      const folders = (this.vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      const program = this.runProgram(command, paths, folders).then(() => {
        this.state.running = false;
        this.post();
      });
      // Every enabled target has its tab at once, still showing the last
      // run's output; each fills in as its own build finishes.
      const previous = new Map(this.state.results.map((result) => [result.id, result]));
      this.state.results = this.state.enabled.map((target) =>
        ({ ...(previous.get(target) || { id: target, ok: true, views: [] }), pending: true }));
      this.beginRegistration();
      this.post();
      await Promise.all([
        ...this.state.enabled.map((target, index) =>
          buildTarget(command, target, this.file, path.join(this.workDirectory, 'targets'), paths,
            { hasMain, noMain, folders }).then(async (result) => {
            await this.registerResult(result);
            if (this.state.results[index]?.id === target) this.state.results[index] = result;
            this.post();
          })),
        this.inspectIr(command, paths).then(() => this.post()),
        program,
      ]);
    } catch (error) {
      Object.assign(this.state, { status: 'Run failed', problems: error.message, failed: true });
    } finally {
      this.running = false;
      Object.assign(this.state, { running: false, codeRunning: false });
      this.post();
      if (this.disposed) await fs.rm(this.buildRoot, { recursive: true, force: true }).catch(() => {});
      if (this.rerun && !this.disposed) { this.rerun = false; this.schedule(); }
    }
  }
}

function activateRun(context, vscode) {
  /* One Run pane, showing whichever .zi file has focus. */
  let pane = null;
  const isZiran = (document) => document?.uri.scheme === 'file' &&
    document.uri.fsPath.endsWith('.zi');
  const openPane = (file) => {
    if (pane) {
      pane.retarget(file);
      pane.reveal();
      pane.schedule();
      return;
    }
    pane = new RunPreview(file, context, vscode);
    const opened = pane;
    pane.panel.onDidDispose(() => { if (pane === opened) pane = null; });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('ziran.run', async (uri) => {
      const document = uri ? await vscode.workspace.openTextDocument(uri) :
        vscode.window.activeTextEditor?.document;
      if (!document || !document.uri.fsPath.endsWith('.zi')) {
        vscode.window.showErrorMessage('Open a .zi file to run it.');
        return;
      }
      if (document.isDirty) await document.save();
      const file = document.uri.fsPath;
      // A Kryon program or project runs live in the Kryon preview.
      if (await previewLocation(file)) {
        await vscode.commands.executeCommand('kryon.preview', document.uri);
        return;
      }
      openPane(file);
    }),
    // The Run pane's target inspection for any file, Kryon programs included.
    vscode.commands.registerCommand('ziran.inspect', async (uri) => {
      const document = uri ? await vscode.workspace.openTextDocument(uri) :
        vscode.window.activeTextEditor?.document;
      if (!document || !document.uri.fsPath.endsWith('.zi')) {
        vscode.window.showErrorMessage('Open a .zi file to inspect its targets.');
        return;
      }
      if (document.isDirty) await document.save();
      openPane(document.uri.fsPath);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (pane && isZiran(editor?.document)) pane.retarget(editor.document.uri.fsPath);
    }),
    vscode.languages.registerCodeLensProvider({ language: 'ziran', scheme: 'file' }, {
      async provideCodeLenses(document) {
        const line = mainLine(document.getText());
        if (line < 0 || await projectRoot(document.uri.fsPath)) return [];
        return [new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: '▶ Run', command: 'ziran.run', arguments: [document.uri],
        })];
      },
    }),
  );
}

module.exports = { HEX_VIEW_SOURCE, HIGHLIGHT_SOURCE, KRYON_PROGRAM_NOTICE, activateRun, binaryContentStart,
  commandPath, elfCodeStart, execute, irArgs, mainLine, runHtml, runSteps,
  versionMismatchProblem, wasmCodeStart, workDirectoryFor, zxInstructionStart };
