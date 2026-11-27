# Changes

## Unreleased

- Generate checked TypeScript bindings on explicit native TS/TSX Check, Run
  and Preview actions, and discard cached mappings after generation fails.

- Let the stock TypeScript server consume compiler-generated declarations and
  exact per-source import mappings from `build/.ziran/types/manifest.json`.
  Explicit compiler actions refresh cached bindings without suppressing type
  errors, changing language modes or running a compiler while editing.

- Run a single explicitly exported entry procedure by its declared name,
  including uppercase `Main`. Forward that entry through checked IR, bundles
  and each executable target instead of forcing `module:main`.

- Run compiler analysis only on explicit Check, Run and Preview actions. Typing,
  opening, saving and switching files no longer launch checks, API queries or
  preview rebuilds; completion and hover read the last explicit analysis cache.

- Treat TypeScript and TSX native sources inside a Ziran package as pipeline
  files: the Run button and Kryon preview follow them like `.zi`, rebuilds
  watch them, module discovery and snippets cover them, and the Ziran compiler
  checks them with its own diagnostics — the built-in TypeScript language
  keeps its highlighting, with no declaration shim hiding real type errors.

- Read compiler diagnostics in the toolchain's current JSON schema, so type
  errors, related declarations and quick fixes reach the Problems panel again;
  a failed check surfaces as a visible error instead of clearing silently.

- Open `.zx` bundles in a dedicated inspected editor beside the `.zir` one,
  with Ziran and native TSX snippet suggestions.

- Group internal module files under their owning package, including examples opened inside a library checkout.

- Browse every target’s files in a keyboard-accessible tree, with Project and
  Packages folders, instead of separate dependency and own-code dropdowns.

- Copy registered Windows host DLLs and their sibling runtime DLLs beside
  generated PE executables, so native GUI programs run under Wine.

- Check C, Go and portable source with their own compiler targets. C and Go
  dependency explorers no longer reuse portable window and frame-loop modules.

- Name dependency files by their import paths in every target view, and resolve source declarations through the package map instead of assuming hashed package names.
- Keep the project's own completion scope when its modules resolve through the map, and use native ELF sections to keep literals and metadata out of instruction listings.
- **Open in window** on the Wasm platform runs the program's ZX in the page, in the frame the web preview uses, instead of in Node, which has no host for its capabilities: a canvas profile with `codegen = "zx"` (`wasm`, which a single-file preview's own project now has) builds Kryon's canvas player around the bundle, which lowers it to Wasm in the page and runs `main` with the page's canvas as its window. A project with no such profile names that.
- **Open in window** runs the build the Binary tab shows on every platform: on Linux x86-64, the native executable itself, which links a Kryon program's window from Kryon's registered desktop host library, instead of `zi2zx run`, which never found the registered host and stopped at "missing host capability". Native's Assembly and Binary for `examples/window.zi` show that executable instead of the machine-host gap, and a capability no registered library provides still shows its named gap.
- Leave a viewport of room under the Targets views, so switching to a tab or view with a shorter block keeps the page where it was instead of pulling it up.
- Add a **Platform** dropdown beside the target checkboxes, listing what the toolchain can build: every `ziran capabilities` row checked against `zx2native`'s usage and a probe of each, plus Wasm from `zx2wasm`. A refused row is disabled and shows its gap by name; Windows x86-64 lights up when `zx2native --platform windows` lands. The choice is saved to `ziran.previewPlatform`.
- End Native in the platform's own output: Assembly and Binary of the ELF or PE, or WAT and Binary for Wasm; the shared stages are unchanged. Read PE files: the DOS header and stub, PE headers, sections and imports, with import-table calls named and **Hide PE parts** leaving only the program's code. Disassemble AArch64 and ARM with a cross `objdump` or the Android NDK's `llvm-objdump`, and take the machine from the file rather than the map.
- Run on the chosen platform its own way: Linux x86-64 directly, Windows under Wine in a private prefix with `WINEDEBUG=-all`, AArch64 and ARMv7 on a device through adb (`ziran.adbCommands`, such as `ssh user@host adb`), and Wasm in Node. One process per run, no fallback to another platform, and a missing route is named. **Open in window** follows the same choice.
- Save the Platform and target choices in a folder's settings: both settings are resource-scoped now, where VS Code refused the folder write for `previewTargets` ("does not support the folder resource scope"), and a choice that cannot be saved shows why in the Run pane.
- Fix a crash when an `objdump` candidate is not installed: its start error and exit closed the listing file twice.

- Show every target's real stages from one table: Source, ZIR, LIR, Optimized, ZX, then the target's output. C and Go compile the checked ZIR directly and show Source and ZIR only; WebAssembly and Native show the whole chain. Shared stages are built once, ZIR is back as a stage (listed by the toolchain that wrote it), and C, Go, LIR and ZX steps no longer run for tabs that do not use them.
- Show all Source, ZIR and generated files in one tree: the program's own modules first, with dependency content loaded when opened.
- Color the Source tab with the extension's own Ziran grammar, dependency sources included, and add light highlighting for assembly.
- **Open in window** now bundles the program to ZX and runs it natively with `zi2zx run --backend native`, one process, replaced by the next click and ended with the preview; no C or engine fallback, and a gap is shown by name.
- The Kryon preview follows the active `.zi` editor, drops the padding around the live frame and its empty controls strip, and makes the frame's page transparent over the editor's background.

- Show the whole ELF in Native's **Assembly**, which was empty: Ziran's direct ELFs carry no section headers, so `objdump -d` found nothing to disassemble. The view now lists the ELF header, the program headers and every region of the file in order, with code disassembled by `objdump` at its load address under `<module:function>` labels from the native map, and data as bytes. **Hide ELF parts** leaves only the program's own functions; for `hello.zi` that is `<hello:main>`. The disassembler follows the ELF's machine.
- Show the whole file in every **Binary** and ZX view, each region (header, padding, runtime, code, data, section) under a label row with its offsets. The same toggle keeps only the program's code and data, and going to a hidden offset shows the whole file again.
- Show the whole pipeline for every target, built once and shared, then the target's own output (C or Go with Assembly and Binary, WAT and Binary, or Native's Assembly and Binary).
- Remove the views' description lines and the generated comment headers above Native's disassembly.
- Show the Kryon preview's targets right under its live window, for the previewed source or the project's entry, rebuilt on every save. **Inspect Targets** is removed from the preview and the editor title bar. **Open in window** runs a Kryon program's C executable in a window of its own; opening it again replaces that window and closing the preview ends it.
- Open the program's entry module first in generated views. All files remain available in the Project and Packages tree; dependency text, assembly and inspected modules load when opened.
- Remove the Kryon preview's raw Kryon-profile **Generated C** and **ZIR (inspected)** dumps.
- Show a failed target as one line, with the tool's full output collapsed under it.
- Run Native through Ziran's renamed tools: `zi2zx` writes LIR, the optimization report and `final.zx`, `zx2native` writes the map and ELF, and a missing tool is named. The old `zi2asm` name is not a fallback.
- Show every enabled target's tab in the Run pane as soon as a run starts. A tab still shows its last output, marked as building, and each fills in when its own build finishes instead of all of them waiting for the slowest (C, Go, WebAssembly and Native build in parallel; Native's ELF stage took the longest).
- Run a Kryon program, a `.zi` file that imports `kryon/app` and declares `main`, as a live embedded preview instead of the portable Run pane, which could only print `main`'s failure status `1`. The preview builds the file through the Kryon tool's canvas profile in an extension-owned project.
- Run a project's bundle with `ziran run --project`, so the toolchain that wrote the bundle also reads it, and name the `ziran` and `zi2zx` paths when a run fails on a ZIR version mismatch.
- Name the Native stages Source, LIR, Optimized, ZX, Assembly and Binary; Binary matches C, Go and WebAssembly.
- Inspect Native through ZIR, LIR and linked portable ZX before direct ELF lowering. Show each stage, use the current ZX CLI, recognize qualified Ziran main symbols, and retain main-first binary navigation. Keep temporary builds in extension-owned storage and verify no-libc console output with the real package toolchain.
- Merge the separate ZX and Native inspection options into Native, enabled by default. Existing `zx` target settings select Native; portable ZX bytes remain a stage within its single direct-lowering pipeline.
- Inspect every target in the Run pane: generated C with the C compiler's assembly and the binary, generated Go with `-gcflags=-S` portable assembly and the binary, WebAssembly, and the native backend's ZX instructions and disassembly; binaries open in a paged hexadecimal view.
- Explain that a file without `main` is a module to run from a program that imports it, instead of failing with a missing bundle entry.
- Resolve `kryon/<package>` imports and `Alias :: #import "…"` lines through the project import map.

- Highlight law names, quantified domains and predicates across continuation lines.

- Browse ZIR and WAT beside C and Go in the Run
  pane, with readable WebAssembly text and hexadecimal bundle views.
- Hide compiler lock files and internal directories from generated code views.

- Load generated JavaScript and WebAssembly inside the preview sandbox, refresh changed runtime files on save, and preserve empty Git configuration values lost by VSCode.

- Preview individual Kryon package examples as interactive browser apps, rebuild on source and manifest changes, and recover after build errors.

## 0.7.1

- Run portable programs as `.zx` files and show the portable file icon for `.zx`.
- Keep `.zi` for source files and `.zir` for checked intermediate modules.

## 0.7.0

- Complete the procedures, types, constants, and globals a file's program declares, with their signatures, as reported by `ziran api`.
- Show a declaration and the comment above it when hovering a name.
- Go to Definition opens the declaration of a procedure, type, constant, or global, not only of an imported module.

## 0.6.3

- Show Python, from `ziran build --target=py`, as a tab in the Run pane's generated code, with highlighting and a checkbox in `ziran.previewTargets`.

## 0.6.2

- Show the Ziran logo as the file icon for `.zi` sources, with blue and brown variants for checked `.zir` modules and `.zib` bundles, and as the extension icon.

## 0.6.1

- Show Plan 9 C as 9c, right after C++, in the generated code tabs.
- The Run pane follows the focused `.zi` file: switching files shows and runs the new one.

## 0.6.0

- Show generated code and the checked `.zir` directly under the program output in the Run pane, like the Kryon preview, instead of in a separate tab.
- Highlight C, C++, Go, Rust, Plan 9 C, and inspected `.zir` in the Run pane.

## 0.5.3

- Show a run's output in a Run pane beside the source, like the Kryon preview, and rerun it on save.

## 0.5.2

- Fix the extension failing to start in 0.5.0 and 0.5.1, which left Run, the generated code preview, checking, and import completion unavailable.

## 0.5.1

- Run any `.zi` file with a `main` procedure from the ▶ button in the editor title bar or the **▶ Run** link above `main`. Output appears in a Ziran terminal.

## 0.5.0

- Check `.zi` files on open and save, with errors in the Problems panel.
- Work with a single `.zi` file: imports resolve from its folder and Ziran's standard modules, without a Kryon project.
- Preview the C, C++, Go, Rust, and Plan 9 C generated for a file with **Ziran: Preview Generated Code**, and choose which targets it shows.
- Show the Kryon preview button only in projects with a `kryon.toml`.
- Use one `ziran.command` setting for checking, previews, and `.zir` browsing.

## 0.4.1

- Highlight `//` and `/* */` comments correctly, including apostrophes in comments.
- Use Ziran's comment syntax when toggling comments in the editor.

## 0.4.0

- Open `.zir` files as readable, searchable modules with an outline and hex view.
- Show rendered terminal frames in a canvas window beside source files.

## 0.3.1

- Show a Run Kryon button in the status bar and above Ziran source in Kryon projects.

## 0.3.0

- Preview Kryon projects beside Ziran source in VS Code.
- Reload the preview when project source or configuration changes.
- Inspect the generated C and checked `.zir` modules for the current preview.
