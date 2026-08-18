# Changelog

All notable changes to Copilot Debugger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-08-18

### Fixed

- Count only the model-visible tool-result content, preventing duplicate `content` and `detailedContent` payloads from inflating tool sizes.
- Keep initial-prompt totals historical by not adding current agent and skill catalogs when they were not persisted with the session.

### Changed

- Clearly label prompt and tool-payload figures as raw characters rather than tokens.
- Mark per-round token figures as totals across model calls and expose the latest request input count in the tooltip.

## [0.2.0] - 2026-08-12

> [!WARNING]
> **Breaking change:** Copilot Debugger now supports only the new [Copilot Agent Host](https://code.visualstudio.com/docs/agents/concepts/agent-host) data stored under `~/.copilot`. Legacy VS Code transcript and debug-log sessions are no longer supported and will not appear in the application.

### Added

- Read-only Copilot Agent Host and harness support for `~/.copilot`, including both event storage generations.
- SQLite-backed token and AI Credit totals with WAL support and schema feature detection.
- Lazy Agent Host turn, tool, skill, attachment, subagent, and compaction parsing.
- Source, client, storage paths, context inventory, and incomplete-data warnings in the session UI.
- Fixture tests for Agent Host events, SQLite usage, ID collisions, and incremental refresh behavior.
- Clickable context-window segments with the persisted source text for each section.
- Relevant argument summaries for tool calls, including files, commands, search patterns, skills, and documentation queries.
- Model and move reasoning levels in session details.
- Cached and returned tool definitions discovered through `tool_search_tool`.

### Changed

- Removed the legacy VS Code transcript/debug-log source; the application now targets the new Agent Host exclusively.
- Added session-scoped agents and skills from `agentHostCustomizations` snapshots.
- Added MCP server inventory from the Agent Host process lifecycle log.
- Session listing no longer requires parsing complete Agent Host event streams.
- Grouped cards by real user interactions while keeping internal model iterations under "Show turns".
- Excluded injected skill context from user messages and kept subagent activity separate.

## [0.1.4] - 2026-07-17

### Changed

- Store session filters only for the current browser session.
- Expanded the project documentation and npm package overview.
- Added configurable polling through `SESSION_POLL_INTERVAL_MS`.

[Unreleased]: https://github.com/mirekholec/copilot-debugger/compare/v0.2.1...HEAD
[0.2.1]: https://www.npmjs.com/package/copilot-debugger/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/copilot-debugger/v/0.2.0
[0.1.4]: https://www.npmjs.com/package/copilot-debugger/v/0.1.4