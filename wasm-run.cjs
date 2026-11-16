// Runs a zx2wasm module in Node: `node wasm-run.cjs program.wasm`. The module
// imports zx.budget, zx.overrun and zx.host_i64, whose output capabilities
// write strings, integers, floats and booleans to stdout. Its entry's result
// is the exit status.
const fs = require('node:fs');

function floatText(value, single) {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  let scientific;
  for (let precision = 1; precision <= 17; precision++) {
    scientific = value.toExponential(precision - 1);
    if (single ? Math.fround(Number(scientific)) === value : Number(scientific) === value) break;
  }
  if (Object.is(value, -0)) scientific = `-${scientific}`;
  const [coefficient, power] = scientific.split('e');
  const negative = coefficient.startsWith('-');
  const digits = coefficient.replace(/[-.]/g, '').replace(/0+$/, '') || '0';
  const point = Number(power) + 1;
  const text = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` :
    point >= digits.length ? digits + '0'.repeat(point - digits.length) :
      `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? '-' : ''}${text}`.slice(0, 63);
}

function imports(write) {
  let memory = null;
  const bits = new DataView(new ArrayBuffer(8));
  const text = (value) => { write(Buffer.from(value)); return 0n; };
  return {
    attach(instance) { memory = instance.exports.memory; },
    imports: { zx: {
      // Fuel is unbounded, as for a bundle run; the editor stops a long run.
      budget: new WebAssembly.Global({ value: 'i64', mutable: true }, 0x7fffffffffffffffn),
      overrun() { throw new Error('Execution budget exceeded'); },
      host_i64(capability, value) {
        switch (capability >>> 0) {
          case 0xffffffff: {
            const handle = BigInt.asUintN(64, value);
            const address = Number(handle & 0xffffffffn);
            const length = Number(handle >> 32n);
            if (!memory || address + length > memory.buffer.byteLength) throw new Error('Invalid output string');
            write(Buffer.from(memory.buffer, address, length));
            return 0n;
          }
          case 0xfffffffe: return text(BigInt.asIntN(64, value).toString());
          case 0xfffffffd: return text(BigInt.asUintN(64, value).toString());
          case 0xfffffffc: bits.setBigInt64(0, value, true); return text(floatText(bits.getFloat64(0, true), false));
          case 0xfffffffb: bits.setUint32(0, Number(value & 0xffffffffn), true); return text(floatText(bits.getFloat32(0, true), true));
          case 0xfffffffa: return text(value ? 'true' : 'false');
          default: throw new Error(`Unknown host capability ${capability >>> 0}`);
        }
      } } },
  };
}

async function run(file) {
  const host = imports((bytes) => fs.writeSync(1, bytes));
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(file), host.imports);
  host.attach(instance);
  if (typeof instance.exports.zx_entry !== 'function') throw new Error(`${file} exports no zx_entry`);
  const result = instance.exports.zx_entry();
  if (typeof instance.exports.zx_flush === 'function') instance.exports.zx_flush();
  return Number(BigInt.asUintN(8, BigInt(result ?? 0)));
}

if (require.main === module) {
  run(process.argv[2]).then((status) => { process.exitCode = status; })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { floatText, imports, run };
