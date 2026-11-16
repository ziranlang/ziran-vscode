const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse } = require('@iarna/toml');
const { createHash, randomBytes } = require('node:crypto');

function safeEnvironment(source = process.env) {
  const { DISPLAY, WAYLAND_DISPLAY, XAUTHORITY, DBUS_SESSION_BUS_ADDRESS, SESSION_MANAGER, ...environment } = source;
  // VSCode can omit empty values from the extension host environment. Git
  // requires an explicit value for each numbered key, including an empty one.
  const count = Number(environment.GIT_CONFIG_COUNT);
  const validCount = /^[0-9]+$/.test(environment.GIT_CONFIG_COUNT || '') && Number.isSafeInteger(count);
  for (const key of Object.keys(environment)) {
    const index = key.match(/^GIT_CONFIG_KEY_([0-9]+)$/)?.[1];
    if (validCount && index !== undefined && Number(index) < count) {
      environment['GIT_CONFIG_VALUE_' + index] ??= '';
    }
  }
  return { ...environment, HARMONY_DESKTOP_RECOVERY: '0' };
}

function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: safeEnvironment(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout = (stdout + data.toString()).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2 * 1024 * 1024); });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function exists(file) {
  try { await fs.access(file); return true; }
  catch { return false; }
}

async function projectRoot(start) {
  let directory = start;
  try {
    if (!(await fs.stat(directory)).isDirectory()) directory = path.dirname(directory);
  } catch { return null; }
  while (true) {
    if (await exists(path.join(directory, 'kryon.toml'))) return directory;
    try {
      const manifest = parse(await fs.readFile(path.join(directory, 'ziran.toml'), 'utf8'));
      if (manifest.package?.tool === 'kryon' || manifest.tool?.kryon) return directory;
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function manifestRoot(start) {
  let directory = start;
  try {
    if (!(await fs.stat(directory)).isDirectory()) directory = path.dirname(directory);
  } catch { return null; }
  while (true) {
    if (await exists(path.join(directory, 'ziran.toml'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function isKryonProgram(file) {
  if (!file?.endsWith('.zi')) return false;
  let source;
  try { source = await fs.readFile(file, 'utf8'); } catch { return false; }
  return /^[ \t]*(?:[A-Za-z_]\w*[ \t]*::[ \t]*)?#import[ \t]+"kryon\/app"/m.test(source) &&
    /^main\s*::\s*\(/m.test(source);
}

async function previewLocation(start) {
  const root = await projectRoot(start);
  if (root) return { key: root, root, source: start.endsWith?.('.zi') ? start : '', standalone: false };
  if (await isKryonProgram(start)) {
    return { key: start, root: null, source: start, standalone: true };
  }
  return null;
}

function standaloneRoot(file, storage) {
  const key = createHash('sha256').update(file).digest('hex').slice(0, 16);
  return path.join(storage, 'preview', key);
}

async function writeChanged(file, contents) {
  let current = null;
  try { current = await fs.readFile(file, 'utf8'); } catch {}
  if (current !== contents) await fs.writeFile(file, contents);
}

// A lone program that owns main through kryon/app has no project of its own.
// It is previewed as an extension-owned project with a canvas profile; the
// Kryon tool builds a program entry's main for the page.
async function prepareStandalonePreview(file, storage, vscode) {
  const root = standaloneRoot(file, storage);
  const sourceDirectory = path.join(root, 'src');
  await fs.mkdir(sourceDirectory, { recursive: true });
  const owner = await manifestRoot(file);
  if (!owner) throw new Error('Kryon single-file preview needs a containing Ziran package.');
  const { ziranCommand } = require('./targets.cjs');
  const command = await ziranCommand(file, vscode);
  const ownerManifest = parse(await fs.readFile(path.join(owner, 'ziran.toml'), 'utf8'));
  let kryon = ownerManifest.package?.name === 'kryon' ? owner : '';
  if (!kryon) {
    const located = await runCommand(command, ['pkg', 'path', 'kryon'], owner);
    if (located.code === 0) kryon = located.stdout.trim().split(/\r?\n/).pop();
  }
  const toolchain = await runCommand(command, ['pkg', 'path', 'ziran'], owner);
  const ziran = toolchain.code === 0 ? toolchain.stdout.trim().split(/\r?\n/).pop() : '';
  if (!kryon || !ziran) {
    throw new Error('Kryon single-file preview could not resolve the kryon package and Ziran toolchain.');
  }
  const entry = path.basename(file);
  const name = path.basename(file, '.zi').replace(/[^A-Za-z0-9_-]/g, '-') || 'preview';
  const manifest = `[package]\nname = "${name}"\nentry = "src/${entry}"\nmodule_roots = ["src"]\ntool = "kryon"\n\n` +
    `[toolchain]\ngit = "https://github.com/ziranlang/ziran.git"\nref = "master"\n\n` +
    `[dependencies.kryon]\ngit = "https://github.com/kryonlabs/kryon.git"\nref = "master"\n\n` +
    `[tool.kryon]\ndefault_profile = "preview"\nentry = "src/${entry}"\n\n` +
    `[tool.kryon.profiles.preview]\nbackend = "canvas"\n`;
  const local = `[overrides]\nkryon = ${JSON.stringify(kryon)}\nziran = ${JSON.stringify(ziran)}\n`;
  await writeChanged(path.join(root, 'ziran.toml'), manifest);
  await writeChanged(path.join(root, 'ziran.local.toml'), local);
  await fs.copyFile(file, path.join(sourceDirectory, entry));
  const locked = await runCommand(command, ['lock'], root);
  if (locked.code !== 0) {
    throw new Error((locked.stderr || locked.stdout).trim() ||
      `ziran lock failed${locked.code === null ? '' : ` (exit ${locked.code})`}`);
  }
  return root;
}

async function manifestPath(root, name, fallback) {
  let source;
  try { source = await fs.readFile(path.join(root, 'kryon.toml'), 'utf8'); }
  catch { return path.resolve(root, fallback); }
  let section = '';
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (heading) { section = heading[1]; continue; }
    const setting = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/);
    if (section === 'paths' && setting?.[1] === name) {
      return path.resolve(root, setting[2]);
    }
  }
  return path.resolve(root, fallback);
}

async function projectBuildDirectory(root) {
  let parent = path.dirname(root);
  while (parent !== path.dirname(parent)) {
    if (path.basename(parent) === 'examples') {
      const owner = path.dirname(parent);
      try {
        const config = parse(await fs.readFile(path.join(owner, 'ziran.toml'), 'utf8'));
        if (config.package?.name === 'kryon') {
          return path.join(owner, 'build', 'examples', path.relative(parent, root));
        }
      } catch {}
    }
    parent = path.dirname(parent);
  }
  return path.join(root, 'build');
}

async function previewBuild(root, requested = '') {
  const modern = await exists(path.join(root, 'ziran.toml'));
  const config = parse(await fs.readFile(path.join(root, modern ? 'ziran.toml' : 'kryon.toml'), 'utf8'));
  const tool = modern ? config.tool?.kryon || {} : config;
  const profiles = tool.profiles || {};
  const profile = requested || ['portable_web', 'web', ...Object.keys(profiles)]
    .find((name) => profiles[name]?.backend === 'canvas');
  if (!profile || profiles[profile]?.backend !== 'canvas') {
    throw new Error('Kryon Preview needs a canvas profile (portable_web or web). Set ziran.previewProfile to a canvas profile.');
  }
  if (!/^[\w-]+$/.test(profile)) throw new Error('Invalid preview profile name');
  const name = config.package?.name || config.project?.name || path.basename(root);
  if (!/^[\w-]+$/.test(name)) throw new Error('Invalid project name');
  return { profile, artifact: path.join(await projectBuildDirectory(root), `${name}-${profile}.html`) };
}

function previewInput(root, file) {
  const relative = path.relative(root, file);
  const parts = relative.split(path.sep);
  if (!relative || path.isAbsolute(relative) || parts.includes('..') ||
      parts.some((part) => ['build', 'node_modules', '.git', '.ziran'].includes(part))) return false;
  return file.endsWith('.zi') || ['kryon.toml', 'ziran.toml', 'ziran.local.toml', 'ziran.lock'].includes(path.basename(file));
}

function previewHtml(nonce) {
  const { INSPECTOR_MARKUP, INSPECTOR_SCRIPT, INSPECTOR_STYLE } = require('./inspector.cjs');
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; connect-src data: blob:; frame-src 'self'; img-src data: blob:; font-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  h1 { font-size: 1.1rem; margin: 0; }
  header button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; }
  #status, #window-status { color: var(--vscode-descriptionForeground); }
  #build-output { box-sizing: border-box; overflow: auto; white-space: pre; font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.3; border: 1px solid var(--vscode-panel-border); padding: 10px; }
  .window { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; padding: 0; background: var(--vscode-editor-background); }
  .window-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; background: var(--vscode-titleBar-activeBackground, #252526); border-bottom: 1px solid var(--vscode-panel-border); }
  .window-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .55; }
  #window-title { margin-left: 8px; font-size: .85rem; }
  #app { display: block; width: 100%; height: 70vh; margin: 0; padding: 0; border: 0; background: transparent; color-scheme: normal; }
  #build-output:empty { display: none; }
${INSPECTOR_STYLE}
</style></head><body>
<header><h1>Kryon Preview</h1><button id="run">Run again</button><button id="open-window" hidden>Open in window</button><span id="status">Starting…</span><span id="window-status"></span></header>
<div class="window" id="window"><div class="window-bar"><span class="window-dot"></span><span class="window-dot"></span><span class="window-dot"></span><span id="window-title"></span></div><iframe id="app" title="Interactive Kryon preview" sandbox="allow-scripts allow-pointer-lock"></iframe></div>
<pre id="build-output"></pre>
${INSPECTOR_MARKUP}
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
${INSPECTOR_SCRIPT}
  let currentHtml;
  window.addEventListener('message', ({ data }) => {
    if (inspector.receive(data) || data.type !== 'state') return;
    byId('status').textContent = data.status;
    byId('build-output').textContent = [data.status.startsWith('Up to date') ? '' : data.output,
      data.windowOutput].filter(Boolean).join('\\n\\n');
    byId('window-title').textContent = data.project;
    byId('open-window').hidden = !data.program;
    byId('open-window').disabled = data.windowBuilding;
    byId('window-status').textContent = data.windowStatus;
    if (data.html !== currentHtml) {
      currentHtml = data.html;
      byId('app').srcdoc = data.html || '';
    }
    byId('code-section').hidden = !data.inspectable;
    inspector.render(data);
  });
  byId('run').addEventListener('click', () => api.postMessage({ type: 'run' }));
  byId('open-window').addEventListener('click', () => api.postMessage({ type: 'openWindow' }));
  api.postMessage({ type: 'ready' });
</script></body></html>`;
}

// End an owned window process and its children: SIGTERM, then SIGKILL.
async function stopOwnedProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const signal = (name) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {}
  };
  signal('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (child.exitCode === null && child.signalCode === null) {
    signal('SIGKILL');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
}

// The entry a project preview inspects when it was opened from a folder.
async function projectEntry(root) {
  for (const name of ['ziran.toml', 'kryon.toml']) {
    try {
      const config = parse(await fs.readFile(path.join(root, name), 'utf8'));
      const entry = config.tool?.kryon?.entry || config.package?.entry || config.project?.entry;
      if (typeof entry === 'string' && await exists(path.resolve(root, entry))) return path.resolve(root, entry);
    } catch {}
  }
  return '';
}

class Preview {
  constructor(location, context, vscode) {
    this.location = location;
    this.source = location.source;
    this.storage = context.globalStorageUri.fsPath;
    this.root = location.root || standaloneRoot(location.source, this.storage);
    this.vscode = vscode;
    this.disposed = false;
    this.running = false;
    this.rerun = false;
    this.windowChild = null;
    this.windowQueue = Promise.resolve();
    this.inspecting = false;
    this.reinspect = false;
    const title = this.source ? path.basename(this.source, '.zi') : path.basename(this.root);
    this.state = {
      type: 'state', project: title, status: 'Starting…', output: '', html: '', inspectable: false,
      // A single-file program owns main, so it can also run in its own window.
      program: Boolean(location.standalone), windowStatus: '', windowOutput: '', windowBuilding: false,
    };
    this.panel = vscode.window.createWebviewPanel('kryonPreview',
      `Preview: ${title}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    const { TargetInspector } = require('./inspector.cjs');
    this.inspector = new TargetInspector({ vscode, state: this.state, post: () => this.post(),
      send: (message) => { if (!this.disposed) this.panel.webview.postMessage(message); },
      storage: this.storage, rerun: () => this.inspectTargets() });
    this.panel.webview.html = previewHtml(randomBytes(16).toString('hex'));
    this.watchers = [];
    this.watch();
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.message(message)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === 'file' && previewInput(this.watchRoot, document.uri.fsPath)) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!this.inspector.file || !event.affectsConfiguration('ziran', vscode.Uri.file(this.inspector.file))) return;
        this.inspector.refreshTargets();
        this.inspectTargets();
      }),
    ];
    context.subscriptions.push(this);
    this.run();
  }

  // Rebuilds follow the files of the previewed project or program.
  watch() {
    for (const watcher of this.watchers) watcher.dispose();
    const { vscode } = this;
    const target = this.location.standalone ? path.dirname(this.source) : this.root;
    this.watchRoot = vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(target))?.uri.fsPath || target;
    this.watchers = [];
    for (const pattern of ['**/*.zi', '**/kryon.toml', '**/ziran{,.local}.toml', '**/ziran.lock']) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(this.watchRoot), pattern));
      const changed = (uri) => { if (previewInput(this.watchRoot, uri.fsPath)) this.schedule(); };
      this.watchers.push(watcher, watcher.onDidChange(changed),
        watcher.onDidCreate(changed), watcher.onDidDelete(changed));
    }
  }

  // The preview follows the editor's active .zi file: a file of the
  // previewed project changes what the target tabs inspect; another Kryon
  // program moves the whole preview, live window included.
  follow(location) {
    if (this.disposed || !location.source || location.source === this.source) return false;
    if (location.standalone !== this.location.standalone ||
        (!location.standalone && location.root !== this.root)) return false;
    this.source = location.source;
    if (location.standalone) {
      void stopOwnedProcess(this.windowChild);
      this.windowChild = null;
      this.location = location;
      this.root = standaloneRoot(location.source, this.storage);
      Object.assign(this.state, { html: '', windowStatus: '', windowOutput: '', windowBuilding: false });
      this.watch();
    }
    const title = path.basename(this.source, '.zi');
    this.panel.title = `Preview: ${title}`;
    this.state.project = title;
    this.schedule();
    return true;
  }

  reveal() { this.panel.reveal(this.vscode.ViewColumn.Beside); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    void stopOwnedProcess(this.windowChild);
    for (const disposable of [...this.disposables, ...this.watchers]) disposable.dispose();
    this.inspector.dispose();
  }

  post() { if (!this.disposed) this.panel.webview.postMessage(this.state); }

  schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 250);
  }

  async message(message) {
    if (message.type === 'ready') this.post();
    if (message.type === 'run') this.schedule();
    if (message.type === 'openWindow') {
      this.windowQueue = this.windowQueue.then(() => this.openWindow()).catch((error) => {
        Object.assign(this.state, { windowStatus: 'Could not open the window', windowOutput: error.message,
          windowBuilding: false });
        this.post();
      });
      await this.windowQueue;
    }
    await this.inspector.message(message);
  }

  // The program on the selected platform, as one owned process with its own
  // window; opening it again replaces the previous one. On Linux x86-64 the
  // ZX bundle runs natively in the ZX player, which hosts the window; another
  // platform runs its own build its own way (Wine, a device, Node). There is
  // no C, engine or platform fallback: what cannot run shows its named gap.
  async openWindow() {
    if (this.disposed || !this.state.program) return;
    await stopOwnedProcess(this.windowChild);
    this.windowChild = null;
    Object.assign(this.state, { windowStatus: 'Building the window…', windowOutput: '', windowBuilding: true });
    this.post();
    const { bundleArgs, modulePaths, packageRoot, ziranCommand, ziranTool } = require('./targets.cjs');
    const command = await ziranCommand(this.source, this.vscode);
    const paths = await modulePaths(this.source, command, this.vscode);
    const project = await packageRoot(this.source);
    const cwd = project || path.dirname(this.source);
    const key = createHash('sha256').update(this.source).digest('hex').slice(0, 16);
    const output = path.join(this.storage, 'window-zx', key);
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    const bundle = path.join(output, `${path.basename(this.source, '.zi')}.zx`);
    const built = await runCommand(command, bundleArgs(this.source, paths, bundle, Boolean(project)), cwd);
    if (this.disposed) return;
    const failed = (windowStatus, windowOutput) => {
      Object.assign(this.state, { windowBuilding: false, windowStatus, windowOutput });
      this.post();
    };
    if (built.code !== 0 || !(await exists(bundle))) {
      return failed(built.code === 0 ? 'The ZX build wrote no bundle' : 'ZX build failed', (built.stderr || built.stdout).trim());
    }
    const folders = (this.vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
    const { platformArtifact, runRoute } = require('./platforms.cjs');
    const { platform, tools } = await this.inspector.choosePlatform({ command, folders });
    if (this.disposed) return;
    if (!platform) return failed('No platform to run on', 'The toolchain lists no platforms.');
    let launch;
    if (platform.id === 'x86_64-linux' && !platform.gap) {
      const player = await ziranTool(command, 'zi2zx', this.source, folders);
      if (this.disposed) return;
      if (!player) return failed('zi2zx was not found', 'Build it in a Ziran checkout with `make`.');
      // The window needs the editor's display, so it keeps the full environment.
      launch = { command: player, args: ['run', '--backend', 'native', bundle], env: process.env };
    } else {
      const artifact = await platformArtifact(platform, bundle, output, path.basename(this.source, '.zi'), tools);
      if (this.disposed) return;
      if (artifact.problem) return failed(`No ${platform.label} build`, artifact.problem);
      const adbCommands = this.vscode.workspace.getConfiguration('ziran', this.vscode.Uri.file(this.source))
        .get('adbCommands', ['adb']);
      launch = await runRoute(platform, artifact.file, { storage: this.storage, adbCommands, window: true });
      if (this.disposed) return;
      if (launch.missing) return failed(`Can't run on ${platform.label}`, launch.missing);
    }
    const child = spawn(launch.command, launch.args, { cwd, env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, detached: process.platform !== 'win32' });
    this.windowChild = child;
    let text = '';
    const collect = (data) => { text = (text + data.toString()).slice(-65536); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      if (this.windowChild !== child) return;
      Object.assign(this.state, { windowStatus: 'Could not open the window', windowOutput: error.message });
      this.post();
    });
    child.on('close', (code, signal) => {
      if (this.windowChild !== child) return;
      this.windowChild = null;
      Object.assign(this.state, { windowOutput: text.trim(),
        windowStatus: signal ? 'Window stopped' : code ? `${platform.label} run failed (exit ${code})` : 'Window closed' });
      this.post();
    });
    Object.assign(this.state, { windowStatus: `Window open · ${platform.label}`, windowBuilding: false });
    this.post();
  }

  // The target views under the live window, for the previewed source or the
  // project's entry. A save reruns them beside the preview build.
  async inspectTargets() {
    if (this.disposed) return;
    if (this.inspecting) { this.reinspect = true; return; }
    this.inspecting = true;
    try {
      const file = this.source || await projectEntry(this.root);
      this.state.inspectable = Boolean(file);
      if (!file) return;
      const { importingPrograms, mainLine, modulePaths, noMainMessage, ziranCommand } = require('./targets.cjs');
      this.inspector.retarget(file);
      const command = await ziranCommand(file, this.vscode);
      const paths = await modulePaths(file, command, this.vscode);
      let source = '';
      try { source = await fs.readFile(file, 'utf8'); } catch {}
      const hasMain = mainLine(source) >= 0;
      const noMain = hasMain ? '' : noMainMessage(file, await importingPrograms(file));
      const folders = (this.vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      await this.inspector.inspect({ command, paths, hasMain, noMain, folders });
    } catch (error) {
      this.state.results = this.state.enabled.map((id) => ({ id, ok: false, message: error.message, views: [] }));
    } finally {
      this.inspecting = false;
      this.post();
      if (this.reinspect && !this.disposed) { this.reinspect = false; this.inspectTargets(); }
    }
  }

  async run() {
    if (this.disposed) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    this.state.status = 'Building and running…';
    this.post();
    this.inspectTargets();
    try {
      if (this.location.standalone) {
        this.root = await prepareStandalonePreview(this.source, this.storage, this.vscode);
      }
      const configured = this.vscode.workspace.getConfiguration('ziran',
        this.vscode.Uri.file(this.source || this.root));
      let command = configured.get('kryonCommand', '');
      const local = path.join(os.homedir(), '.local', 'bin', 'kryon');
      if (!command) command = await exists(local) ? local : 'kryon';
      const build = await previewBuild(this.root, configured.get('previewProfile', ''));
      const result = await runCommand(command, ['build', '--profile', build.profile], this.root);
      if (this.disposed) return;
      this.state.output = (result.stdout + result.stderr).trimEnd();
      this.state.html = result.code === 0 ? await require('./preview-assets.cjs').previewAssets(build.artifact) : '';
      this.state.status = result.code === 0 ? 'Up to date · reloads on save' :
        `Build or run failed${result.code === null ? '' : ` (exit ${result.code})`}`;
      this.post();
    } catch (error) {
      this.state.status = 'Preview failed';
      this.state.output = error.message;
      this.state.html = '';
      this.post();
    } finally {
      this.running = false;
      if (this.rerun && !this.disposed) { this.rerun = false; this.schedule(); }
    }
  }
}

function activatePreview(context, vscode) {
  const previews = new Map();
  context.subscriptions.push({ dispose() { for (const preview of previews.values()) preview.dispose(); } });
  const runButton = vscode.window.createStatusBarItem('kryon.run',
    vscode.StatusBarAlignment.Left, 1000);
  runButton.name = 'Run Kryon';
  runButton.text = '$(play) Run Kryon';
  runButton.tooltip = 'Run and preview this Kryon project beside the editor';
  runButton.command = 'kryon.preview';
  context.subscriptions.push(runButton);

  const updateRunButton = async () => {
    const locations = [];
    if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
      locations.push(vscode.window.activeTextEditor.document.uri.fsPath);
    }
    for (const folder of vscode.workspace.workspaceFolders || []) locations.push(folder.uri.fsPath);
    let kryon = false;
    for (const location of locations) {
      if (await previewLocation(location)) { kryon = true; break; }
    }
    if (kryon) runButton.show(); else runButton.hide();
    vscode.commands.executeCommand('setContext', 'ziran.kryonProject', kryon);
  };
  // A preview follows the active .zi editor; other editors leave it alone.
  const followEditor = async (editor) => {
    const file = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : '';
    if (!file.endsWith('.zi')) return;
    const location = await previewLocation(file);
    if (!location) return;
    for (const [key, preview] of previews) {
      if (key !== location.key && !(location.standalone && preview.location.standalone && !previews.has(location.key))) continue;
      const before = preview.location.key;
      if (preview.follow(location) && preview.location.key !== before) {
        previews.delete(before);
        previews.set(preview.location.key, preview);
      }
      return;
    }
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => { updateRunButton(); void followEditor(editor); }),
    vscode.workspace.onDidChangeWorkspaceFolders(updateRunButton),
    vscode.languages.registerCodeLensProvider({ language: 'ziran', scheme: 'file' }, {
      async provideCodeLenses(document) {
        if (!(await previewLocation(document.uri.fsPath))) return [];
        return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: '▶ Run Kryon Preview', command: 'kryon.preview', arguments: [document.uri],
        })];
      },
    }),
  );
  updateRunButton();

  context.subscriptions.push(vscode.commands.registerCommand('kryon.preview', async (uri) => {
    const locations = [];
    if (uri?.scheme === 'file') locations.push(uri.fsPath);
    if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
      locations.push(vscode.window.activeTextEditor.document.uri.fsPath);
    }
    for (const folder of vscode.workspace.workspaceFolders || []) locations.push(folder.uri.fsPath);
    let location = null;
    for (const candidate of locations) {
      const found = await previewLocation(candidate);
      if (found) { location = found; break; }
    }
    if (!location) {
      vscode.window.showErrorMessage('Open a Kryon app or a .zi program importing kryon/app to preview it.');
      return;
    }
    if (previews.has(location.key)) { previews.get(location.key).reveal(); return; }
    const preview = new Preview(location, context, vscode);
    previews.set(location.key, preview);
    preview.panel.onDidDispose(() => {
      for (const [key, shown] of previews) if (shown === preview) previews.delete(key);
    });
  }));
}

module.exports = { activatePreview, manifestPath, previewHtml, projectEntry,
  isKryonProgram, prepareStandalonePreview, previewLocation, projectRoot, runCommand,
  safeEnvironment, previewBuild, previewInput, Preview, stopOwnedProcess };
