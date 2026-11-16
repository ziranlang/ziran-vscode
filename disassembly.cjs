// The whole of a direct ELF or PE as one listing: its headers, every region
// of the file in order, code disassembled by objdump with function labels
// from the native map, and data as bytes. Ziran's direct ELFs carry no
// section headers, so objdump reads each code range as raw bytes at its
// address.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EXECUTABLE_KINDS, binaryRegions, flagText, loadedAddress, parseElf, parsePe, peLoadedAddress } = require('./binary-layout.cjs');

const ARCHES = {
  62: { name: 'x86-64', objdump: 'i386:x86-64', tools: ['objdump'], variable: true },
  3: { name: 'x86', objdump: 'i386', tools: ['objdump'], variable: true },
  183: { name: 'AArch64', objdump: 'aarch64', triple: 'aarch64', tools: ['aarch64-linux-gnu-objdump', 'objdump'] },
  40: { name: 'ARM', objdump: 'arm', triple: 'armv7', tools: ['arm-linux-gnueabihf-objdump', 'objdump'] },
  243: { name: 'RISC-V', objdump: 'riscv', triple: 'riscv64', tools: ['riscv64-linux-gnu-objdump', 'objdump'] },
};
for (const [machine, arch] of Object.entries(ARCHES)) arch.machine = Number(machine);
// PE machines, as the ELF machine with the same instruction set.
const PE_MACHINES = { 0x8664: 62, 0x14c: 3, 0xaa64: 183, 0x1c4: 40 };
const PE_SUBSYSTEMS = { 1: 'native', 2: 'Windows GUI', 3: 'Windows console', 10: 'EFI application' };
const ELF_TYPES = { 1: 'REL (relocatable)', 2: 'EXEC (executable)', 3: 'DYN (shared object)', 4: 'CORE' };
const SEGMENT_TYPES = { 0: 'NULL', 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 4: 'NOTE', 6: 'PHDR', 7: 'TLS',
  0x6474e550: 'GNU_EH_FRAME', 0x6474e551: 'GNU_STACK', 0x6474e552: 'GNU_RELRO', 0x6474e553: 'GNU_PROPERTY' };
// Rounds of re-decoding at a branch target the first linear pass ran past.
const RESYNC_LIMIT = 256;

const hex = (value) => `0x${value.toString(16)}`;
const bare = (value) => value.toString(16);

// The file's own machine decides; the map's target names it only when the
// file's machine is unknown.
function architecture(machine, map) {
  if (ARCHES[machine]) return ARCHES[machine];
  if (/^aarch64|^arm64/.test(map?.target || '')) return ARCHES[183];
  if (/^armv7/.test(map?.target || '')) return ARCHES[40];
  if (/^x86_64/.test(map?.target || '')) return ARCHES[62];
  return null;
}

function runObjdump(tool, args, file) {
  return new Promise((resolve) => {
    const descriptor = fsSync.openSync(file, 'w');
    const child = spawn(tool, args, { stdio: ['ignore', descriptor, 'pipe'], windowsHide: true });
    let message = '';
    child.stderr.on('data', (data) => { message = (message + data.toString()).slice(-8192); });
    // A tool that cannot start reports both error and close; close once.
    let closed = false;
    const done = (result) => { if (closed) return; closed = true; fsSync.closeSync(descriptor); resolve(result); };
    child.on('error', (error) => done({ code: null, message: error.message }));
    child.on('close', (code) => done({ code, message }));
  });
}

// llvm-objdump candidates: on PATH, then the newest Android NDK's.
function llvmObjdumps(environment = process.env) {
  const found = ['llvm-objdump'];
  const roots = [environment.ANDROID_NDK_HOME, environment.ANDROID_NDK_ROOT].filter(Boolean);
  for (const sdk of [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Android', 'Sdk')]) {
    if (!sdk) continue;
    try {
      for (const version of fsSync.readdirSync(path.join(sdk, 'ndk')).sort().reverse()) roots.push(path.join(sdk, 'ndk', version));
    } catch {}
  }
  for (const root of roots) {
    const tool = path.join(root, 'toolchains', 'llvm', 'prebuilt', `${process.platform}-x86_64`, 'bin', 'llvm-objdump');
    if (fsSync.existsSync(tool)) found.push(tool);
  }
  return [...new Set(found)];
}

// A relocatable ELF holding CODE as one .text section at ADDRESS, so
// llvm-objdump, which reads no raw bytes, can disassemble it.
function codeObject(code, address, machine) {
  const is64 = machine === 183 || machine === 62 || machine === 243;
  const headerSize = is64 ? 64 : 52;
  const entrySize = is64 ? 64 : 40;
  const names = Buffer.from('\0.text\0.shstrtab\0');
  const namesAt = headerSize + code.length;
  const table = (namesAt + names.length + 7) & ~7;
  const out = Buffer.alloc(table + 3 * entrySize);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1]).copy(out);
  out.writeUInt16LE(1, 16);
  out.writeUInt16LE(machine, 18);
  out.writeUInt32LE(1, 20);
  if (is64) {
    out.writeBigUInt64LE(BigInt(table), 40);
    out.writeUInt16LE(headerSize, 52); out.writeUInt16LE(entrySize, 58); out.writeUInt16LE(3, 60); out.writeUInt16LE(2, 62);
  } else {
    out.writeUInt32LE(table, 32);
    out.writeUInt32LE(machine === 40 ? 0x05000000 : 0, 36);
    out.writeUInt16LE(headerSize, 40); out.writeUInt16LE(entrySize, 46); out.writeUInt16LE(3, 48); out.writeUInt16LE(2, 50);
  }
  code.copy(out, headerSize);
  names.copy(out, namesAt);
  const section = (index, name, type, flags, at, offset, size) => {
    const base = table + index * entrySize;
    out.writeUInt32LE(name, base);
    out.writeUInt32LE(type, base + 4);
    if (is64) {
      out.writeBigUInt64LE(BigInt(flags), base + 8); out.writeBigUInt64LE(BigInt(at), base + 16);
      out.writeBigUInt64LE(BigInt(offset), base + 24); out.writeBigUInt64LE(BigInt(size), base + 32);
      out.writeBigUInt64LE(4n, base + 48);
    } else {
      out.writeUInt32LE(flags, base + 8); out.writeUInt32LE(at, base + 12);
      out.writeUInt32LE(offset, base + 16); out.writeUInt32LE(size, base + 20); out.writeUInt32LE(4, base + 32);
    }
  };
  section(1, 1, 1, 6, address, headerSize, code.length);
  section(2, 7, 3, 0, 0, namesAt, names.length);
  return out;
}

// One objdump line: its address, bytes in file order and instruction text.
// GNU objdump lists bytes; llvm-objdump lists fixed-width instruction words,
// which are little-endian here.
function instructionLine(line) {
  const match = /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )+|[0-9a-f]{8}\s)\s*(?:\t(.*))?$/.exec(line);
  if (!match) return null;
  const raw = match[2].trim();
  const bytes = /^[0-9a-f]{8}$/.test(raw) ? raw.match(/../g).reverse() : raw.split(/\s+/);
  // llvm-objdump's own notes (`<.text+0x8>`, `// =1`, `@ imm = #-8`) repeat the operands.
  const text = (match[3] || '').replace(/\s+<\.text(?:\+0x[0-9a-f]+)?>/g, '').replace(/\s+(?:@|\/\/) .*$/, '').trim();
  return { address: parseInt(match[1], 16), size: bytes.length, bytes, text };
}

// Instructions of [START, END) in virtual addresses, from file bytes that
// load at ADJUST plus their offset: GNU objdump reads the raw bytes; for an
// architecture it lacks, llvm-objdump reads them wrapped in an object.
function objdumpDecoder(file, arch, work, data) {
  let tool = null;
  const listing = path.join(work, 'objdump.txt');
  const gnu = (candidate, adjust, start, end) => runObjdump(candidate, ['-D', '-z', '-b', 'binary', '-m', arch.objdump,
    '--insn-width=16', `--adjust-vma=${hex(adjust)}`, `--start-address=${hex(start)}`, `--stop-address=${hex(end)}`, file], listing);
  const llvm = async (candidate, adjust, start, end) => {
    const object = path.join(work, 'objdump-code.o');
    await fs.writeFile(object, codeObject(data.subarray(start - adjust, end - adjust), start, arch.machine));
    const result = await runObjdump(candidate, ['-d', '-z', `--triple=${arch.triple}`, object], listing);
    await fs.rm(object, { force: true });
    return result;
  };
  const tools = [...arch.tools.map((name) => ({ name, run: gnu })),
    ...(arch.triple ? llvmObjdumps().map((name) => ({ name, run: llvm })) : [])];
  return async (adjust, start, end) => {
    let result = null;
    for (const candidate of tool ? [tool] : tools) {
      result = await candidate.run(candidate.name, adjust, start, end);
      if (result.code === 0) { tool = candidate; break; }
    }
    if (result.code !== 0) {
      throw new Error(`no objdump here disassembles ${arch.name} code (tried ${tools.map((item) => path.basename(item.name)).join(', ')}): ` +
        ((result.message || '').trim().split('\n')[0] || `exit ${result.code}`));
    }
    const lines = [];
    for (const line of (await fs.readFile(listing, 'utf8')).split('\n')) {
      const parsed = instructionLine(line);
      if (parsed) lines.push(parsed);
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

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column])).join('  ')}`.trimEnd());
}

function elfHeaderLines(elf, arch) {
  return ['ELF header',
    `  ${elf.is64 ? 'ELF64' : 'ELF32'}, ${elf.little ? 'little' : 'big'} endian, OS/ABI ${elf.abi}, version ${elf.version}`,
    `  type ${ELF_TYPES[elf.type] || elf.type}, machine ${arch ? arch.name : elf.machine}, entry ${hex(elf.entry)}, flags ${hex(elf.flags)}`,
    `  ${elf.programCount} program headers at ${hex(elf.programOffset)}, ${elf.programEntrySize} bytes each`,
    elf.sectionCount ? `  ${elf.sectionCount} section headers at ${hex(elf.sectionOffset)}, ${elf.sectionEntrySize} bytes each` :
      '  no section headers',
    '', 'Program headers',
    ...table([['#', 'type', 'offset', 'vaddr', 'filesz', 'memsz', 'flags', 'align'],
      ...elf.segments.map((segment) => [String(segment.index), SEGMENT_TYPES[segment.type] || hex(segment.type),
        hex(segment.offset), hex(segment.address), hex(segment.fileSize), hex(segment.memorySize),
        flagText(segment.flags), hex(segment.align)])])];
}

function sectionFlags(flags) {
  return `${flags & 0x40000000 ? 'R' : ' '}${flags & 0x80000000 ? 'W' : ' '}${flags & 0x20000000 ? 'E' : ' '}`.trimEnd();
}

function peHeaderLines(pe, arch) {
  const lines = ['PE header',
    `  ${pe.plus ? 'PE32+' : 'PE32'}, machine ${arch ? arch.name : hex(pe.machine)}, ${PE_SUBSYSTEMS[pe.subsystem] || `subsystem ${pe.subsystem}`}, ` +
      `entry ${hex(pe.imageBase + pe.entry)}, image base ${hex(pe.imageBase)}`,
    `  ${pe.sectionCount} sections, section alignment ${hex(pe.sectionAlignment)}, file alignment ${hex(pe.fileAlignment)}, ` +
      `headers ${hex(pe.headersSize)} bytes`,
    '', 'Sections',
    ...table([['#', 'name', 'offset', 'rawsize', 'vaddr', 'vsize', 'flags'],
      ...pe.sections.map((section) => [String(section.index), section.name || '-', hex(section.offset), hex(section.rawSize),
        hex(pe.imageBase + section.address), hex(section.virtualSize), sectionFlags(section.flags)])]),
    '', 'Imports'];
  if (!pe.imports.length) lines.push('  none');
  for (const entry of pe.imports) lines.push(`  ${entry.library || '?'}: ${entry.functions.join(', ') || 'nothing'}`);
  return lines;
}

// What a listing needs from a file format: its header lines, its machine,
// and where each file offset loads: the block that holds it (code or not),
// the address it loads at, and the zero-filled memory after the block.
function elfFormat(data, elf) {
  const blocks = new Map(elf.segments.map((segment) => [segment, {
    executable: Boolean(segment.flags & 1), adjust: segment.address - segment.offset,
    fileEnd: segment.offset + segment.fileSize,
    zero: segment.memorySize > segment.fileSize ? [segment.address + segment.fileSize, segment.address + segment.memorySize] : null }]));
  return { arch: architecture(elf.machine), machine: elf.machine, header: (arch) => elfHeaderLines(elf, arch),
    place(offset) {
      const at = loadedAddress(elf, offset);
      return at ? { block: blocks.get(at.segment), address: at.address } : null;
    } };
}

function peFormat(data, pe) {
  const blocks = new Map(pe.sections.map((section) => [section, {
    executable: Boolean((section.flags & 0x20000000) || (section.flags & 0x20)),
    adjust: pe.imageBase + section.address - section.offset,
    fileEnd: section.offset + (section.virtualSize ? Math.min(section.virtualSize, section.rawSize) : section.rawSize),
    zero: section.virtualSize > section.rawSize ?
      [pe.imageBase + section.address + section.rawSize, pe.imageBase + section.address + section.virtualSize] : null }]));
  // Calls through the import address table name the function they reach.
  const slots = new Map();
  for (const entry of pe.imports) {
    entry.functions.forEach((name, index) => slots.set(pe.imageBase + entry.slots[index], `${entry.library}!${name}`));
  }
  return { arch: ARCHES[PE_MACHINES[pe.machine]] || null, machine: hex(pe.machine), header: (arch) => peHeaderLines(pe, arch),
    annotate: (line) => line.replace(/# 0x([0-9a-f]+)$/, (whole, address) => {
      const name = slots.get(parseInt(address, 16));
      return name ? `${whole} <${name}>` : whole;
    }),
    place(offset) {
      const at = peLoadedAddress(pe, offset);
      return at ? { block: blocks.get(at.section), address: at.address } : null;
    } };
}

// FILE's listing, an ELF or PE: TEXT is the whole file, PROGRAM only the code
// of the program's own functions. Code that cannot be disassembled is shown
// as bytes with objdump's reason.
async function binaryListing(file, map, own, work) {
  const data = await fs.readFile(file);
  const elf = parseElf(data);
  const pe = elf ? null : parsePe(data);
  const layout = binaryRegions(data, { map, own });
  const format = elf ? elfFormat(data, elf) : pe ? peFormat(data, pe) : null;
  if (!format || !layout) throw new Error(`${path.basename(file)} is not a readable ELF or PE file`);
  const arch = format.arch || (elf ? architecture(elf.machine, map) : null);
  const decode = arch && objdumpDecoder(file, arch, work, data);
  const regions = layout.regions.map((region) => ({ ...region, at: format.place(region.start) }));
  const executable = (region) => EXECUTABLE_KINDS.includes(region.kind) && region.at &&
    region.at.block.executable && region.end <= region.at.block.fileEnd;

  // One objdump pass per run of adjacent code regions.
  const decoded = new Map();
  for (let index = 0; index < regions.length;) {
    if (!executable(regions[index])) { index++; continue; }
    const first = index;
    const block = regions[index].at.block;
    while (index + 1 < regions.length && executable(regions[index + 1]) &&
      regions[index + 1].at.block === block && regions[index + 1].start === regions[index].end) index++;
    const span = regions.slice(first, index + 1);
    const { adjust } = block;
    const start = span[0].start + adjust;
    const end = span[span.length - 1].end + adjust;
    let lines = null;
    let problem = arch ? '' : `objdump has no disassembler named for machine ${format.machine}`;
    if (decode) {
      try { lines = await decodeSpan(decode, adjust, start, end, span.map((item) => item.start + adjust), arch.variable); }
      catch (error) { problem = error.message; }
    }
    for (const region of span) {
      const from = region.start + adjust;
      const to = region.end + adjust;
      decoded.set(region, lines ? codeLines(lines.filter((line) => line.address >= from && line.address < to))
        .map(format.annotate || ((line) => line)) :
        [`  ${problem}`, ...byteLines(data, region.start, region.end, from)]);
    }
    index++;
  }

  const text = [...format.header(arch), ''];
  const program = [];
  let open = false;
  for (const region of regions) {
    const code = decoded.get(region);
    if (code || region.kind === 'data') {
      const lines = code || byteLines(data, region.start, region.end, region.at ? region.at.address : region.start);
      text.push('', `<${region.label}>:`, ...lines);
      if (region.kind === 'code' && code) program.push(...(program.length ? [''] : []), `<${region.label}>:`, ...code);
      open = true;
    } else {
      if (open) { text.push(''); open = false; }
      text.push(`file ${hex(region.start)}–${hex(region.end)}  ${region.label} · ${region.end - region.start} bytes`);
    }
    const block = region.at?.block;
    if (block?.zero && region.end === block.fileEnd) {
      text.push(`  ${bare(block.zero[0])}–${bare(block.zero[1])}  zero-filled in memory · ${block.zero[1] - block.zero[0]} bytes`);
    }
  }
  return { text: `${text.join('\n')}\n`, program: `${program.join('\n')}\n`, regions: layout.regions,
    filterLabel: layout.filterLabel };
}

module.exports = { architecture, binaryListing, branchTarget, codeObject, decodeSpan, elfListing: binaryListing,
  instructionLine, llvmObjdumps };
