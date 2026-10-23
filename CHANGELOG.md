# Changes

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
