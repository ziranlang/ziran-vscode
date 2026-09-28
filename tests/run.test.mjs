import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { mainLine, runCommandLine } = require('../run.cjs');

test('run finds the file\'s main procedure', () => {
  assert.equal(mainLine('// hello\nmain :: () {\n}\n'), 1);
  assert.equal(mainLine('Answer :: () -> s32 { return 42 }\n'), -1);
  assert.equal(mainLine('  main :: () {}\n'), -1);
});

test('run bundles the file\'s main and runs it on the portable runtime', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ziran run's-"));
  try {
    const file = path.join(directory, 'hello.zi');
    const command = path.join(directory, 'fake-ziran');
    await fs.writeFile(file, 'main :: () {}\n');
    await fs.writeFile(command, '#!/bin/sh\nprintf "%s|" "$@"; echo\n', { mode: 0o755 });
    const output = execFileSync('/bin/sh', ['-c', runCommandLine(command, file, ['/std'])],
      { encoding: 'utf8' }).trim().split('\n');
    assert.match(output[0], new RegExp(`^bundle\\|--root\\|${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|--module-path\\|/std\\|--entry\\|hello:main\\|-o\\|.*\\.zib\\|.*hello\\.zi\\|$`));
    assert.match(output[1], /^run\|.*ziran-run-[0-9a-f]{16}\.zib\|$/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
