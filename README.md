# Kryon Language for VS Code

Syntax highlighting, brackets, comments, and indentation for `.kry` files.

## Install

Download the `.vsix` from the [latest GitHub Release](https://github.com/kryonlabs/kryon-vscode/releases/latest), then run:

```sh
code --install-extension kryon-language-*.vsix
```

You can also use **Extensions: Install from VSIX...** in VS Code. Reload the
window after installing. New `.kry` tabs will open in Kryon mode automatically.
If an existing tab still says Plain Text in the status bar, use **Change Language
Mode** and select **Kryon**.

## Build

```sh
npm ci
npm run package
```

GitHub Actions uploads a VSIX from every build. Maintainers can use the
workflow's **Run workflow** button with **Publish GitHub Release** enabled to
publish the package version as a public release.
