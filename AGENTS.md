# AGENTS.md — Ziran Language for VS Code

Editor support for Ziran `.zi` source: syntax highlighting, brackets, comments,
import completion, Go to Definition, `ziran check` diagnostics with Quick Fix,
a Run pane with per-target build stages, and a Kryon preview. Published as the
`ziran-language` extension (.vsix on GitHub Releases). Version lives in
`package.json` and is bumped with `./update_version.sh`.

## Layout map (question -> file)

| Question | File |
|---|---|
| Activation, commands, settings? | `extension.cjs` |
| Run pane (bundle, run, tabs)? | `run.cjs` |
| Kryon preview build/embedding? | `preview.cjs`, `preview-assets.cjs` |
| Which stages each target shows? | `TARGET_STAGES` in `targets.cjs` |
| Native lowering, Wine, adb, Node runs? | `platforms.cjs` |
| ELF/PE assembly and binary hex views? | `disassembly.cjs`, `binary-layout.cjs` |
| Target views shared by pane and preview? | `inspector.cjs` |
| Inspected `.zir` editor? | `zir-editor.cjs` |
| Declarations, hover, definitions? | `symbols.cjs` (`ziran api --json`) |
| Module discovery and import paths? | `module-index.cjs` |
| Ziran grammar / preview coloring? | `highlight.cjs`, `syntaxes/ziran.tmLanguage.json` |
| Problems and Quick Fix records? | `diagnostics.cjs` |
| Run a `zx2wasm` module in Node? | `wasm-run.cjs` |
| Tests? | `tests/*.test.mjs`, `tests/*-browser.mjs` |

## Commands (from package.json)

```sh
npm ci                # install dependencies pinned by package-lock.json
npm test              # unit suite: node --test tests/*.test.mjs
npm run test:preview  # fresh extension host on a private Xvfb display
npm run test:laws     # law token colors in an isolated native VSCode window
npm run test:run      # generated-code preview on an existing source file
npm run package       # vsce package
```

## Dependency pins

Runtime: `@iarna/toml`, `vscode-oniguruma`, `vscode-textmate`, `wabt`.
Dev: `@vscode/vsce`, `playwright-core`. Engine: VS Code `^1.80.0`.
Exact versions are pinned by `package-lock.json`; install only with `npm ci`.

## Notes

- Compiler discovery: `ziran.command` setting; else the installed
  `~/.local/bin/ziran` wrapper (Kryon packages); else a Ziran checkout's
  `build/bin/ziran` above the file, in a Kryon project's `[paths].ziran`, or
  beside the workspace; else `PATH`.
- Release: GitHub Actions uploads a VSIX from every build; maintainers publish
  with the workflow's **Run workflow** button and **Publish GitHub Release**.
- Install locally: `code --install-extension ziran-language-*.vsix`.
