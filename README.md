# Ziran Language for VS Code

Editor support for Ziran `.zi` source: syntax highlighting, brackets, comments,
import completion, and Go to Definition for extensionless `#import "module"`
statements. Modules are discovered from `.zi` and `.zir` files in the open
workspace. The extension also finds the standard modules in a sibling `ziran/std`
directory, so a Kryon workspace can import them without listing every module.
This is language support for any Ziran project; it does not bundle Kryon widgets.
A single `.zi` file works without a folder or `kryon.toml`: its own directory
and the Ziran checkout's `std` are searched for imports.

## Checking

Opening or saving a `.zi` file runs `ziran check` on it and lists any errors in
the **Problems** panel and under the source. A file checks with its own
directory as the root, as `ziran check --root . file.zi` would.

## Generated code preview

Click the **Ziran: Preview Generated Code** button in the editor title bar of
any `.zi` file. The panel beside the source shows the C, C++, Go, Rust, and
Plan 9 C that `ziran build` generates, one tab per target, with a file picker
for targets that write several files. It rebuilds when a `.zi` file in the same
directory is saved; **Rebuild** runs it on demand. A target that fails shows its
diagnostics in its tab instead of code.

The checkboxes choose which targets to generate and save the choice to the
`ziran.previewTargets` setting (workspace folder, or user settings for a file
outside any folder). The `.zir` checked module is the same for every target, so
the panel shows only target code; open a saved `.zir` file to browse it.

## Finding the compiler

Checking, the generated code preview, and `.zir` browsing use the `ziran`
command from `ziran.command` when set. Otherwise they use a Ziran checkout's
`build/bin/ziran` found above the file, in a Kryon project's `[paths].ziran`,
or beside the workspace folder, then `~/.local/bin/ziran`, then `PATH`.

## Kryon preview

This appears only in Kryon projects. Open a Kryon app folder containing
`kryon.toml`, then click **Run Kryon** in
the lower-left status bar. A **Run Kryon Preview** link also appears above
Ziran source, and **Kryon: Preview** is available in the Command Palette.
The rendered terminal frame appears in a canvas window
beside the source. Saving a file under `src/` or changing `kryon.toml` rebuilds
and reruns the app after a short delay. **Run again** refreshes it on demand.

The preview executes the project's normal `kryon run` command. Its **Generated
C** and **Checked .zir** sections show the modules from that build; selecting a
module updates the source or Ziran inspector view. The `.zir` representation is
the current checked intermediate format. Kryon's old KIR format is no longer
used. The preview uses the `~/.local/bin/kryon` launcher if present, then
`kryon` from `PATH`. Set `ziran.kryonCommand` for a custom launcher, and
`ziran.previewProfile` to select a non-default profile. A sibling Ziran
checkout is used for `.zir` inspection unless `[paths].ziran` names another.
The preview's child processes do not inherit the desktop display.

## Browse checked modules

Open any `.zir` file in VS Code to see its inspected declarations and expressions
instead of binary bytes. The outline lists its types, functions, and globals.
Use **Hex** to see byte offsets and **Open as Text** for VS Code's normal search,
selection, and outline tools. The view refreshes when the `.zir` file changes.

For module directories outside the workspace, set `ziran.modulePaths` in VS Code
settings. Paths may be absolute or relative to the workspace folder. The
compiler still needs the corresponding `--module-path` arguments when building.
If several files have the same module name, Go to Definition offers every match.

## Install

Download the `.vsix` from the [latest GitHub Release](https://github.com/ziranlang/ziran-vscode/releases/latest), then run:

```sh
code --install-extension ziran-language-*.vsix
```

You can also use **Extensions: Install from VSIX...** in VS Code. Reload the
window after installing. New `.zi` tabs will open in Ziran mode automatically.
If an existing tab still says Plain Text in the status bar, use **Change Language
Mode** and select **Ziran**.

## Build

```sh
npm ci
npm test
npm run package
```

GitHub Actions uploads a VSIX from every build. Maintainers can use the
workflow's **Run workflow** button with **Publish GitHub Release** enabled to
publish the package version as a public release.
