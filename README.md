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
- **Targets**: one tab per target (C, Go, WebAssembly and Native), with
  syntax highlighting and a file picker; the checkboxes choose the targets and
  save them to `ziran.previewTargets`.

Every target shows one chain, in one order, from the same builds: **Source**,
**ZIR** (the checked program, listed by `zi-inspect`), **LIR**, **Optimized**
(the verified instructions read back from ZX and the optimization report) and
**ZX**. A target shows the stages it really uses, then its own output: C and Go
compile the checked ZIR directly, so they show **Source** and **ZIR**, then
**C** or **Go** with their **Assembly** and **Binary**; WebAssembly and Native
go through ZX, so they show every stage, then **WAT** and **Binary**, or
**Assembly** and **Binary**. `TARGET_STAGES` in `targets.cjs` is the one table
behind both the tabs and the commands each build runs. Source and ZIR list the
program's own modules first, then its dependencies, read only when picked from
the file dropdown above the code. Ziran source is colored with this
extension's own grammar, and the other tabs with light highlighting, in the
editor's light or dark theme.

Saving a `.zi` file in the same directory reruns everything; **Run again** does
it on demand. A file without `main :: ()` still shows its source and generated
code. The program is bundled with `ziran bundle --entry module:main` and run
with `ziran run` on the portable runtime. In Kryon projects ▶ runs the Kryon
preview instead.

Native lowers the pipeline's ZX directly to an ELF. Its **Assembly** is the
whole file: the ELF header, the program headers, each region of the file in
order, code disassembled by `objdump` with a `<module:function>` label at each
function from the native map, and data as bytes. **Hide ELF parts** leaves only
the program's own functions. **Binary** is the whole file in hex, each region
under a label row with its offsets; the same toggle keeps only the program's
code and data. Going to an offset the toggle hides shows the whole file again.
The disassembler follows the ELF's machine (x86-64 now; AArch64 when objdump
supports it).
`zi2zx` writes the LIR, the optimization report and `final.zx`, and lists the
verified ZX; `zx2native` lowers `final.zx` to the native map and ELF. Each is
found beside the `ziran` command or in a Ziran checkout (build them with
`make`), and a missing one is named.
C and Go also produce binaries, whose hex marks the ELF sections; WebAssembly
and ZX binaries mark their sections the same way.
There is one Native checkbox: ZX is a portable instruction stage within it, not
a second target. Native is enabled by default; an older `previewTargets` entry
of `"zx"` selects Native automatically without creating a duplicate option.

Direct native console output currently supports Linux x86-64 using Ziran-owned
formatting and syscall veneers, without libc or a dynamic linker. Unsupported
services, targets and formatting (including floats) produce named gap errors;
Native never falls back to another engine. The regular Run output above these
inspection views still uses the portable runtime.
Build outputs stay in the extension's private storage and are removed when its
Run pane closes; the original example is never replaced with generated stages.

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
the preview; fixing and saving the source restores it. Preview builds cannot
inherit the desktop display.

Under the live window the preview shows the same **Targets** as the Run pane
for the previewed source, or the project's entry when it was opened from a
folder; they rebuild beside the preview on every save.

### Kryon programs

A `.zi` file that imports `kryon/app` and declares `main`, such as Kryon's
`examples/window.zi`, is a program that opens its own window. Running it, with
▶, **▶ Run** or **Kryon: Preview**, opens this preview instead of the Run
pane, and the program's real interface runs live inside the frame. The
extension keeps a private project for the file in its own storage, with one
canvas profile, and the Kryon tool builds the program's `main` for the page.

**Open in window** bundles the program to the same ZX the **ZX** tab shows and
runs it natively (`zi2zx run --backend native`), in one process; opening it
again replaces that process, and closing the preview ends it. There is no
fallback to C or the portable engine: if native code cannot run the program,
the pane shows the tool's named gap. The preview follows the active `.zi`
editor, and its live frame has no padding and a transparent page over the
editor's background.

The portable Run pane does not run such a program: the portable runtime has no
window host, so `App.Run` would return its failure status and the pane would
print that result, `1`, as the program's value. It is `main`'s return value,
not output, and in a C-generated executable the same integer is the process
exit status. The preview's targets show the program's own code first: for
`window.zi`, the C view opens `window.c`, not the Kryon modules the build also
writes. Every other
generated file, such as Kryon, the standard library and runtime support, is
listed under **Dependencies** and is read, compiled to assembly or inspected
only when you pick it. A target that cannot build the program shows a one-line
reason, with the tool's full output collapsed under it.

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

Set `ZIRAN_PREVIEW_WINDOW=1` and `ZIRAN_RUN_TEST=1` with `ZIRAN_PREVIEW_PROJECT`
at a Kryon checkout and `ZIRAN_PREVIEW_ENTRY=examples/window.zi` to test a Kryon
program: Run must open the live embedded canvas, **Open in window** must start
exactly one native ZX process and build no C, and the targets under the
window must show their stage tabs with `window.c` first and the
Kryon modules under Dependencies.

For generated-code Preview on an existing source file, use
`ZIRAN_PREVIEW_PROJECT=/path/to/package ZIRAN_PREVIEW_ENTRY=relative/file.zi npm run test:run`.
Set `ZIRAN_PREVIEW_WORKSPACE` to a parent folder to test workspace nesting.
This mode reads the real source without saving edits and verifies its C and Go
views in a private VSCode window.

Add `ZIRAN_RUN_NATIVE=1` to inspect the existing `examples/hello.zi` through every
Native stage instead. For example, set `ZIRAN_PREVIEW_PROJECT` to the canonical
Ziran checkout and `ZIRAN_PREVIEW_ENTRY=examples/hello.zi`. This also verifies
the full and filtered Assembly and Binary views without changing that source.

Run `npm run test:laws` to verify law token colors in an isolated native VSCode
window on private Xvfb. Set `ZIRAN_INSTALLED_EXTENSION` to an installed extension
folder to test that copy. This preserves the running editor and its profile.
