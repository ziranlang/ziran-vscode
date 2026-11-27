const fs = require('node:fs');
const path = require('node:path');

// This package only consumes checked declarations. It never runs the compiler,
// parses native types, changes language modes or replaces diagnostic methods.
function projectRoot(file) {
  let directory = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(directory, 'ziran.toml'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function readManifest(root) {
  const directory = path.join(root, 'build', '.ziran', 'types');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.globals) || !Array.isArray(manifest.resolutions)) {
    throw new Error('Expected TypeScript binding manifest schema_version 1, globals and resolutions');
  }
  const declaration = relative => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || !/\.d\.[cm]?ts$/.test(relative)) {
      throw new Error(`Expected a relative declaration path: ${String(relative)}`);
    }
    const file = path.resolve(directory, relative);
    if (!fs.statSync(file).isFile()) throw new Error(`Declaration is not a file: ${file}`);
    return file;
  };
  const globals = manifest.globals.map(declaration);
  const resolutions = new Map();
  for (const resolution of manifest.resolutions) {
    if (typeof resolution.source !== 'string' || !path.isAbsolute(resolution.source) ||
        !resolution.imports || typeof resolution.imports !== 'object' || Array.isArray(resolution.imports)) {
      throw new Error('Expected an absolute source and an imports object');
    }
    const source = path.resolve(resolution.source);
    if (resolutions.has(source)) throw new Error(`Duplicate source mapping: ${source}`);
    resolutions.set(source, new Map(Object.entries(resolution.imports).map(([name, file]) => [name, declaration(file)])));
  }
  return { globals, resolutions };
}

module.exports = ({ typescript: ts }) => {
  const states = new Map();
  const report = (state, text) => {
    if (state.errors.has(text)) return;
    state.errors.add(text);
    state.info.project.projectService.logger.info(`[ziran-typescript-plugin] ${text}`);
  };
  const manifestFor = (state, file) => {
    if (!state.roots.has(file)) state.roots.set(file, projectRoot(file));
    const root = state.roots.get(file);
    if (!root) return null;
    if (!state.manifests.has(root)) {
      try { state.manifests.set(root, readManifest(root)); }
      catch (error) {
        report(state, `Bindings unavailable for ${root}: ${error.message}. Run an explicit Ziran check with a compiler that emits TypeScript bindings.`);
        state.manifests.set(root, null);
      }
    }
    return state.manifests.get(root);
  };
  const mapped = (state, name, source) => {
    const file = manifestFor(state, source)?.resolutions.get(path.resolve(source))?.get(name);
    if (!file) return undefined;
    const extension = file.endsWith('.d.mts') ? ts.Extension.Dmts : file.endsWith('.d.cts') ? ts.Extension.Dcts : ts.Extension.Dts;
    return { resolvedFileName: file, extension, isExternalLibraryImport: true };
  };
  return {
    create(info) {
      const state = { info, roots: new Map(), manifests: new Map(), errors: new Set() };
      states.set(info.project, state);
      const host = info.languageServiceHost;
      const originalFiles = host.getScriptFileNames.bind(host);
      host.getScriptFileNames = () => {
        const files = new Set(originalFiles());
        for (const source of [...files]) {
          for (const file of manifestFor(state, source)?.globals || []) files.add(file);
        }
        return [...files];
      };
      const originalLiterals = host.resolveModuleNameLiterals?.bind(host);
      const originalNames = host.resolveModuleNames?.bind(host);
      if (originalLiterals || !originalNames) {
        host.resolveModuleNameLiterals = (literals, source, redirected, options, ...rest) => {
          const normal = originalLiterals ? originalLiterals(literals, source, redirected, options, ...rest) :
            literals.map(literal => ts.resolveModuleName(literal.text, source, options, host, undefined, redirected));
          return literals.map((literal, index) => {
            const resolvedModule = mapped(state, literal.text, source);
            return resolvedModule ? { resolvedModule } : normal[index];
          });
        };
      } else {
        host.resolveModuleNames = (names, source, ...rest) => {
          const normal = originalNames(names, source, ...rest);
          return names.map((name, index) => mapped(state, name, source) || normal[index]);
        };
      }
      return info.languageService;
    },
    getExternalFiles(project) {
      const state = states.get(project);
      if (!state) return [];
      const files = new Set();
      for (const source of project.getRootFiles()) {
        for (const file of manifestFor(state, source)?.globals || []) files.add(file);
      }
      return [...files];
    },
    onConfigurationChanged(configuration) {
      for (const [project, state] of states) {
        if (project.isClosed?.()) { states.delete(project); continue; }
        if (configuration?.project && !state.manifests.has(configuration.project)) continue;
        state.manifests.clear();
        state.roots.clear();
        state.errors.clear();
        // Explicit Check/Run/Preview refreshes failed resolutions as well as
        // previously loaded declarations. The stock language service rechecks.
        project.projectService.clearSemanticCache(project);
        project.updateGraph();
        project.refreshDiagnostics();
      }
    },
  };
};
