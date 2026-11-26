// Match zx2native's host registry, then deploy only the PE's imported DLLs.
// A Windows host and its dependencies stay together in the provider directory.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parsePe } = require('./binary-layout.cjs');

function hostDirectories(environment) {
  if (environment.ZIRAN_HOST_PATH) return environment.ZIRAN_HOST_PATH.split(path.delimiter).filter(path.isAbsolute);
  const home = environment.XDG_DATA_HOME || path.join(environment.HOME || os.homedir(), '.local/share');
  const shared = (environment.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(path.delimiter);
  return [home, ...shared].filter(path.isAbsolute).map(directory => path.join(directory, 'ziran/hosts'));
}

async function libraryDirectories(environment) {
  const directories = [];
  for (const registry of hostDirectories(environment)) {
    let names;
    try { names = (await fs.readdir(registry)).filter(name => name.endsWith('.library')).sort(); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    for (const name of names) {
      let library;
      try { library = (await fs.readFile(path.join(registry, name), 'utf8')).trim(); }
      catch { continue; }
      if (path.isAbsolute(library) && !/[\x00-\x1f\x7f]/.test(library)) directories.push(path.dirname(library));
    }
  }
  return [...new Set(directories)];
}

async function deployPeLibraries(file, environment = process.env) {
  const image = parsePe(await fs.readFile(file));
  if (!image) return [];
  const output = path.dirname(file);
  // Fresh providers precede copies left by an earlier build.
  const directories = [...await libraryDirectories(environment), output];
  const candidates = new Map();
  for (const directory of [...new Set(directories)]) {
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    for (const name of names.filter(name => /\.dll$/i.test(name)).sort()) {
      const key = name.toLowerCase();
      const list = candidates.get(key) || [];
      list.push(path.join(directory, name));
      candidates.set(key, list);
    }
  }
  const pending = image.imports.map(item => item.library);
  const visited = new Set();
  const deployed = [];
  while (pending.length) {
    const name = pending.shift();
    const key = name.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    for (const source of candidates.get(key) || []) {
      const library = parsePe(await fs.readFile(source));
      if (!library || library.machine !== image.machine) continue;
      const destination = path.join(output, path.basename(source));
      if (source !== destination) {
        await fs.copyFile(source, destination);
        deployed.push(destination);
      }
      pending.push(...library.imports.map(item => item.library));
      break;
    }
    // Windows system DLLs are supplied by the operating system, not the registry.
  }
  return deployed;
}

module.exports = { deployPeLibraries };
