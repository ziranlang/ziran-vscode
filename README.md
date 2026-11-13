# Ziran Language for VS Code

Editor support for Ziran `.zi` source: syntax highlighting, brackets, comments,
import completion, and Go to Definition for extensionless `#import "module"`
statements. Modules are discovered from `.zi` and `.zir` files in the open
workspace. The extension also finds the standard modules in a sibling `ziran/std`
directory, so a Kryon workspace can import them without listing every module.
This is language support for any Ziran project; it does not bundle Kryon widgets.
A single `.zi` file works without a folder or `kryon.toml`: its own directory
and the Ziran checkout's `std` are searched for imports.

Inside a Ziran package (a folder with `ziran.toml`), files are checked with
`ziran check --project`, so dependencies added with `ziran add URL` are
checked too. Go to Definition and import completion then follow the
project's module map: `#import "kryon/Widgets"` opens that dependency's
exported module, `#import "std/text"` the pinned standard library, and a
short name resolves the way the compiler resolves it.

## Running

Click ▶ in the editor title bar, or **▶ Run** above `main`, to open the **Run**
pane beside a `.zi` file. Like the Kryon preview it shows, top to bottom:

- the program's output in a window, with the run time and any build or runtime
  errors below it (a run stops after 10 seconds);
- **Generated code**: the C, Go and WebAssembly that `ziran build`
  writes, one tab per target with syntax highlighting and a file picker; the
  checkboxes choose the targets and save them to `ziran.previewTargets`;
- **ZIR** beside Go shows highlighted checked modules; **WAT** shows readable
  WebAssembly text and the binary hex view.

Saving a `.zi` file in the same directory reruns everything; **Run again** does
it on demand. A file without `main :: ()` still shows its generated code and
`.zir`. The program is bundled with `ziran bundle --entry module:main` and run
with `ziran run` on the portable runtime. In Kryon projects ▶ runs the Kryon
preview instead.

## Checking

Opening or saving a `.zi` file runs `ziran check` on it and lists any errors in
the **Problems** panel and under the source. A file checks with its own
directory as the root, as `ziran check --root . file.zi` would.
Type errors link to related declarations in the Problems panel. Missing-name
errors offer a Quick Fix when the compiler identifies an unambiguous source
replacement; a fix is discarded if the name has changed since checking.

## Names, hover, and definitions

The extension asks `ziran api` which procedures, types, constants, and globals
a file's program declares, including those of its imports. Completion offers
them with their signatures, hovering a name shows its declaration and the
`//` comment above it, and Go to Definition opens the line that declares it.
A name the file's own module declares wins over an imported one of the same
name.

## Finding the compiler

Checking, the Run pane, and `.zir` browsing use the `ziran`
command from `ziran.command` when set. Kryon packages otherwise use the installed
`~/.local/bin/ziran` wrapper (then `PATH`) so the package toolchain and local
overrides select the compiler. Other files use a Ziran checkout's
`build/bin/ziran` found above the file, in a Kryon project's `[paths].ziran`,
or beside the workspace folder, then `~/.local/bin/ziran`, then `PATH`.

## Kryon preview

Open an example source such as `examples/button/button.zi` in a Kryon app with
`ziran.toml` (or legacy `kryon.toml`), then click **Run Kryon** in the status
bar, **Run Kryon Preview** above the source, or **Kryon: Preview** in the Command
Palette. The nearest app manifest selects the entry; no `app.zi` filename is required.

The preview builds through `build-queue -- kryon build --profile PROFILE` and
embeds the generated HTML, JavaScript, WebAssembly and packaged assets in an isolated
interactive frame. It selects
`portable_web`, then `web`, then another canvas profile. Set `ziran.previewProfile`
to choose a canvas profile explicitly and `ziran.kryonCommand` to select the launcher.
The launcher uses the project's package toolchain and local overrides.

Saving sources in the workspace, or changing app manifests, overrides or locks,
rebuilds the preview. Generated build files are excluded to prevent rebuild loops.
**Run again** rebuilds on demand. Build errors appear below
the preview; fixing and saving the source restores it. Generated C and inspected
`.zir` modules come from `build/generated/PROFILE/`. Preview builds cannot inherit
the desktop display.

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

## Local preview tests

Selected files inside a Ziran package use `--project` for generated targets,
checked IR and portable execution. The package CLI supplies module roots,
dependency exports and local overrides even when the editor opens a parent
workspace. Standalone files retain their own directory as the module root.

Run `npm test` for the local suite and `npm run test:preview` for a fresh VSCode
extension host on a private Xvfb display. The latter verifies an interactive test
page, editor saves, build errors and recovery. For a real app build, set
`ZIRAN_PREVIEW_PROJECT` to its directory and `ZIRAN_PREVIEW_ENTRY` to its entry
filename before running `npm run test:preview`. This uses installed VSCode and
requires `build-queue` and the project toolchain on PATH.

Set `ZIRAN_PREVIEW_FIXTURE=1` for a disposable real Button app using canonical
Kryon/compiler overrides. That test also compiles saved edits, verifies an actual
malformed-source error, repairs it, and checks restored interactive pixels.
Maintained example sources are never edited.

For generated-code Preview on an existing source file, use
`ZIRAN_PREVIEW_PROJECT=/path/to/package ZIRAN_PREVIEW_ENTRY=relative/file.zi npm run test:run`.
Set `ZIRAN_PREVIEW_WORKSPACE` to a parent folder to test workspace nesting.
This mode reads the real source without saving edits and verifies its C, Go
and checked IR views in a private VSCode window.

Run `npm run test:laws` to verify law token colors in an isolated native VSCode
window on private Xvfb. Set `ZIRAN_INSTALLED_EXTENSION` to an installed extension
folder to test that copy. This preserves the running editor and its profile.
