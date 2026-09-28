import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { TARGETS, buildArgs, buildTarget, commandStd, ziranCommand } =
  require('../targets.cjs');

const disposable = { dispose() {} };

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
  assert.deepEqual(TARGETS.map((target) => target.id), ['c', 'cpp', 'go', 'rust', 'plan9-c']);
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
cp "$source" "$output/hello.$target"
echo runtime > "$output/runtime.h"
echo skip > "$output/target/ignored"
`, { mode: 0o755 });
    const work = path.join(directory, 'work');
    const built = await buildTarget(command, 'c', file, work, []);
    assert.equal(built.ok, true);
    assert.deepEqual(built.files.map((item) => item.name), ['hello.c', 'runtime.h']);
    assert.equal(built.files[0].text, 'first\n');
    const failed = await buildTarget(command, 'plan9-c', file, work, []);
    assert.equal(failed.ok, false);
    assert.match(failed.message, /unsupported/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
