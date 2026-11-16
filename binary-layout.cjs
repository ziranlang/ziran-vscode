// The parts of a binary as file byte ranges, for the hex and assembly views.
// Each region has a kind: header, padding, other, runtime, library, code or
// data. A view showing only the program keeps the code and data regions.
const PROGRAM_KINDS = ['code', 'data'];
const EXECUTABLE_KINDS = ['code', 'runtime', 'library'];

// ELF header, program headers and section headers, with every table checked
// against the file before it is read; a malformed file returns null.
function parseElf(data) {
  try {
    if (!Buffer.isBuffer(data) || data.length < 52 || data[0] !== 0x7f || data[1] !== 0x45 ||
        data[2] !== 0x4c || data[3] !== 0x46 || data[6] !== 1) return null;
    const is64 = data[4] === 2;
    const little = data[5] === 1;
    if ((data[4] !== 1 && !is64) || (data[5] !== 1 && data[5] !== 2)) return null;
    const fits = (offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
      offset >= 0 && length >= 0 && offset + length <= data.length;
    const u16 = (offset) => fits(offset, 2) ? (little ? data.readUInt16LE(offset) : data.readUInt16BE(offset)) : null;
    const u32 = (offset) => fits(offset, 4) ? (little ? data.readUInt32LE(offset) : data.readUInt32BE(offset)) : null;
    const word = (offset) => {
      if (!is64) return u32(offset);
      if (!fits(offset, 8)) return null;
      const value = little ? data.readBigUInt64LE(offset) : data.readBigUInt64BE(offset);
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    };
    const table = (offset, entrySize, count, minimum) => count === 0 ||
      (entrySize >= minimum && fits(offset, entrySize * count));
    const elf = {
      is64, little, abi: data[7], type: u16(16), machine: u16(18), version: u32(20),
      entry: word(24), programOffset: word(is64 ? 32 : 28), sectionOffset: word(is64 ? 40 : 32),
      flags: u32(is64 ? 48 : 36), headerSize: u16(is64 ? 52 : 40),
      programEntrySize: u16(is64 ? 54 : 42), programCount: u16(is64 ? 56 : 44),
      sectionEntrySize: u16(is64 ? 58 : 46), sectionCount: u16(is64 ? 60 : 48),
      stringIndex: u16(is64 ? 62 : 50), segments: [], sections: [],
    };
    if (Object.values(elf).some((value) => value === null) || elf.version !== 1 ||
        elf.headerSize < (is64 ? 64 : 52) || !fits(0, elf.headerSize) ||
        !table(elf.programOffset, elf.programEntrySize, elf.programCount, is64 ? 56 : 32) ||
        !table(elf.sectionOffset, elf.sectionEntrySize, elf.sectionCount, is64 ? 64 : 40)) return null;
    for (let index = 0; index < elf.programCount; index++) {
      const at = elf.programOffset + index * elf.programEntrySize;
      const segment = { index, type: u32(at), flags: u32(at + (is64 ? 4 : 24)),
        offset: word(at + (is64 ? 8 : 4)), address: word(at + (is64 ? 16 : 8)),
        fileSize: word(at + (is64 ? 32 : 16)), memorySize: word(at + (is64 ? 40 : 20)),
        align: word(at + (is64 ? 48 : 28)) };
      if (Object.values(segment).some((value) => value === null)) return null;
      elf.segments.push(segment);
    }
    for (let index = 0; index < elf.sectionCount; index++) {
      const at = elf.sectionOffset + index * elf.sectionEntrySize;
      const section = { index, nameOffset: u32(at), type: u32(at + 4), flags: word(at + 8),
        address: word(at + (is64 ? 16 : 12)), offset: word(at + (is64 ? 24 : 16)),
        size: word(at + (is64 ? 32 : 20)), name: '' };
      if (Object.values(section).some((value) => value === null)) return null;
      elf.sections.push(section);
    }
    const strings = elf.sections[elf.stringIndex];
    if (elf.stringIndex > 0 && strings && strings.type === 3 && fits(strings.offset, strings.size)) {
      for (const section of elf.sections) {
        const start = strings.offset + section.nameOffset;
        const end = data.indexOf(0, start);
        if (section.nameOffset < strings.size && end >= 0 && end < strings.offset + strings.size) {
          section.name = data.toString('latin1', start, end);
        }
      }
    }
    return elf;
  } catch { return null; }
}

// The segment that loads file OFFSET, and the virtual address it loads at.
function loadedAddress(elf, offset) {
  for (const segment of elf.segments) {
    if (segment.type === 1 && offset >= segment.offset && offset < segment.offset + segment.fileSize) {
      return { segment, address: segment.address + offset - segment.offset };
    }
  }
  return null;
}

function functionLabel(module, name) {
  if (!module) return name || 'function';
  return name && name.startsWith(`${module}.`) ? name : `${module}:${name}`;
}

function ownModule(module, own) {
  return Boolean(module) && (own.has(module) || own.has(String(module).split('/').pop()));
}

// The native map's text, split where its ranges change function: the
// program's own functions are code, other named functions library code, and
// unnamed ranges the Ziran runtime and veneers. Offsets are text-relative.
function textParts(map, own, entryOffset = -1) {
  const size = map.image.text_size;
  const valid = (item) => Number.isSafeInteger(item.begin) && Number.isSafeInteger(item.end) &&
    item.begin >= 0 && item.end <= size && item.begin < item.end;
  let ranges = (Array.isArray(map.ranges) ? map.ranges : []).filter(valid);
  if (!ranges.length && Array.isArray(map.functions)) {
    ranges = map.functions.filter((item) => item.emitted !== false && valid(item))
      .map((item) => ({ begin: item.begin, end: item.end, function_id: item.id, module: item.module, function: item.name }));
  }
  ranges.sort((left, right) => left.begin - right.begin);
  const names = new Map((Array.isArray(map.functions) ? map.functions : []).map((item) => [item.id, item]));
  const parts = [];
  let cursor = 0;
  const push = (begin, end, id, module, name) => {
    const last = parts[parts.length - 1];
    if (last && last.end === begin && last.id === id) { last.end = end; return; }
    parts.push({ begin, end, id, module, name });
  };
  for (const range of ranges) {
    const begin = Math.max(range.begin, cursor);
    if (begin >= range.end) continue;
    if (begin > cursor) push(cursor, begin, -1);
    const named = names.get(range.function_id) || {};
    const id = Number.isInteger(range.function_id) ? range.function_id : -1;
    push(begin, range.end, id, range.module || named.module, range.function || named.name);
    cursor = range.end;
  }
  if (cursor < size) push(cursor, size, -1);
  const hasOwn = parts.some((part) => part.id >= 0 && ownModule(part.module, own));
  return parts.map((part) => {
    if (part.id < 0) {
      const entry = entryOffset >= part.begin && entryOffset < part.end;
      return { begin: part.begin, end: part.end, kind: 'runtime', label: entry ? 'runtime entry' : 'runtime' };
    }
    const kind = !hasOwn || ownModule(part.module, own) ? 'code' : 'library';
    return { begin: part.begin, end: part.end, kind, label: functionLabel(part.module, part.name) };
  });
}

function sectionKind(section) {
  if (section.flags & 4) return 'code';
  if ((section.flags & 2) && /^\.(rodata|data|tdata)/.test(section.name)) return 'data';
  return 'header';
}

function flagText(flags) {
  return `${flags & 4 ? 'R' : ' '}${flags & 2 ? 'W' : ' '}${flags & 1 ? 'E' : ' '}`.trimEnd();
}

function subtract(start, end, taken) {
  const pieces = [];
  let cursor = start;
  for (const item of [...taken].sort((left, right) => left.start - right.start)) {
    if (item.end <= cursor || item.start >= end) continue;
    if (item.start > cursor) pieces.push({ start: cursor, end: item.start });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < end) pieces.push({ start: cursor, end });
  return pieces;
}

function elfRegions(data, elf, map, own) {
  const regions = [];
  const add = (start, end, kind, label) => {
    start = Math.max(0, start); end = Math.min(data.length, end);
    if (end > start) regions.push({ start, end, kind, label });
  };
  add(0, elf.headerSize, 'header', 'ELF header');
  add(elf.programOffset, elf.programOffset + elf.programCount * elf.programEntrySize, 'header',
    `program headers (${elf.programCount})`);
  add(elf.sectionOffset, elf.sectionOffset + elf.sectionCount * elf.sectionEntrySize, 'header',
    `section headers (${elf.sectionCount})`);
  const image = map?.image;
  const mapped = image && [image.text_file_offset, image.text_size].every(Number.isSafeInteger) &&
    image.text_file_offset >= 0 && image.text_file_offset + image.text_size <= data.length;
  if (mapped) {
    const entry = Number.isSafeInteger(image.text_virtual_address) ? elf.entry - image.text_virtual_address : -1;
    for (const part of textParts(map, own, entry)) {
      add(image.text_file_offset + part.begin, image.text_file_offset + part.end, part.kind, part.label);
    }
    if ([image.data_file_offset, image.data_size].every(Number.isSafeInteger) && image.data_size > 0) {
      add(image.data_file_offset, image.data_file_offset + image.data_size, 'data', 'data');
    }
  } else if (elf.sections.some((section) => section.type !== 0)) {
    for (const section of elf.sections) {
      if (section.type === 0 || section.type === 8 || section.size === 0) continue;
      add(section.offset, section.offset + section.size, sectionKind(section),
        section.name || `section ${section.index}`);
    }
  } else {
    const headers = [...regions];
    for (const segment of elf.segments) {
      if (segment.type !== 1) continue;
      for (const piece of subtract(segment.offset, segment.offset + segment.fileSize, headers)) {
        add(piece.start, piece.end, segment.flags & 1 ? 'code' : 'data',
          `segment ${segment.index} (${flagText(segment.flags)})`);
      }
    }
  }
  return regions;
}

const WASM_SECTIONS = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global',
  'export', 'start', 'element', 'code', 'data', 'data count', 'tag'];

function wasmRegions(data) {
  const regions = [{ start: 0, end: 8, kind: 'header', label: 'Wasm header' }];
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
    const id = data[offset];
    const length = varuint(offset + 1);
    if (!length || length.value > data.length - length.next) return null;
    const end = length.next + length.value;
    const name = WASM_SECTIONS[id] || `section ${id}`;
    regions.push({ start: offset, end, kind: id === 10 ? 'code' : id === 11 ? 'data' : 'header',
      label: `${name} section` });
    offset = end;
  }
  return regions;
}

// A ZX bundle: its 64-byte header, the section table and the sections, of
// which the program section (kind 2) holds the verified instructions.
function zxRegions(data) {
  if (data.length < 64 || data.readUInt32LE(8) !== 64 || data.readUInt32LE(12) !== 32 ||
      data.readBigUInt64LE(40) !== BigInt(data.length)) return null;
  const count = data.readUInt32LE(32);
  if (count < 1 || count > 1024 || count > Math.floor((data.length - 64) / 32)) return null;
  const regions = [{ start: 0, end: 64, kind: 'header', label: 'ZX header' },
    { start: 64, end: 64 + count * 32, kind: 'header', label: `section table (${count})` }];
  for (let index = 0; index < count; index++) {
    const record = 64 + index * 32;
    const kind = data.readUInt32LE(record);
    const offset = data.readBigUInt64LE(record + 8);
    const length = data.readBigUInt64LE(record + 16);
    if (offset + length > BigInt(data.length)) return null;
    const start = Number(offset);
    regions.push({ start, end: start + Number(length), kind: kind === 2 ? 'code' : 'header',
      label: kind === 2 ? 'program section' : `section ${kind > 0xffff ? `0x${kind.toString(16)}` : kind}` });
  }
  return regions;
}

// Sorted, non-overlapping regions covering the whole file: an earlier region
// keeps bytes a later one also claims, and gaps become padding (all zero)
// or other bytes.
function coverFile(data, regions) {
  const sorted = regions.filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const covered = [];
  let cursor = 0;
  const gap = (start, end) => {
    if (end <= start) return;
    const zero = data.subarray(start, end).every((byte) => byte === 0);
    covered.push({ start, end, kind: zero ? 'padding' : 'other', label: zero ? 'padding' : 'other bytes' });
  };
  for (const region of sorted) {
    const start = Math.max(region.start, cursor);
    if (start >= region.end) continue;
    gap(cursor, start);
    covered.push({ ...region, start });
    cursor = region.end;
  }
  gap(cursor, data.length);
  return covered;
}

// The regions of DATA, an ELF, Wasm module or ZX bundle, and the label of
// the toggle that hides everything but the program. MAP is a Ziran native
// map for the ELF and OWN the program's module names. Unknown files are null.
function binaryRegions(data, { map = null, own = new Set() } = {}) {
  try {
    if (!Buffer.isBuffer(data) || data.length < 8) return null;
    let regions = null;
    let filterLabel = 'Hide headers';
    if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) {
      const elf = parseElf(data);
      if (elf) regions = elfRegions(data, elf, map, own);
      filterLabel = 'Hide ELF parts';
    } else if (data.subarray(0, 8).equals(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))) {
      regions = wasmRegions(data);
    } else if (data[0] === 0x5a && data[1] === 0x58 && data[2] === 0 && data[3] === 0) {
      regions = zxRegions(data);
    }
    if (!regions) return null;
    return { regions: coverFile(data, regions), filterLabel };
  } catch { return null; }
}

module.exports = { EXECUTABLE_KINDS, PROGRAM_KINDS, binaryRegions, flagText, loadedAddress, parseElf, textParts };
