# Changes

## Unreleased

- Run a Kryon program, a `.zi` file that imports `kryon/app` and declares `main`, as a live embedded preview instead of the portable Run pane, which could only print `main`'s failure status `1`. The preview builds the file through the Kryon tool's canvas profile in an extension-owned project.
- Add **Inspect Targets** (`Ziran: Inspect Targets`) to open the Run pane's C, Go, WebAssembly and Native views for a Kryon program; the pane shows a note instead of running the program on the portable runtime.
- Add **Open in New Window** to the Kryon preview: it builds the C-generated executable and runs it as one owned process that opens the program's real window, shows its stdout, stderr and exit status separately, replaces it when reopened, and ends it when the preview or VS Code closes.
- Run a project's bundle with `ziran run --project`, so the toolchain that wrote the bundle also reads it, and name the `ziran` and `zi2zx` paths when a run fails on a ZIR version mismatch.
- Name the Native stages Source, ZIR, LIR, Optimized, ZX, Assembly and Binary. ZIR is always type-checked, so the "Checked" prefix is gone, and Binary matches C, Go and WebAssembly; it still shows the ELF lowered from ZX with its ELF header toggle.
- Inspect Native through ZIR, LIR and linked portable ZX before direct ELF lowering. Show each stage, use the current ZX CLI, recognize qualified Ziran main symbols, and retain main-first binary navigation. Keep temporary builds in extension-owned storage and verify no-libc console output with the real package toolchain.
- Merge the separate ZX and Native inspection options into Native, enabled by default. Existing `zx` target settings select Native; portable ZX bytes remain a stage within its single direct-lowering pipeline.
- Start binary inspection at `main` or the principal ELF, WebAssembly or ZX instruction region while retaining real file offsets, with a full-file toggle and offset navigation for hidden headers.
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
