## AI Agent Communication and Reasoning

- Write in Czech.
- Be as concise as possible.
- Use bullet points instead of long paragraphs.
- In progress updates, include only the status, result, or required user action.
- Do not explain self-evident code.

## Application Purpose

- The application is a local viewer for VS Code Copilot Chat sessions.
- The goal is to read local transcript/debug JSONL files.

## Architecture

- Frontend: React + Vite in `src/`.
- Backend: Node + Express in `server/`.
- Keep shared data contracts in `server/sources/SessionSource.ts` and mirror them in the frontend only when needed.
- The main data source is `VsCodeTranscriptSource`.
- The backend exposes a REST API under `/api/*`.
- The frontend communicates with the backend via relative `/api/...` requests.
- Development mode starts both the frontend and backend at the same time via `npm run dev`.

## Data Source

- The default data root is the macOS VS Code path `~/Library/Application Support/Code/User/workspaceStorage`.
- Configuration lives in `server/config.ts`.
- Support the variables `PORT`, `VSCODE_WORKSPACE_STORAGE_ROOT`, `VSCODE_COPILOT_SESSION_ROOT`, and `SESSION_POLL_INTERVAL_MS`.
- Scan transcript files at `GitHub.copilot-chat/transcripts/*.jsonl`.
- Scan debug logs at `GitHub.copilot-chat/debug-logs/*/*.jsonl`.
- Prefer `main.jsonl` for turn details.
- Expect JSONL records to have variable shapes.

## Backend Principles

- Preserve the source abstraction through `SessionSource`.
- Add new data sources as additional implementations of `SessionSource`.
- Parsing must be tolerant: skip invalid lines; do not terminate the entire scan.
- Normalize data into simple structures for the UI.
- Do not synchronously read the whole world inside a request handler.
- Keep refresh logic in the data source; endpoints should return the current snapshot.
- File watching is an enhancement; polling is the fallback.
- Store errors in the snapshot so the UI can display them.

## Frontend Principles

- The UI is a working tool, not a landing page.
- The app has a single light theme; do not add a dark theme.
- Use the design tokens (CSS variables) in `src/styles.css`; avoid hard-coded colors.
- Fonts are Geist and Geist Mono, bundled via `@fontsource-variable`; do not load fonts from a CDN.
- Use a compact layout for scanning data.
- Use icons from `lucide-react`.
- Keep filters and selection client-side as long as the data volume remains small.
- Open session details through the existing `/api/sessions/:id/turns` and `/api/sessions/:id/overview` endpoints.
- Do not add marketing copy or explanatory blocks to the application.

## Data Model

- A session is a normalized summary of one Copilot conversation.
- Take the session ID from the debug-log directory or the transcript name.
- `workspaceStorageId` is derived from the path in `workspaceStorage`.
- Read `workspaceName` from `workspace.json` when it exists.
- Compose costs from available tokens and `copilotUsageNanoAiu`.
- Store agents, tools, and models as sets and sort them in the output.

## Testing and Validation

- Run `npm run typecheck` before finishing changes.
- After larger backend changes, also run `npm run build`.
- Do not start long-running servers unnecessarily when typecheck is enough.
- Do not change the data format without updating both sides of the contract.

## Change Style

- Make small, focused changes.
- Do not add a new abstraction without a clear reason.
- Do not broadly rewrite the UI for a small change.
- Keep TypeScript strict and avoid `any` when a reasonable alternative exists.
- Do not revert or delete user changes outside the current task.