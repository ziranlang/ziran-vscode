import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { TARGETS, assemblyArguments, buildArgs, buildTarget, commandStd, importingPrograms,
  noMainMessage, ziranCommand } = require('../targets.cjs');

const disposable = { dispose() {} };

test('nested package files use manifest roots for targets, IR and portable execution', async () => {
  const { irArgs, runSteps, execute } = require('../run.cjs');
  const { runCommand } = require('../preview.cjs');
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-package-'));
  const command = path.join(os.homedir(), '.local/bin/ziran');
  try {
    const file = path.join(directory, 'apps', 'screen', 'hello.zi');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.mkdir(path.join(directory, 'src'));
    await fs.writeFile(path.join(directory, 'ziran.toml'),
      '[package]\nname="preview_test"\nentry="apps/screen/hello.zi"\nmodule_roots=["src"]\n' +
      '[toolchain]\ngit="https://github.com/ziranlang/ziran.git"\nref="master"\n');
    await fs.writeFile(path.join(directory, 'ziran.local.toml'),
      `[overrides]\nziran=${JSON.stringify(path.resolve('../ziran'))}\n`);
    await fs.writeFile(path.join(directory, 'src', 'message.zi'), 'Message :: "Package roots!\\n"\n');
    await fs.writeFile(file, '#import "message"\nmain :: () { print(Message); }\n');
    const lock = await runCommand(command, ['lock'], directory);
    assert.equal(lock.code, 0, lock.stderr);
    for (const target of ['c', 'go', 'wasm', 'zx']) {
      const built = await buildTarget(command, target, file, path.join(directory, 'generated'), []);
      assert.equal(built.ok, true, `${target}: ${built.message}`);
      assert.ok(built.views[0].files.length > 0, `${target}: ${built.views[0].message}`);
    }
    const ir = await runCommand(command, irArgs(file, [], path.join(directory, 'ir'), true), directory);
    assert.equal(ir.code, 0, ir.stderr);
    const steps = runSteps(command, file, [], path.join(directory, 'hello.zx'), true);
    for (const [index, step] of steps.entries()) {
      const result = await execute(step.command, step.args, directory, 10000);
      assert.equal(result.code, 0, result.stderr);
      if (index === 1) assert.equal(result.stdout, 'Package roots!\n');
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('target preview did not update');
}

test('a single file builds with its own directory as root', () => {
  assert.deepEqual(buildArgs('go', '/notes/hello.zi', '/tmp/out/go', ['/ziran/std']),
    ['build', '--target=go', '--root', '/notes', '--module-path', '/ziran/std',
      '-o', '/tmp/out/go', '/notes/hello.zi']);
  assert.equal(commandStd('/work/ziran/build/bin/ziran'), '/work/ziran/std');
  assert.equal(commandStd('/home/me/.local/bin/ziran'), null);
  assert.deepEqual(TARGETS.map((target) => target.id), ['c', 'go', 'wasm', 'zx', 'native']);
});

test('main is the only program entry for Wasm and executables', () => {
  assert.deepEqual(buildArgs('wasm', '/notes/hello.zi', '/out/hello.wasm', []),
    ['build', '--target=wasm', '--root', '/notes', '--entry', 'hello:main',
      '-o', '/out/hello.wasm', '/notes/hello.zi']);
  assert.deepEqual(buildArgs('c', '/notes/hello.zi', '/out/c', [], false, { exe: true }),
    ['build', '--target=c', '--root', '/notes', '--exe', '--entry', 'hello:main',
      '-o', '/out/c', '/notes/hello.zi']);
  assert.deepEqual(buildArgs('go', '/notes/hello.zi', '/out/go', [], true, { exe: true }),
    ['build', '--target=go', '--project', '--root', '/notes', '--pkg', 'main', '--exe',
      '--entry', 'hello:main', '-o', '/out/go', '/notes/hello.zi']);
  assert.deepEqual(assemblyArguments(['cc', '-std=c99', '-O3', '-I/x', '-c', 'a.c', '-o', 'a.o'], 'a.s'),
    ['cc', '-std=c99', '-O3', '-I/x', 'a.c', '-S', '-o', 'a.s']);
});

test('a module without main names the programs that import it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-no-main-'));
  try {
    const module = path.join(directory, 'hello.zi');
    await fs.writeFile(module, '#program_export\nFrame :: () -> s32 { return 1 }\n');
    await fs.writeFile(path.join(directory, 'desktop_hello.zi'), '#import "hello"\nmain :: () { Frame() }\n');
    await fs.writeFile(path.join(directory, 'other.zi'), '#import "hello"\nDraw :: () { Frame() }\n');
    await fs.writeFile(path.join(directory, 'alias.zi'), 'App :: #import "examples/hello";\nmain :: () { App.Frame() }\n');
    assert.deepEqual(await importingPrograms(module), ['alias.zi', 'desktop_hello.zi']);
    assert.equal(noMainMessage(module, ['desktop_hello.zi']),
      "hello.zi has no main; it's a module. Run a program that imports it, such as desktop_hello.zi.");
    assert.equal(noMainMessage(module), "hello.zi has no main; it's a module. Run a program that imports it.");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a file outside any Kryon project finds the Ziran checkout above it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-targets-find-'));
  try {
    const command = path.join(directory, 'build', 'bin', 'ziran');
    const file = path.join(directory, 'site', 'examples', 'hello.zi');
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(command, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(file, '');
    const vscode = {
      Uri: { file(fsPath) { return { fsPath }; } },
      workspace: { workspaceFolders: [], getConfiguration() { return { get(_, fallback) { return fallback; } }; } },
    };
    assert.equal(await ziranCommand(file, vscode), command);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a target build lists its files with module source first', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-targets-'));
  try {
    const file = path.join(directory, 'hello.zi');
    const command = path.join(directory, 'fake-ziran');
    await fs.writeFile(file, 'first\n');
    await fs.writeFile(command, `#!/bin/sh
target=
output=
while [ $# -gt 0 ]; do
  case "$1" in
    --target=*) target=\${1#--target=} ;;
    -o) shift; output=$1 ;;
  esac
  source=$1
  shift
done
if [ "$target" = plan9-c ]; then echo "hello.zi:1:1: unsupported" >&2; exit 1; fi
mkdir -p "$output/target"
: > "$output/.build.lock"
mkdir -p "$output/.internal"
echo skip > "$output/.internal/log"
cp "$source" "$output/hello.$target"
echo runtime > "$output/runtime.h"
echo skip > "$output/target/ignored"
`, { mode: 0o755 });
    const work = path.join(directory, 'work');
    const built = await buildTarget(command, 'py', file, work, []);
    assert.equal(built.ok, true);
    assert.deepEqual(built.views[0].files.map((item) => item.name), ['hello.py', 'runtime.h']);
    assert.equal(built.views[0].files[0].text, 'first\n');
    const failed = await buildTarget(command, 'plan9-c', file, work, []);
    assert.equal(failed.ok, false);
    assert.match(failed.message, /unsupported/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


const compiler = path.resolve('../ziran/build/bin/ziran');
const std = path.resolve('../ziran/std');
const haveCompiler = existsSync(compiler);

async function bytesOf(file, count = 4) {
  return [...(await fs.readFile(file.binary.path)).subarray(0, count)];
}

function viewOf(result, id) {
  const found = result.views.find((item) => item.id === id);
  assert.ok(found, `${result.id} has no ${id} view`);
  assert.equal(found.ok, true, `${result.id} ${id}: ${found.message}`);
  return found;
}

test('Wasm builds a binary and exposes validated WAT and its bytes, never binary UTF-8', { skip: !haveCompiler }, async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-wasm-'));
  try {
    const source = path.join(directory, 'hello.zi');
    await fs.writeFile(source, 'main :: () { print("Hello, Wasm!\\n"); }\n');
    const result = await buildTarget(compiler, 'wasm', source, path.join(directory, 'generated'), []);
    assert.equal(result.ok, true, result.message);
    const [text] = viewOf(result, 'text').files;
    assert.equal(text.name, 'hello.wat');
    assert.match(text.text, /\(module/);
    assert.match(text.text, /Hello, Wasm!/);
    const [binary] = viewOf(result, 'binary').files;
    assert.equal(binary.name, 'hello.wasm');
    assert.equal(binary.text, undefined);
    assert.deepEqual(await bytesOf(binary), [0x00, 0x61, 0x73, 0x6d]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('C, Go and ZX show generated source, assembly and the binary they build', { skip: !haveCompiler }, async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-inspect-'));
  try {
    const source = path.join(directory, 'hello.zi');
    await fs.writeFile(source, 'Add :: (a: s32, b: s32) -> s32 { return a + b }\n' +
      'main :: () { print("Hello, %!\\n", Add(40, 2)); }\n');
    const work = path.join(directory, 'generated');
    const c = await buildTarget(compiler, 'c', source, work, [std]);
    assert.equal(c.ok, true, c.message);
    assert.deepEqual(c.views.map((item) => item.id), ['source', 'assembly', 'binary']);
    assert.match(viewOf(c, 'source').files[0].text, /Hello, /);
    const assembly = viewOf(c, 'assembly');
    assert.equal(assembly.files[0].name, 'hello.s');
    assert.match(assembly.files[0].text, /\.text|\.section/);
    assert.match(assembly.files[0].text, /Hello_Add|hello_Add|Add/);
    assert.match(assembly.caption, /-O3 -S/);
    assert.deepEqual(await bytesOf(viewOf(c, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);

    const go = await buildTarget(compiler, 'go', source, work, [std]);
    assert.equal(go.ok, true, go.message);
    assert.match(viewOf(go, 'source').files.map((file) => file.text).join(''), /package main/);
    assert.match(viewOf(go, 'assembly').files[0].text, /STEXT[\s\S]*TEXT\s+main\./);
    assert.deepEqual(await bytesOf(viewOf(go, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);

    const zx = await buildTarget(compiler, 'zx', source, work, [std]);
    assert.equal(zx.ok, true, zx.message);
    assert.match(viewOf(zx, 'listing').files[0].text, /bundle entry hello:main[\s\S]*function Add/);
    const bundle = viewOf(zx, 'binary').files[0];
    assert.equal(bundle.name, 'hello.zx');
    assert.ok(bundle.binary.size > 0);
    // print is not in the direct backend's subset; the reason is shown.
    const instructions = zx.views.find((item) => item.id === 'instructions');
    assert.equal(instructions.ok, false);
    assert.match(instructions.message, /zi2asm/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('the native direct backend shows its listings, disassembly and ELF', {
  skip: !haveCompiler || !existsSync(path.resolve('../ziran/build/bin/zi2asm')) }, async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-native-'));
  try {
    const source = path.join(directory, 'answer.zi');
    await fs.writeFile(source, 'Add :: (a: s32, b: s32) -> s32 { return a + b }\n' +
      'main :: () -> s32 { return Add(40, 2) }\n');
    const work = path.join(directory, 'generated');
    const native = await buildTarget(compiler, 'native', source, work, []);
    assert.equal(native.ok, true, native.message);
    assert.match(viewOf(native, 'lowered').files[0].text, /^lir 3 entry/);
    assert.match(viewOf(native, 'disassembly').files[0].text, /--adjust-vma=-0x[0-9a-f]+[\s\S]*<.*>:/);
    assert.deepEqual(await bytesOf(viewOf(native, 'binary').files[0]), [0x7f, 0x45, 0x4c, 0x46]);
    const zx = await buildTarget(compiler, 'zx', source, work, []);
    assert.match(viewOf(zx, 'instructions').files[0].text, /^lir 3 entry/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a module without main shows its code but has no program to build', { skip: !haveCompiler }, async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-module-'));
  try {
    const source = path.join(directory, 'hello.zi');
    await fs.writeFile(source, '#program_export\nFrame :: () -> s32 { return 7 }\n');
    await fs.writeFile(path.join(directory, 'desktop_hello.zi'), '#import "hello"\nmain :: () -> s32 { return Frame() }\n');
    const work = path.join(directory, 'generated');
    const expected = "hello.zi has no main; it's a module. Run a program that imports it, such as desktop_hello.zi.";
    for (const target of ['wasm', 'zx', 'native']) {
      const result = await buildTarget(compiler, target, source, work, []);
      assert.equal(result.ok, false);
      assert.equal(result.message, expected, target);
    }
    for (const target of ['c', 'go']) {
      const result = await buildTarget(compiler, target, source, work, []);
      assert.equal(result.ok, true, result.message);
      assert.match(viewOf(result, 'source').files[0].text, /Frame/);
      assert.match(viewOf(result, 'assembly').files[0].text, /Frame/);
      const binary = result.views.find((item) => item.id === 'binary');
      assert.equal(binary.ok, false);
      assert.equal(binary.message, expected);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
