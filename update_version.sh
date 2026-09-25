#!/bin/sh
set -eu

version=$(sed -n 's/^## \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' CHANGELOG.md | head -n 1)
test -n "$version"
node - "$version" <<'NODE'
const fs = require('node:fs');
const version = process.argv[2];
for (const file of ['package.json', 'package-lock.json']) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = version;
  if (file === 'package-lock.json') data.packages[''].version = version;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
NODE
