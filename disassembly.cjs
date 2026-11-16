// The whole of a direct ELF as one listing: its headers, every region of the
// file in order, code disassembled by objdump with function labels from the
// native map, and data as bytes. Ziran's direct ELFs carry no section
// headers, so objdump reads each code range as raw bytes at its address.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EXECUTABLE_KINDS, binaryRegions, flagText, loadedAddress, parseElf } = require('./binary-layout.cjs');

const ARCHES = {
  62: { name: 'x86-64', objdump: 'i386:x86-64', tools: ['objdump'], variable: true },
  3: { name: 'x86', objdump: 'i386', tools: ['objdump'], variable: true },
  183: { name: 'AArch64', objdump: 'aarch64', tools: ['aarch64-linux-gnu-objdump', 'objdump'] },
  40: { name: 'ARM', objdump: 'arm', tools: ['arm-linux-gnueabihf-objdump', 'objdump'] },
  243: { name: 'RISC-V', objdump: 'riscv', tools: ['riscv64-linux-gnu-objdump', 'objdump'] },
};
const ELF_TYPES = { 1: 'REL (relocatable)', 2: 'EXEC (executable)', 3: 'DYN (shared object)', 4: 'CORE' };
const SEGMENT_TYPES = { 0: 'NULL', 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 4: 'NOTE', 6: 'PHDR', 7: 'TLS',
  0x6474e550: 'GNU_EH_FRAME', 0x6474e551: 'GNU_STACK', 0x6474e552: 'GNU_RELRO', 0x6474e553: 'GNU_PROPERTY' };
// Rounds of re-decoding at a branch target the first linear pass ran past.
const RESYNC_LIMIT = 256;

const hex = (value) => `0x${value.toString(16)}`;
const bare = (value) => value.toString(16);

function architecture(elf, map) {
  if (/^aarch64|^arm64/.test(map?.target || '')) return ARCHES[183];
  if (/^x86_64/.test(map?.target || '')) return ARCHES[62];
  return ARCHES[elf.machine] || null;
}

function runObjdump(tool, args, file) {
  return new Promise((resolve) => {
    const descriptor = fsSync.openSync(file, 'w');
    const child = spawn(tool, args, { stdio: ['ignore', descriptor, 'pipe'], windowsHide: true });
    let message = '';
    child.stderr.on('data', (data) => { message = (message + data.toString()).slice(-8192); });
    const done = (result) => { fsSync.closeSync(descriptor); resolve(result); };
    child.on('error', (error) => done({ code: null, message: error.message }));
    child.on('close', (code) => done({ code, message }));
  });
}

// Instructions of [START, END) in virtual addresses, from file bytes that
// load at ADJUST plus their offset.
function objdumpDecoder(elfFile, arch, work) {
  let tool = null;
  return async (adjust, start, end) => {
    const listing = path.join(work, 'objdump.txt');
    const args = ['-D', '-z', '-b', 'binary', '-m', arch.objdump, '--insn-width=16',
      `--adjust-vma=${hex(adjust)}`, `--start-address=${hex(start)}`, `--stop-address=${hex(end)}`, elfFile];
    let result = null;
    for (const candidate of tool ? [tool] : arch.tools) {
      result = await runObjdump(candidate, args, listing);
      if (result.code === 0) { tool = candidate; break; }
    }
    if (result.code !== 0) {
      throw new Error((result.message || '').trim().split('\n')[0] ||
        `objdump could not disassemble ${arch.name} code`);
    }
    const lines = [];
    for (const line of (await fs.readFile(listing, 'utf8')).split('\n')) {
      const match = /^\s*([0-9a-f]+):\t((?:[0-9a-f]{2} ?)+)\s*(?:\t(.*))?$/.exec(line);
      if (!match) continue;
      const bytes = match[2].trim().split(/\s+/);
      lines.push({ address: parseInt(match[1], 16), size: bytes.length, bytes, text: (match[3] || '').trim() });
    }
    await fs.rm(listing, { force: true });
    return lines;
  };
}

function branchTarget(text) {
  const match = /^(?:call|j[a-z]{1,4}|loop[a-z]*|b|bl|b\.[a-z]+|cbn?z|tbn?z)\s+(?:[^,]+,\s*)*0x([0-9a-f]+)\b/.exec(text);
  return match ? parseInt(match[1], 16) : null;
}

// A linear pass over variable-length code runs past a function that follows
// padding or data. Re-decode from each such start (a map boundary or a
// branch target) until the passes agree again.
async function decodeSpan(decode, adjust, start, end, anchors, variable) {
  let lines = await decode(adjust, start, end);
  if (!variable) return lines;
  const tried = new Set();
  for (let round = 0; round < RESYNC_LIMIT; round++) {
    const starts = new Set(lines.map((line) => line.address));
    const wanted = new Set(anchors);
    for (const line of lines) {
      const target = branchTarget(line.text);
      if (target !== null) wanted.add(target);
    }
    const missing = [...wanted].filter((address) => address > start && address < end &&
      !starts.has(address) && !tried.has(address)).sort((left, right) => left - right);
    if (!missing.length) break;
    const at = missing[0];
    tried.add(at);
    const cut = lines.findIndex((line) => line.address + line.size > at);
    if (cut < 0) { lines = [...lines, ...await decode(adjust, at, end)]; continue; }
    const before = lines.slice(0, cut);
    const after = lines.slice(cut + 1);
    const overlapped = lines[cut];
    const raw = overlapped.bytes.slice(0, at - overlapped.address);
    const gap = raw.length ? [{ address: overlapped.address, size: raw.length, bytes: raw, text: '' }] : [];
    const later = new Map(after.map((line, index) => [line.address, index]));
    let fresh = await decode(adjust, at, Math.min(end, at + 4096));
    let sync = fresh.findIndex((line) => later.has(line.address));
    if (sync < 0 && at + 4096 < end) {
      fresh = await decode(adjust, at, end);
      sync = fresh.findIndex((line) => later.has(line.address));
    }
    lines = sync < 0 ? [...before, ...gap, ...fresh] :
      [...before, ...gap, ...fresh.slice(0, sync), ...after.slice(later.get(fresh[sync].address))];
  }
  return lines;
}

function instructionText(line) {
  return `  ${bare(line.address)}:\t${line.bytes.join(' ').padEnd(21)}\t${line.text}`.trimEnd();
}

// Instruction lines, with runs of zero bytes shown as one padding line.
function codeLines(lines) {
  const out = [];
  for (let index = 0; index < lines.length; index++) {
    let last = index;
    let size = 0;
    while (last < lines.length && lines[last].bytes.every((byte) => byte === '00')) size += lines[last++].size;
    if (size >= 4) {
      out.push(`  ${bare(lines[index].address)}–${bare(lines[index].address + size)}  padding · ${size} bytes`);
      index = last - 1;
    } else {
      out.push(instructionText(lines[index]));
    }
  }
  return out;
}

// Bytes as rows of sixteen at their addresses, with runs of zero rows
// shown as one line.
function byteLines(data, start, end, address) {
  const out = [];
  const rowEnd = (offset) => Math.min(end, offset + 16);
  const zeroRow = (offset) => data.subarray(offset, rowEnd(offset)).every((byte) => byte === 0);
  for (let offset = start; offset < end;) {
    let zero = offset;
    while (zero < end && zeroRow(zero)) zero = rowEnd(zero);
    if (zero - offset >= 32) {
      out.push(`  ${bare(address + offset - start)}–${bare(address + zero - start)}  zero bytes · ${zero - offset}`);
      offset = zero;
      continue;
    }
    const row = data.subarray(offset, rowEnd(offset));
    const bytes = [...row].map((byte) => byte.toString(16).padStart(2, '0'));
    const text = [...row].map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('');
    out.push(`  ${bare(address + offset - start)}:  ${[...bytes.slice(0, 8), '', ...bytes.slice(8)].join(' ').padEnd(48)}  |${text}|`);
    offset += row.length;
  }
  return out;
}

function headerLines(elf, arch) {
  const lines = ['ELF header',
    `  ${elf.is64 ? 'ELF64' : 'ELF32'}, ${elf.little ? 'little' : 'big'} endian, OS/ABI ${elf.abi}, version ${elf.version}`,
    `  type ${ELF_TYPES[elf.type] || elf.type}, machine ${arch ? arch.name : elf.machine}, entry ${hex(elf.entry)}, flags ${hex(elf.flags)}`,
    `  ${elf.programCount} program headers at ${hex(elf.programOffset)}, ${elf.programEntrySize} bytes each`,
    elf.sectionCount ? `  ${elf.sectionCount} section headers at ${hex(elf.sectionOffset)}, ${elf.sectionEntrySize} bytes each` :
      '  no section headers',
    '', 'Program headers'];
  const rows = [['#', 'type', 'offset', 'vaddr', 'filesz', 'memsz', 'flags', 'align'],
    ...elf.segments.map((segment) => [String(segment.index), SEGMENT_TYPES[segment.type] || hex(segment.type),
      hex(segment.offset), hex(segment.address), hex(segment.fileSize), hex(segment.memorySize),
      flagText(segment.flags), hex(segment.align)])];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) lines.push(`  ${row.map((cell, column) => cell.padEnd(widths[column])).join('  ')}`.trimEnd());
  return lines;
}

// FILE's listing: TEXT is the whole file, PROGRAM only the code of the
// program's own functions. Code that cannot be disassembled is shown as bytes
// with objdump's reason.
async function elfListing(file, map, own, work) {
  const data = await fs.readFile(file);
  const elf = parseElf(data);
  const layout = binaryRegions(data, { map, own });
  if (!elf || !layout) throw new Error(`${path.basename(file)} is not a readable ELF file`);
  const arch = architecture(elf, map);
  const decode = arch && objdumpDecoder(file, arch, work);
  const regions = layout.regions.map((region) => ({ ...region, at: loadedAddress(elf, region.start) }));
  const executable = (region) => EXECUTABLE_KINDS.includes(region.kind) && region.at &&
    (region.at.segment.flags & 1) && region.end <= region.at.segment.offset + region.at.segment.fileSize;

  // One objdump pass per run of adjacent code regions.
  const decoded = new Map();
  for (let index = 0; index < regions.length;) {
    if (!executable(regions[index])) { index++; continue; }
    const first = index;
    const segment = regions[index].at.segment;
    while (index + 1 < regions.length && executable(regions[index + 1]) &&
      regions[index + 1].at.segment === segment && regions[index + 1].start === regions[index].end) index++;
    const span = regions.slice(first, index + 1);
    const adjust = segment.address - segment.offset;
    const start = span[0].start + adjust;
    const end = span[span.length - 1].end + adjust;
    let lines = null;
    let problem = arch ? '' : `objdump has no disassembler named for ELF machine ${elf.machine}`;
    if (decode) {
      try { lines = await decodeSpan(decode, adjust, start, end, span.map((item) => item.start + adjust), arch.variable); }
      catch (error) { problem = error.message; }
    }
    for (const region of span) {
      const from = region.start + adjust;
      const to = region.end + adjust;
      decoded.set(region, lines ? codeLines(lines.filter((line) => line.address >= from && line.address < to)) :
        [`  ${problem}`, ...byteLines(data, region.start, region.end, from)]);
    }
    index++;
  }

  const text = [...headerLines(elf, arch), ''];
  const program = [];
  let block = false;
  for (const region of regions) {
    const code = decoded.get(region);
    if (code || region.kind === 'data') {
      const lines = code || byteLines(data, region.start, region.end, region.at ? region.at.address : region.start);
      text.push('', `<${region.label}>:`, ...lines);
      if (region.kind === 'code' && code) program.push(...(program.length ? [''] : []), `<${region.label}>:`, ...code);
      block = true;
    } else {
      if (block) { text.push(''); block = false; }
      text.push(`file ${hex(region.start)}–${hex(region.end)}  ${region.label} · ${region.end - region.start} bytes`);
    }
    const segment = region.at?.segment;
    if (segment && region.end === segment.offset + segment.fileSize && segment.memorySize > segment.fileSize) {
      const from = segment.address + segment.fileSize;
      text.push(`  ${bare(from)}–${bare(segment.address + segment.memorySize)}  zero-filled in memory · ${segment.memorySize - segment.fileSize} bytes`);
    }
  }
  return { text: `${text.join('\n')}\n`, program: `${program.join('\n')}\n`, regions: layout.regions,
    filterLabel: layout.filterLabel };
}

module.exports = { branchTarget, decodeSpan, elfListing };
