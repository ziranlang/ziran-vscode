# Ziran Language for VS Code

Editor support for Ziran `.zi` source: syntax highlighting, brackets, comments,
import completion, and Go to Definition for extensionless `#import "module"`
statements. Modules are discovered from `.zi` and `.zir` files in the open
workspace. The extension also finds the standard modules in a sibling `ziran/std`
directory, so a Kryon workspace can import them without listing every module.
This is language support for any Ziran project; it does not bundle Kryon widgets.

## Kryon preview

Open a Kryon app folder containing `kryon.toml`, then click **Run Kryon** in
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
Set `ziran.inspectorCommand` if the Ziran compiler is outside the project or
usual sibling checkout.

For module directories outside the workspace, set `ziran.modulePaths` in VS Code
settings. Paths may be absolute or relative to the workspace folder. The
compiler still needs the corresponding `--module-path` arguments when building.
If several files have the same module name, Go to Definition offers every match.

## Install

Download the `.vsix` from the [latest GitHub Release](https://github.com/kryonlabs/kryon-vscode/releases/latest), then run:

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
