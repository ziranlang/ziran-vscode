import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { DEFAULT_TARGETS, TARGETS, assemblyArguments, buildArgs, buildTarget, commandStd, enabledTargets, importingPrograms,
  noMainMessage, ziranCommand } = require('../targets.cjs');
const compiler = path.resolve('../ziran/build/bin/ziran');
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
    await fs.writeFile(module, '#program_export\nFrame :: () -> s32 { return 1 }\n');
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
    await fs.writeFile(file, 'first\n');
    await fs.writeFile(command, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --target=*) target=\${1#--target=};; -o) shift; output=$1;; esac; source=$1; shift; done
if [ "$target" = plan9-c ]; then echo "hello.zi:1:1: unsupported" >&2; exit 1; fi
mkdir -p "$output/target" "$output/.internal"; : > "$output/.build.lock"
cp "$source" "$output/hello.$target"; echo runtime > "$output/runtime.h"; echo skip > "$output/target/ignored"
`, { mode: 0o755 });
    const work = path.join(directory, 'work');
    const built = await buildTarget(command, 'py', file, work, []);
    assert.deepEqual(built.views[0].files.map(item => item.name), ['hello.py', 'runtime.h']);
    assert.equal(built.views[0].files[0].text, 'first\n');
    const failed = await buildTarget(command, 'plan9-c', file, work, []);
    assert.equal(failed.ok, false); assert.match(failed.message, /unsupported/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('real package builds expose each target, portable execution, IR and module guidance',
  { skip: !existsSync(compiler) }, async () => {
  const { execute, irArgs, runSteps } = require('../run.cjs');
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
    assert.match(view(results.c, 'source').files[0].text, /Package roots/);
    assert.match(view(results.c, 'assembly').files[0].text, /\.text|\.section/);
    assert.deepEqual(await magic(view(results.c, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);
    assert.match(view(results.go, 'source').files.map(file => file.text).join(''), /package main/);
    assert.match(view(results.go, 'assembly').files[0].text, /STEXT[\s\S]*TEXT\s+main\./);
    assert.deepEqual(await magic(view(results.go, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);
    assert.match(view(results.wasm, 'text').files[0].text, /\(module/);
    assert.deepEqual(await magic(view(results.wasm, 'binary').files[0]), [0, 0x61, 0x73, 0x6d]);
    if (existsSync(path.resolve('../ziran/build/bin/zi2asm'))) {
      const native = await buildTarget(compiler, 'native', source, work, []);
      assert.equal(native.ok, true, native.message);
      assert.deepEqual(native.views.map(item => item.id),
        ['source', 'checked', 'lowered', 'optimized', 'zx', 'disassembly', 'binary']);
      assert.match(view(native, 'source').files[0].text, /print\(Message\)/);
      assert.ok(view(native, 'checked').files.some(file => file.name === 'hello.zir'));
      const binary = view(native, 'binary').files[0];
      assert.deepEqual(await magic(binary), [0x7f, 0x45, 0x4c, 0x46]);
      const { binaryContentStart } = require('../run.cjs');
      assert.match(binaryContentStart(await fs.readFile(binary.binary.path)).label, /^hello:main at /);
      assert.equal(view(native, 'zx').files[0].name, 'portable.zx');
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
    for (const [index, step] of runSteps(compiler, source, [], path.join(directory, 'hello.zx'), true).entries()) {
      const result = await execute(step.command, step.args, directory, 10000);
      assert.equal(result.code, 0, result.stderr); if (index === 1) assert.equal(result.stdout, 'Package roots!\n');
    }
    await fs.writeFile(source, 'Add :: (a:s32,b:s32)->s32{return a+b}\nmain :: ()->s32{return Add(40,2)}\n');
    if (existsSync(path.resolve('../ziran/build/bin/zi2asm'))) {
      const native = await buildTarget(compiler, 'native', source, work, []);
      assert.match(view(native, 'lowered').files[0].text, /^lir \d+ entry/);
      assert.match(view(native, 'disassembly').files[0].text, /# command: objdump -d final\.elf[\s\S]*<hello:main>:/);
      assert.deepEqual(await magic(view(native, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);
    }
    await fs.writeFile(source, '#program_export\nFrame :: () -> s32 { return 7 }\n');
    await fs.writeFile(path.join(directory, 'apps/screen/desktop_hello.zi'), '#import "hello"\nmain :: () -> s32 { return Frame() }\n');
    const expected = "hello.zi has no main; it's a module. Run a program that imports it, such as desktop_hello.zi.";
    for (const target of ['wasm', 'native']) assert.equal((await buildTarget(compiler, target, source, work, [])).message, expected);
    for (const target of ['c', 'go']) {
      const result = await buildTarget(compiler, target, source, work, []);
      assert.match(view(result, 'source').files[0].text, /Frame/);
      assert.equal(result.views.find(item => item.id === 'binary').message, expected);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
