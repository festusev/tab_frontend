# Repository Guidelines

## Project Structure & Module Organization
- `src/main.js` — Electron main process (window, menus, IPC).
- `src/preload.js` — secure bridge (`contextIsolation: true`) exposing `window.api`.
- `src/renderer/` — UI (HTML/CSS/JS) for the nano‑like editor.
- `starter_code/` — Python starter files auto‑copied into `problems/<assistant>/`.
- `problems/` — problem workspaces and configs; `run_testcases.py` validates solutions.
- Config: `assistants.json`, `active_assistants.txt` select/model assistants.

## Build, Test, and Development Commands
- Setup: `npm install` — install Electron dev deps.
- Run app: `npm start` — launches Electron (`electron .`).
- Troubleshoot: `DEBUG=* npm start` — verbose logs to terminal.
- Problem tests (Python):
  - Example: `python3 run_testcases.py --merge --solution problems/<assistant>/merge.py`.
  - Custom cases: `--cases path/to/cases.json`.

## Coding Style & Naming Conventions
- JavaScript: 4‑space indent, semicolons required, prefer single quotes.
- Naming: camelCase for variables/functions, PascalCase for classes.
- Files: `kebab-case` for assets and plain scripts; keep modules small and focused.
- Security: keep `nodeIntegration: false`; extend renderer via `preload.js` only.

## Testing Guidelines
- No JS unit suite yet; validate manually via `npm start` and console.
- For problems, use `run_testcases.py` with the correct mode flag (`--merge`, `--vector`, etc.). Aim to keep solutions pure and deterministic.
- Add minimal repros for UI bugs (steps, expected vs. actual) in PRs.

## Commit & Pull Request Guidelines
- Commits: short, imperative summaries (e.g., “Fix completion indentation”); group related changes.
- PRs: clear description, scope, and rationale; link issues if applicable. Include:
  - Screenshots/GIFs for UI changes.
  - Steps to validate (`npm start`, files touched, problem/test mode if relevant).

## Configuration & Security Tips
- Environment: `COMPLETIONS_URL` and/or `COMPLETIONS_PORT` override the completions server (defaults to `http://localhost:9600`).
- Paths resolved relative to app root; avoid absolute paths in renderer code.
- Do not expose new Node APIs to the renderer without a `preload` wrapper and IPC validation.

