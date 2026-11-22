# Ziran Language for VS Code

Editor support for Ziran `.zi` source: syntax highlighting, brackets, comments,
import completion, and Go to Definition for extensionless `#import "module"`
statements. Modules are discovered from `.zi` and `.zir` files in the open
workspace, plus a sibling `ziran/std` directory, so a Kryon workspace can import
the standard modules without listing them. A single `.zi` file works without a
folder: its own directory and the Ziran checkout's `std` are searched.

Inside a Ziran package (a folder with `ziran.toml`), files are checked with
`ziran check --project`, so dependencies added with `ziran add URL` are checked
too. Definition and completion then follow the project's module map:
`#import "kryon/Widgets"` opens that dependency's exported module,
`#import "std/text"` the pinned standard library, and a short name resolves the
way the compiler resolves it. This is language support for any Ziran project;
it does not bundle Kryon widgets.

## Run pane

Click ▶ in the editor title bar, or **▶ Run** above `main`, to open the **Run**
pane beside a `.zi` file. It shows the program's output in a window, with the
run time and any build or runtime errors below it (a run stops after 10
seconds), and **Targets**: one tab per target (C, Go, WebAssembly and Native),
with syntax highlighting and a file picker; the checkboxes choose the targets
and save them to `ziran.previewTargets`.

Every target shows one chain, in one order, from the same builds: **Source**,
**ZIR** (the checked program, listed by `zi-inspect`), **LIR**, **Optimized**
(the verified instructions read back from ZX and the optimization report) and
**ZX**. A target shows the stages it really uses, then its own output: C and Go
compile the checked ZIR directly (Source, ZIR, then **C**/**Go** with
**Assembly** and **Binary**); WebAssembly and Native go through ZX (every
stage, then **WAT** and **Binary**, or **Assembly** and **Binary**).
`TARGET_STAGES` in `targets.cjs` is the one table behind both the tabs and the
commands each build runs. Source and ZIR list the program's own modules first,
then its dependencies, read only when picked from the file dropdown above the
code. Ziran source is colored with this extension's grammar; the other tabs use
light highlighting in the editor's theme.

Saving a `.zi` file in the same directory reruns everything; **Run again** does
it on demand. A file without `main :: ()` still shows its source and generated
code. The program is bundled with `ziran bundle --entry module:main` and run
with `ziran run` on the portable runtime. In Kryon projects ▶ runs the Kryon
preview instead.

### Platforms

The **Platform** dropdown beside the target checkboxes chooses what Native
lowers ZX to and where ▶ runs. It lists every row of `ziran capabilities
--json`, checked against `zx2native`'s own `--target`, `--platform` and
`--emit` choices and a probe of each row, then **Wasm** from `zx2wasm`. A row
the toolchain refuses is listed but disabled, with its gap by name (for example
`assembly.gap.machine-platform-service-unavailable`). The choice is saved to
`ziran.previewPlatform`. The shared stages are the same on every platform; only
Native's output changes:

- **Linux x86-64**: an ELF, run directly.
- **Windows x86-64**: a PE `.exe` (`zx2native --platform windows`), run under
  Wine with a private `WINEPREFIX` in the extension's storage and
  `WINEDEBUG=-all`.
- **Linux or Android AArch64 and ARMv7**: an ELF, run on an attached device
  through adb. `ziran.adbCommands` lists how to reach adb, such as `adb` or
  `ssh user@host adb`; the first device whose primary Android ABI matches runs
  it. With no device the platform still analyzes, and Run names what is missing.
- **Wasm**: a `zx2wasm` module, shown as **WAT** and **Binary**, run in Node by
  the extension's `wasm-run.cjs`.

Each run is one process with its output in the pane; nothing falls back to
another platform, and a missing route (no Wine, no device, no Node) is named.
In the Kryon preview, **Open in window** follows the same choice and runs the
build the **Binary** tab shows.

### Assembly and binary views

A machine format's **Assembly** is the whole file. For an ELF: the ELF header,
program headers and each region of the file in order. For a PE: the DOS header
and stub, PE headers, section table and imports, then each region, with calls
through the import address table named as `<KERNEL32.dll!WriteFile>`. Code is
disassembled with a `<module:function>` label at each function from the native
map; data is shown as bytes. **Hide ELF parts** or **Hide PE parts** leaves
only the program's own functions; going to an offset the toggle hides shows
the whole file again. **Binary** is the whole file in hex, each region under a
label row with its offsets. The disassembler follows the file's machine:
`objdump` reads x86-64 ELF and PE code (`i386:x86-64`), and AArch64 and ARM
code goes to a cross `objdump` or, when that is missing, the Android NDK's
`llvm-objdump`. `zi2zx` writes the LIR, the optimization report and
`final.zx`; `zx2native` lowers `final.zx` to the native map and ELF. Each is
found beside the `ziran` command or in a Ziran checkout (build them with
`make`), and a missing one is named. C and Go also produce binaries whose hex
marks the ELF sections; WebAssembly and ZX binaries mark their sections the
same way. There is one Native checkbox: ZX is a portable instruction stage
within it, not a second target. Native is enabled by default; an older
`previewTargets` entry of `"zx"` selects Native automatically.

Direct native console output uses Ziran-owned formatting and syscall veneers,
without libc or a dynamic linker. Unsupported services, targets and formatting
(including floats) produce named gap errors; Native never falls back to another
engine, and Run shows the same gap for the program. Build outputs stay in the
extension's private storage and are removed when its Run pane closes; the
original source is never replaced with generated stages.

## Checking

Opening or saving a `.zi` file runs `ziran check` on it and lists errors in the
**Problems** panel and under the source, with the file's own directory as the
root, as `ziran check --root . file.zi` would. Type errors link to related
declarations. Missing-name errors offer a Quick Fix when the compiler
identifies an unambiguous source replacement; a fix is discarded if the name
has changed since checking.

## Names, hover, and definitions

The extension asks `ziran api` which procedures, types, constants and globals
a file's program declares, including those of its imports. Completion offers
them with their signatures, hovering a name shows its declaration and the
`//` comment above it, and Go to Definition opens the declaring line. A name
the file's own module declares wins over an imported one of the same name.

## Finding the compiler

Checking, the Run pane and `.zir` browsing use the `ziran` command from
`ziran.command` when set. Kryon packages otherwise use the installed
`~/.local/bin/ziran` wrapper (then `PATH`) so the package toolchain and local
overrides select the compiler. Other files use a Ziran checkout's
`build/bin/ziran` found above the file, in a Kryon project's `[paths].ziran`,
or beside the workspace folder, then `~/.local/bin/ziran`, then `PATH`.

## Kryon preview

Open an example source such as `examples/button/button.zi` in a Kryon app with
`ziran.toml` (or legacy `kryon.toml`), then click **Run Kryon** in the status
bar, **Run Kryon Preview** above the source, or **Kryon: Preview** in the
Command Palette. The nearest app manifest selects the entry; no `app.zi`
filename is required.

The preview builds through `build-queue -- kryon build --profile PROFILE` and
embeds the generated HTML, JavaScript, WebAssembly and packaged assets in an
isolated interactive frame. It selects `portable_web`, then `web`, then another
canvas profile. Set `ziran.previewProfile` to choose a canvas profile
explicitly and `ziran.kryonCommand` to select the launcher, which uses the
project's package toolchain and local overrides. Saving sources, or changing
app manifests, overrides or locks, rebuilds the preview; generated build files
are excluded to prevent rebuild loops. **Run again** rebuilds on demand. Build
errors appear below the preview; fixing and saving the source restores it.
Preview builds cannot inherit the desktop display. Under the live window the
preview shows the same **Targets** as the Run pane for the previewed source, or
the project's entry when it was opened from a folder.

### Kryon programs

A `.zi` file that imports `kryon/app` and declares `main`, such as Kryon's
`examples/window.zi`, is a program that opens its own window. Running it, with
▶, **▶ Run** or **Kryon: Preview**, opens the preview instead of the Run pane,
and the program's real interface runs live inside the frame. The extension
keeps a private project for the file in its own storage, with one canvas
profile, and the Kryon tool builds the program's `main` for the page.

**Open in window** bundles the program to the same ZX the **ZX** tab shows,
lowers it for the selected platform as the **Binary** tab does and runs that,
in one process; opening it again replaces that process, and closing the
preview ends it. On Linux x86-64 the executable links its host capabilities,
such as Kryon's window, from the host libraries registered beside the ZX
players (`make install-user` in Kryon registers its desktop library). On the
Wasm platform it runs the program's ZX in the page instead: a canvas profile
with `codegen = "zx"` (`wasm` in a single-file preview's own project) builds
Kryon's canvas player around the bundle, which lowers it to Wasm in the page
and runs its `main` with the page's canvas as its window. There is no fallback
to C, a player or the portable engine: a capability no registered library
provides, or a program that cannot run, shows the tool's named gap in the
pane. The preview follows the active `.zi` editor, and its live frame has no
padding and a transparent page over the editor's background.

The portable Run pane does not run such a program: the portable runtime has no
window host, so `App.Run` would return its failure status and the pane would
print that result, `1`, as the program's value. It is `main`'s return value,
not output, and in a C-generated executable the same integer is the process
exit status. The preview's targets show the program's own code first: for
`window.zi`, the C view opens `window.c`, not the Kryon modules the build also
writes. Every other generated file, such as Kryon, the standard library and
runtime support, is listed under **Dependencies** and is read, compiled to
assembly or inspected only when you pick it. A target that cannot build the
program shows a one-line reason, with the tool's full output collapsed under it.

## Browse checked modules

Open any `.zir` file in VS Code to see its inspected declarations and
expressions instead of binary bytes. The outline lists its types, functions
and globals. Use **Hex** to see byte offsets and **Open as Text** for VS Code's
normal search, selection and outline tools; the view refreshes when the file
changes. For module directories outside the workspace, set `ziran.modulePaths`
(absolute or relative to the workspace folder); the compiler still needs the
corresponding `--module-path` arguments when building. If several files have
the same module name, Go to Definition offers every match.

## Install

Download the `.vsix` from the [latest GitHub
Release](https://github.com/ziranlang/ziran-vscode/releases/latest), then run:

```sh
code --install-extension ziran-language-*.vsix
```

Or use **Extensions: Install from VSIX...** in VS Code and reload the window.
New `.zi` tabs open in Ziran mode automatically; if an existing tab still says
Plain Text, use **Change Language Mode** and select **Ziran**.

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

Run `npm test` for the local suite and `npm run test:preview` for a fresh VSCode
extension host on a private Xvfb display; the latter verifies an interactive
test page, editor saves, build errors and recovery. Selected files inside a
Ziran package use `--project` for generated targets, checked IR and portable
execution; the package CLI supplies module roots, dependency exports and local
overrides even when the editor opens a parent workspace, and standalone files
retain their own directory as the module root.

| Environment | Test |
|---|---|
| `ZIRAN_PREVIEW_PROJECT=DIR` + `ZIRAN_PREVIEW_ENTRY=FILE` | real app build for `test:preview` / generated-code Preview via `test:run`; needs installed VSCode, `build-queue` and the project toolchain on PATH |
| `ZIRAN_PREVIEW_FIXTURE=1` | disposable real Button app with canonical Kryon/compiler overrides; compiles saved edits, verifies a malformed-source error, repairs it, checks restored interactive pixels; maintained examples are never edited |
| `ZIRAN_PREVIEW_WINDOW=1` + `ZIRAN_RUN_TEST=1` (+ project/entry at a Kryon checkout, `examples/window.zi`) | Run opens the live embedded canvas; **Open in window** starts exactly one native executable, builds no C, shows one 320x160 window titled "Window", `window.c` first in targets, Kryon modules under Dependencies and Native's Assembly of the linked executable |
| `ZIRAN_HOST_PATH=DIR` | registry holding Kryon's `.library` file (alternative to `make install-user`) |
| `ZIRAN_PREVIEW_COMMAND=CMD` | points the editor at another `ziran` command and the tools beside it |
| `ZIRAN_PREVIEW_WORKSPACE=DIR` | parent folder for workspace-nesting tests; reads the real source without saving edits and verifies its C and Go views in a private VSCode window |
| `ZIRAN_RUN_NATIVE=1` | inspects `examples/hello.zi` through every Native stage, including full and filtered Assembly and Binary views, without changing that source |
| `ZIRAN_INSTALLED_EXTENSION=DIR` | `npm run test:laws`: test an installed extension copy in an isolated native VSCode window on private Xvfb, preserving the running editor and its profile |
