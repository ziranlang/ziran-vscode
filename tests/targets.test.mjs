import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { DEFAULT_TARGETS, TARGETS, assemblyArguments, buildArgs, buildTarget, commandStd, enabledTargets, importingPrograms,
  noMainMessage, observeCommands, ownModules, splitOwn, stagesOf, startPipeline, ziranCommand } = require('../targets.cjs');
const compiler = path.resolve('../ziran/build/bin/ziran');
const nativeTools = ['zi2zx', 'zx2native'].every(tool => existsSync(path.resolve('../ziran/build/bin', tool)));
const view = (result, id) => {
  const found = result.views.find(item => item.id === id);
  assert.equal(found?.ok, true, `${result.id} ${id}: ${found?.message}`); return found;
};
const magic = async file => [...(await fs.readFile(file.binary.path)).subarray(0, 4)];
test('target arguments, command discovery and no-main guidance cover every target', async () => {
  assert.deepEqual(TARGETS.map(target => target.id), ['c', 'go', 'wasm', 'native']);
  assert.deepEqual(DEFAULT_TARGETS, ['c', 'go', 'wasm', 'native']);
  for (const [configured, expected] of [
    [undefined, DEFAULT_TARGETS], [['zx'], ['native']], [['native', 'zx', 'c'], ['c', 'native']], [[], []],
  ]) {
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: {
      getConfiguration: () => ({ get: (_, fallback) => configured ?? fallback }) } };
    assert.deepEqual(enabledTargets('/notes/hello.zi', vscode), expected);
  }
  for (const [actual, expected] of [
    [buildArgs('go', '/notes/hello.zi', '/tmp/out/go', ['/ziran/std']),
      ['build', '--target=go', '--root', '/notes', '--module-path', '/ziran/std', '-o', '/tmp/out/go', '/notes/hello.zi']],
    [buildArgs('wasm', '/notes/hello.zi', '/out/hello.wasm', []),
      ['build', '--target=wasm', '--root', '/notes', '--entry', 'hello:main', '-o', '/out/hello.wasm', '/notes/hello.zi']],
    [buildArgs('c', '/notes/hello.zi', '/out/c', [], false, { exe: true }),
      ['build', '--target=c', '--root', '/notes', '--exe', '--entry', 'hello:main', '-o', '/out/c', '/notes/hello.zi']],
    [buildArgs('go', '/notes/hello.zi', '/out/go', [], true, { exe: true }),
      ['build', '--target=go', '--project', '--root', '/notes', '--pkg', 'main', '--exe', '--entry', 'hello:main', '-o', '/out/go', '/notes/hello.zi']],
  ]) assert.deepEqual(actual, expected);
  assert.deepEqual(assemblyArguments(['cc', '-std=c99', '-O3', '-I/x', '-c', 'a.c', '-o', 'a.o'], 'a.s'),
    ['cc', '-std=c99', '-O3', '-I/x', 'a.c', '-S', '-o', 'a.s']);
  assert.equal(commandStd('/work/ziran/build/bin/ziran'), '/work/ziran/std');
  assert.equal(commandStd('/home/me/.local/bin/ziran'), null);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-targets-find-'));
  try {
    const command = path.join(directory, 'build/bin/ziran');
    const module = path.join(directory, 'site/hello.zi');
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.mkdir(path.dirname(module), { recursive: true });
    await fs.writeFile(command, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(module, 'Frame :: () -> s32 { return 1 }\n');
    await fs.writeFile(path.join(directory, 'site/desktop_hello.zi'), '#import "hello"\nmain :: () { Frame() }\n');
    await fs.writeFile(path.join(directory, 'site/other.zi'), '#import "hello"\nDraw :: () { Frame() }\n');
    await fs.writeFile(path.join(directory, 'site/alias.zi'), 'App :: #import "examples/hello";\nmain :: () { App.Frame() }\n');
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: {
      workspaceFolders: [], getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
    assert.equal(await ziranCommand(module, vscode), command);
    assert.deepEqual(await importingPrograms(module), ['alias.zi', 'desktop_hello.zi']);
    assert.equal(noMainMessage(module, ['desktop_hello.zi']),
      "hello.zi has no main; it's a module. Run a program that imports it, such as desktop_hello.zi.");
    assert.equal(noMainMessage(module), "hello.zi has no main; it's a module. Run a program that imports it.");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('target builds expose source files and failures without build internals', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-targets-'));
  try {
    const file = path.join(directory, 'hello.zi'); const command = path.join(directory, 'fake-ziran');
    await fs.writeFile(file, '#import "helper"\nfirst\n');
    await fs.writeFile(path.join(directory, 'helper.zi'), 'Done :: () { }\n');
    await fs.writeFile(command, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --target=*) target=\${1#--target=};; -o) shift; output=$1;; esac; source=$1; shift; done
if [ "$target" = plan9-c ]; then echo "hello.zi:1:1: unsupported" >&2; exit 1; fi
mkdir -p "$output/target" "$output/.internal"; : > "$output/.build.lock"
cp "$source" "$output/hello.$target"; echo runtime > "$output/runtime.h"; echo skip > "$output/target/ignored"
`, { mode: 0o755 });
    const work = path.join(directory, 'work');
    const built = await buildTarget(command, 'py', file, work, []);
    // A source generator shows Source and ZIR, then its own output.
    assert.deepEqual(built.views.map(item => [item.id, item.label]), [['source', 'Source'], ['zir', 'ZIR'],
      ['generated', 'py']]);
    // A failed check still lists the program and the imports it reaches.
    assert.deepEqual(view(built, 'source').files.map(item => item.name), ['hello.zi', 'helper.zi']);
    assert.match(view(built, 'source').files[0].text, /first/);
    assert.match(built.views.find(item => item.id === 'zir').message, /^checked IR/);
    assert.deepEqual(view(built, 'generated').files.map(item => item.name), ['hello.py', 'runtime.h']);
    assert.match(view(built, 'generated').files[0].text, /first/);
    assert.ok(built.views.every(item => !('caption' in item)));
    const failed = await buildTarget(command, 'plan9-c', file, work, []);
    assert.equal(failed.ok, false); assert.match(failed.message, /unsupported/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('real package builds expose each target, portable execution, IR and module guidance',
  { skip: !existsSync(compiler) }, async () => {
  const { bundleStep, execute } = require('../run.cjs');
  const { platformArtifact, runRoute } = require('../platforms.cjs');
  const { irArgs } = require('../targets.cjs');
  const { runCommand } = require('../preview.cjs');
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-package-'));
  try {
    const source = path.join(directory, 'apps/screen/hello.zi');
    await fs.mkdir(path.dirname(source), { recursive: true }); await fs.mkdir(path.join(directory, 'src'));
    await fs.writeFile(path.join(directory, 'ziran.toml'), '[package]\nname="preview_test"\nentry="apps/screen/hello.zi"\nmodule_roots=["src"]\n' +
      '[toolchain]\ngit="https://github.com/ziranlang/ziran.git"\nref="master"\n');
    await fs.writeFile(path.join(directory, 'ziran.local.toml'),
      `[overrides]\nziran=${JSON.stringify(path.resolve('../ziran'))}\n`);
    await fs.writeFile(path.join(directory, 'src/message.zi'), 'Message :: "Package roots!\\n"\n');
    await fs.writeFile(source, '#import "message"\nmain :: () { print(Message); }\n');
    const lock = await runCommand(compiler, ['lock'], directory); assert.equal(lock.code, 0, lock.stderr);
    const work = path.join(directory, 'generated'); const results = {};
    for (const target of ['c', 'go', 'wasm']) {
      results[target] = await buildTarget(compiler, target, source, work, []);
      assert.equal(results[target].ok, true, `${target}: ${results[target].message}`);
    }
    const pipeline = ['source', 'zir', 'lowered', 'optimized', 'zx'];
    for (const target of ['c', 'go', 'wasm']) {
      assert.deepEqual(results[target].views.map(item => item.id), stagesOf(target).map(([id]) => id), target);
    }
    assert.match(view(results.c, 'zir').files[0].text, /\nmodule hello from hello\.zi/);
    assert.match(view(results.c, 'source').files[0].text, /print\(Message\)/);
    if (nativeTools) assert.match(view(results.wasm, 'lowered').files[0].text, /^lir \d+ entry/);
    assert.match(view(results.c, 'generated').files[0].text, /Package roots/);
    assert.match(view(results.c, 'assembly').files[0].text, /\.text|\.section/);
    assert.deepEqual(await magic(view(results.c, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);
    assert.match(view(results.go, 'generated').files.map(file => file.text).join(''), /package main/);
    assert.match(view(results.go, 'assembly').files[0].text, /STEXT[\s\S]*TEXT\s+main\./);
    assert.deepEqual(await magic(view(results.go, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);
    assert.match(view(results.wasm, 'text').files[0].text, /\(module/);
    assert.deepEqual(await magic(view(results.wasm, 'binary').files[0]), [0, 0x61, 0x73, 0x6d]);
    if (nativeTools) {
      const native = await buildTarget(compiler, 'native', source, work, []);
      assert.equal(native.ok, true, native.message);
      assert.deepEqual(native.views.map(item => item.id), [...pipeline, 'assembly', 'binary']);
      assert.deepEqual(native.views.map(item => item.id), stagesOf('native').map(([id]) => id));
      assert.match(view(native, 'source').files[0].text, /print\(Message\)/);
      const binary = view(native, 'binary').files[0];
      assert.deepEqual(await magic(binary), [0x7f, 0x45, 0x4c, 0x46]);
      const code = binary.binary.regions.filter(region => region.kind === 'code');
      assert.deepEqual(code.map(region => region.label), ['hello:main']);
      assert.equal(view(native, 'zx').files[0].name, 'final.zx');
      const headers = await runCommand('readelf', ['-lW', binary.binary.path], directory);
      assert.equal(headers.code, 0, headers.stderr);
      assert.doesNotMatch(headers.stdout, /INTERP|DYNAMIC/);
      const symbols = await runCommand('nm', ['-S', binary.binary.path], directory);
      assert.equal(symbols.code, 0, symbols.stderr);
      assert.doesNotMatch(symbols.stdout, /\bU\s/);
      await fs.chmod(binary.binary.path, 0o755);
      const ran = await execute(binary.binary.path, [], directory, 10000);
      assert.equal(ran.code, 0, ran.stderr);
      assert.equal(ran.stdout, 'Package roots!\n');
    }
    const ir = await runCommand(compiler, irArgs(source, [], path.join(directory, 'ir'), true), directory);
    assert.equal(ir.code, 0, ir.stderr);
    // The package's bundle runs on Linux x86-64 the way the Run pane runs it.
    const step = bundleStep(compiler, source, [], path.join(directory, 'hello.zx'), true);
    const bundled = await execute(step.command, step.args, directory, 10000);
    assert.equal(bundled.code, 0, bundled.stderr);
    if (nativeTools && process.arch === 'x64') {
      const linux = { id: 'x86_64-linux', label: 'Linux x86-64', arch: 'x86_64', os: 'linux', format: 'elf', emit: 'elf', gap: '' };
      const built = await platformArtifact(linux, path.join(directory, 'hello.zx'), directory, 'hello',
        { zx2native: path.resolve('../ziran/build/bin/zx2native') });
      assert.equal(built.problem, undefined, built.problem);
      const route = await runRoute(linux, built.file);
      const result = await execute(route.command, route.args, directory, 10000, route.env);
      assert.deepEqual([result.code, result.stdout], [0, 'Package roots!\n'], result.stderr);
    }
    await fs.writeFile(source, 'Add :: (a:s32,b:s32)->s32{return a+b}\nmain :: ()->s32{return Add(40,2)}\n');
    if (nativeTools) {
      const native = await buildTarget(compiler, 'native', source, work, []);
      assert.match(view(native, 'lowered').files[0].text, /^lir \d+ entry/);
      const listing = view(native, 'assembly').files[0];
      assert.match(listing.text, /^ELF header\n[\s\S]*\nProgram headers\n[\s\S]*<hello:main>:[\s\S]*<hello:Add>:/);
      assert.match(listing.filtered, /^<hello:main>:[\s\S]*\n\n<hello:Add>:/);
      assert.deepEqual(await magic(view(native, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);
    }
    await fs.writeFile(source, 'Frame :: () -> s32 { return 7 }\n');
    await fs.writeFile(path.join(directory, 'apps/screen/desktop_hello.zi'), '#import "hello"\nmain :: () -> s32 { return Frame() }\n');
    const expected = "hello.zi has no main; it's a module. Run a program that imports it, such as desktop_hello.zi.";
    for (const target of ['wasm', 'native']) assert.equal((await buildTarget(compiler, target, source, work, [])).message, expected);
    for (const target of ['c', 'go']) {
      const result = await buildTarget(compiler, target, source, work, []);
      assert.match(view(result, 'source').files[0].text, /Frame/);
      assert.match(view(result, 'generated').files[0].text, /Frame/);
      assert.equal(result.views.find(item => item.id === 'binary').message, expected);
      assert.equal(result.views.some(item => ['lowered', 'optimized', 'zx'].includes(item.id)), false, target);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('generated views show the program\'s own modules and load dependencies on request', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-own-'));
  try {
    const file = path.join(directory, 'window.zi'); const command = path.join(directory, 'fake-ziran');
    await fs.writeFile(file, 'main :: () -> s32 { return 0 }\n');
    await fs.writeFile(path.join(directory, 'helper.zi'), 'Helper :: 1\n');
    assert.deepEqual([...await ownModules(file)].sort(), ['helper', 'window']);
    // Like a Kryon build: the program's module among every package module.
    await fs.writeFile(command, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) shift; output=$1;; esac; shift; done
mkdir -p "$output"; for name in app app_types accessibility_linux helper window; do
  echo "/* $name */" > "$output/$name.py"; done; echo runtime > "$output/zir_runtime.h"
`, { mode: 0o755 });
    const built = await buildTarget(command, 'py', file, path.join(directory, 'work'), []);
    const files = view(built, 'generated').files;
    assert.deepEqual(files.filter(item => !item.dependency).map(item => item.name), ['window.py', 'helper.py']);
    assert.equal(files[0].text, '/* window */\n');
    const dependencies = files.filter(item => item.dependency);
    assert.deepEqual(dependencies.map(item => item.name).sort(),
      ['accessibility_linux.py', 'app.py', 'app_types.py', 'zir_runtime.h']);
    for (const item of dependencies) {
      assert.equal(item.text, undefined, `${item.name} is not read until it is shown`);
      assert.equal(typeof item.load, 'function');
      assert.ok(item.size > 0);
    }
    assert.equal(await dependencies.find(item => item.name === 'app.py').load(), '/* app */\n');
    // A build with no file of its own shows everything as its own.
    assert.deepEqual(splitOwn([{ name: 'other.c' }], file, new Set(['window'])).dependencies, []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('Native names the missing renamed tool', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-tools-'));
  try {
    const bin = path.join(directory, 'build/bin'); await fs.mkdir(bin, { recursive: true });
    const command = path.join(bin, 'ziran');
    await fs.writeFile(command, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'zi2zx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const file = path.join(directory, 'hello.zi');
    await fs.writeFile(file, 'main :: () { }\n');
    const result = await buildTarget(command, 'native', file, path.join(directory, 'work'), []);
    assert.equal(result.ok, false);
    if (!existsSync(path.join(os.homedir(), '.local/bin/zx2native'))) {
      assert.equal(result.message, 'zx2native was not found beside the ziran command or in a Ziran checkout; build it there with `make`.');
    }
    assert.doesNotMatch(result.message, /zi2asm/);
    assert.equal(result.message.includes('\n'), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
const kryonWindow = path.resolve('../../kryonlabs/kryon/examples/window.zi');
test('a Kryon program gets every target with an entry file and lazy shared code',
  { skip: !existsSync(kryonWindow) || !existsSync(path.join(os.homedir(), '.local/bin/ziran')) }, async () => {
  const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: {
    workspaceFolders: [], getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
  const command = await ziranCommand(kryonWindow, vscode);
  const work = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-kryon-'));
  try {
    const results = {};
    for (const target of ['c', 'go', 'wasm', ...(nativeTools ? ['native'] : [])]) {
      results[target] = await buildTarget(command, target, kryonWindow, work, [],
        { folders: [path.resolve('..')] });
      assert.equal(results[target].ok, true, `${target}: ${results[target].message}`);
    }
    for (const [target, first] of [['c', 'window.c'], ['go', 'window.go']]) {
      const files = view(results[target], 'generated').files;
      const own = files.filter(item => !item.dependency).map(item => item.name);
      assert.equal(own[0], first, target);
      assert.ok(own.every(name => name.startsWith('window.')), `${target}: ${own}`);
      assert.match(files[0].text, /main/);
      assert.ok(files.some(item => item.dependency && (target === 'c'
        ? item.name.startsWith('kryon/') : item.name.startsWith('kryon/app'))),
      `${target} lists its shared implementation`);
      assert.ok(files.filter(item => item.dependency).every(item => item.text === undefined));
      const ownBytes = files.filter(item => !item.dependency).reduce((sum, item) => sum + item.text.length, 0);
      const dependencyBytes = files.filter(item => item.dependency).reduce((sum, item) => sum + (item.size || 0), 0);
      console.log(`${target}: ${own.length} own files (${ownBytes} bytes), ${files.length - own.length} dependency files (${dependencyBytes} bytes)`);
    }
    const assembly = view(results.c, 'assembly').files;
    assert.deepEqual(assembly.filter(item => !item.dependency).map(item => item.name), ['window.s']);
    assert.ok(assembly.filter(item => item.dependency).every(item => typeof item.load === 'function'));
    assert.match(view(results.wasm, 'text').files[0].text, /\(module/);
    for (const target of ['c', 'go', 'wasm', ...(nativeTools ? ['native'] : [])]) {
      assert.deepEqual(results[target].views.map(item => item.label), stagesOf(target).map(([, label]) => label), target);
    }
  } finally { await fs.rm(work, { recursive: true, force: true }); }
});

const hello = path.resolve('../ziran/examples/hello.zi');
test('hello\'s Assembly lists the whole ELF and Binary marks its regions, each with a program-only filter',
  { skip: !nativeTools || !existsSync(hello) }, async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-hello-'));
  try {
    const native = await buildTarget(compiler, 'native', hello, work, []);
    assert.equal(native.ok, true, native.message);
    assert.deepEqual(native.views.map(item => item.label), ['Source', 'ZIR', 'LIR', 'Optimized', 'ZX', 'Assembly', 'Binary']);
    const listing = view(native, 'assembly').files[0];
    const { text, filtered } = listing;
    assert.equal(listing.filterLabel, 'Hide ELF parts');
    for (const line of [/^ELF header$/m, /^  ELF64, little endian/m, /machine x86-64, entry 0x[0-9a-f]+/,
      /^Program headers$/m, /^  0 +LOAD +0x0 /m, /^file 0x0–0x40  ELF header · 64 bytes$/m,
      /^<runtime entry>:$/m, /^<hello:main>:$/m, /^<data>:$/m, /\tsyscall$/m, /\tret$/m])
      assert.match(text, line);
    assert.doesNotMatch(text, /^#|no generated C or Go|map identity|command: objdump/m);
    // Every call reaches an instruction start: decoding resynchronized after padding.
    const starts = new Set([...text.matchAll(/^  ([0-9a-f]+):\t/gm)].map(match => match[1]));
    for (const [, target] of text.matchAll(/\tcall +0x([0-9a-f]+)$/gm)) assert.ok(starts.has(target), `call 0x${target}`);
    // Hiding the ELF parts leaves only the program's own code.
    assert.match(filtered, /^<hello:main>:\n  [0-9a-f]+:\t[0-9a-f ]+\t\S+/m);
    assert.doesNotMatch(filtered, /ELF header|Program headers|padding|<runtime|<data>|^file /m);
    const binary = view(native, 'binary').files[0].binary;
    assert.equal(binary.filterLabel, 'Hide ELF parts');
    const kinds = binary.regions.map(region => `${region.label}:${region.kind}`);
    for (const part of ['ELF header:header', 'program headers (2):header', 'padding:padding', 'runtime entry:runtime',
      'hello:main:code', 'runtime:runtime', 'data:data']) assert.ok(kinds.includes(part), part);
    assert.equal(binary.regions[0].start, 0);
    assert.equal(binary.regions.at(-1).end, binary.size);
    for (let index = 1; index < binary.regions.length; index++)
      assert.equal(binary.regions[index].start, binary.regions[index - 1].end, 'regions cover the file in order');
  } finally { await fs.rm(work, { recursive: true, force: true }); }
});

test('one stage table gives every target its tabs: a prefix of the shared chain, then its own output', () => {
  const labels = target => stagesOf(target).map(([, label]) => label);
  assert.deepEqual(labels('c'), ['Source', 'ZIR', 'C', 'Assembly', 'Binary']);
  assert.deepEqual(labels('go'), ['Source', 'ZIR', 'Go', 'Assembly', 'Binary']);
  assert.deepEqual(labels('wasm'), ['Source', 'ZIR', 'LIR', 'Optimized', 'ZX', 'WAT', 'Binary']);
  assert.deepEqual(labels('native'), ['Source', 'ZIR', 'LIR', 'Optimized', 'ZX', 'Assembly', 'Binary']);
  const chain = ['source', 'zir', 'lowered', 'optimized', 'zx'];
  for (const { id } of TARGETS) {
    const shared = stagesOf(id).map(([stage]) => stage).filter(stage => chain.includes(stage));
    assert.deepEqual(shared, chain.slice(0, shared.length), `${id} skips or reorders no stage`);
  }
});

// Each target's tabs, checked against the commands its build ran.
const kryonHello = path.resolve('../../kryonlabs/kryon/examples/hello.zi');
for (const program of [kryonHello, kryonWindow]) {
  test(`${path.basename(program)}: every target shows its table's stages, built from the commands it ran`,
    { skip: !existsSync(program) || !existsSync(path.join(os.homedir(), '.local/bin/ziran')) }, async () => {
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: {
      workspaceFolders: [], getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
    const command = await ziranCommand(program, vscode);
    const work = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-stages-'));
    const options = { folders: [path.resolve('..')] };
    try {
      // C and Go compile the checked ZIR: a run that enables only them runs no ZX step.
      const commands = [];
      observeCommands((tool) => commands.push(tool));
      const small = startPipeline(command, program, path.join(work, 'small'), [], { ...options, targets: ['c', 'go'] });
      for (const target of ['c', 'go']) {
        const result = await buildTarget(command, target, program, path.join(work, target), [], { ...options, pipeline: small });
        assert.equal(result.ok, true, `${target}: ${result.message}`);
        assert.deepEqual(result.views.map(item => [item.id, item.label]), stagesOf(target), target);
      }
      observeCommands(null);
      assert.ok(commands.includes('ziran') && commands.includes('zi-inspect'), 'ZIR is checked and listed');
      assert.equal(commands.includes('zi2zx') || commands.includes('zx2native'), false, 'C and Go run no ZX step');
      // Each frontend checks its own branches; portable targets share their pipeline.
      const pipeline = startPipeline(command, program, path.join(work, 'shared'), [],
        { ...options, targets: TARGETS.map(item => item.id) });
      const results = {};
      for (const target of ['c', 'go', 'wasm', 'native']) {
        results[target] = await buildTarget(command, target, program, path.join(work, `all-${target}`), [], { ...options, pipeline });
        assert.equal(results[target].ok, true, `${target}: ${results[target].message}`);
        assert.deepEqual(results[target].views.map(item => [item.id, item.label]), stagesOf(target), target);
      }
      // Source and checked dependencies follow the selected code generator.
      const text = async (result, id) => Promise.all(result.views.find(item => item.id === id).files.map(async file =>
        [file.name, file.text ?? (file.load ? await file.load() : (await fs.readFile(file.binary.path)).toString('base64'))]));
      const dependencies = (target) => results[target].views.find(item => item.id === 'source').files
        .filter(item => item.dependency).map(item => item.name).join('\n');
      assert.doesNotMatch(dependencies('c'), /frames_zx|zx_window/);
      assert.doesNotMatch(dependencies('go'), /frames_zx|frames_desktop|zx_window|desktop_window/);
      assert.doesNotMatch(dependencies('native'), /frames_desktop|desktop_window/);
      if (program === kryonHello) {
        assert.match(dependencies('c'), /kryon\/host\/desktop/);
        assert.match(dependencies('native'), /frames_zx/);
      }
      for (const id of ['lowered', 'optimized', 'zx']) {
        assert.equal(JSON.stringify(await text(results.wasm, id)), JSON.stringify(await text(results.native, id)), id);
      }
      // Source and ZIR list the program's own modules first; dependencies wait to be picked.
      for (const id of ['source', 'zir']) {
        const files = results.c.views.find(item => item.id === id).files;
        assert.equal(files[0].dependency, undefined, `${id} starts with the program`);
        const dependencies = files.filter(item => item.dependency);
        assert.ok(dependencies.length > 0, `${id} lists dependencies for the file dropdown`);
        assert.ok(dependencies.every(item => item.text === undefined && typeof item.load === 'function'));
      }
      // Source and ZIR use the same import paths for the package tree.
      const sourceFiles = results.c.views.find(item => item.id === 'source').files;
      const sourceNames = new Set(sourceFiles.map(item => item.name));
      for (const name of results.c.views.find(item => item.id === 'zir').files
        .filter(item => item.dependency).map(item => item.name))
        assert.ok(sourceNames.has(`${name.replace(/\.zir$/, '')}.zi`), `${name} has a Source entry`);
      for (const id of ['source', 'zir']) {
        for (const file of view(results.c, id).files.filter(item => item.dependency)) {
          assert.ok(file.name.startsWith('kryon/') || file.name.startsWith('std/'), file.name);
        }
      }
      assert.match(await sourceFiles.find(item => item.dependency).load(), /\S/);
    } finally { observeCommands(null); await fs.rm(work, { recursive: true, force: true }); }
  });
}
