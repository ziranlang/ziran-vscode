# Changes

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
