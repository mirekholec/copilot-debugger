# Copilot Debugger

Local developer viewer for VS Code Copilot Chat sessions.

## Contents

- [What It Is](#what-it-is)
- [Installation](#installation)
- [Troubleshooting](#troubleshooting)
- [Screenshots](#screenshots)
- [Author](#author)
- [Contribute](#contribute)
- [License](#license)

## What It Is

Copilot Debugger reads local VS Code Copilot Chat transcript and debug JSONL files and shows them in a compact web UI.

It scans local VS Code storage, normalizes sessions, and displays session metadata, turns, models, tools, agents, token usage, and estimated AI usage costs.

The app does not send your data anywhere. It reads files from your machine and serves the UI locally. It does not call GitHub, Microsoft, Copilot, or any external analytics API.

Default data sources:

- `GitHub.copilot-chat/transcripts/*.jsonl`
- `GitHub.copilot-chat/debug-logs/*/*.jsonl`

Main stack:

- React + Vite frontend in `src/`
- Node.js + Express backend in `server/`
- REST API under `/api/*`

## Installation

Requirements:

- Node.js 20.9 or newer
- VS Code with local Copilot Chat session logs

Run the published package:

```bash
npx copilot-debugger
```

Local development:

```bash
npm install
npm run dev
```

Default local URLs:

- Web UI: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4317`

Useful commands:

```bash
npm run typecheck
npm run build
npm run start
```

Optional environment variables:

- `PORT` - backend port
- `VSCODE_WORKSPACE_STORAGE_ROOT` - custom VS Code `workspaceStorage` root
- `VSCODE_COPILOT_SESSION_ROOT` - direct root for test/session data
- `SESSION_POLL_INTERVAL_MS` - fallback refresh interval

Example:

```bash
VSCODE_WORKSPACE_STORAGE_ROOT="/path/to/workspaceStorage" npm run dev
```

## Troubleshooting

- No sessions are shown: check that VS Code has Copilot Chat logs under `workspaceStorage`.
- Wrong storage location: set `VSCODE_WORKSPACE_STORAGE_ROOT` explicitly.
- Port is already used: set `PORT`, for example `PORT=4321 npm run dev`.
- Broken or incomplete data: Copilot Chat log formats are not a stable public API and may change between VS Code versions.
- TypeScript errors after changes: run `npm run typecheck` before debugging runtime behavior.

## Screenshots

<table>
	<tr>
		<td width="280"><a href="docs/cd1.png"><img src="docs/cd1.png" alt="Copilot Debugger session list" width="280" height="160"></a></td>
		<td width="280"><a href="docs/cd2.png"><img src="docs/cd2.png" alt="Copilot Debugger session detail" width="280" height="160"></a></td>
	</tr>
	<tr>
		<td width="280"><a href="docs/cd3.png"><img src="docs/cd3.png" alt="Copilot Debugger debug log detail" width="280" height="160"></a></td>
		<td width="280" height="160">Application previews are shown here.</td>
	</tr>
</table>

## Author

- Mirek Holec
- Microsoft MVP
- Web: [holec.ai](https://www.holec.ai)
- GitHub: [mirekholec](https://github.com/mirekholec)

## Contribute

Issues and pull requests are welcome. Keep changes small, focused, and tested with `npm run typecheck`.

## License

MIT. See [LICENSE](LICENSE).