const fs = require('node:fs/promises');
const path = require('node:path');

// Keep generated runtime files inside the opaque iframe: its requests cannot
// use VSCode's resource service worker. Embed bytes so saves cannot reuse cache.
async function previewAssets(artifact) {
  let html = await fs.readFile(artifact, 'utf8');
  const root = path.dirname(artifact);
  const scripts = [...html.matchAll(new RegExp(String.raw`<script\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\s*</script>`, 'gi'))];
  for (const match of scripts) {
    const source = match[1] || match[2] || match[3];
    const file = path.resolve(root, source);
    const relative = path.relative(root,file);
    if (/^[a-z]+:/i.test(source) || path.isAbsolute(source) || relative.split(path.sep).includes('..')) {
      throw new Error('Preview script must be inside the build directory');
    }
    let script = await fs.readFile(file,'utf8');
    const assets = {};
    for (const kind of ['wasm','data']) {
      const sidecar = file.replace(/[.]js$/i,'.' + kind);
      if (sidecar === file) continue;
      let bytes;
      try { bytes = await fs.readFile(sidecar); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (bytes) {
        const type = kind === 'wasm' ? 'application/wasm' : 'application/octet-stream';
        assets[path.basename(sidecar)] = 'data:' + type + ';base64,' + bytes.toString('base64');
      }
    }
    if (Object.keys(assets).length) {
      script = `var Module=globalThis.Module||{};Module.locateFile=(function(files){return function(name){return files[name]||name;};})(${JSON.stringify(assets)});` + script;
    }
    const escaped = script.replace(new RegExp('</script','gi'), '<'+String.fromCharCode(92)+'/script');
    html = html.replace(match[0], () => '<script>' + escaped + '</script>');
  }
  return html;
}
module.exports = {previewAssets};
