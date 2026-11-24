# Changelog

All notable changes to Copilot Debugger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-24

### Added

- Support context compaction. After a compaction, the current context window shows the compaction summary and the messages recorded after it instead of the messages that were removed.
- Show the context window before the latest compaction above the current one, with the compaction time, trigger, and number of removed messages.

### Changed

- Take the current token total from the latest real model request. Local estimates from shutdown and compaction snapshots are used only when no later request exists and are marked with `≈`.
- Draw the initial, pre-compaction, and current context bars on one shared scale.

### Fixed

- Stop the shutdown estimate, which can count the full tool catalog, from replacing the real token total of the last request.
- Ignore the compaction summarizer request when determining the current context size.

## [1.0.0] - 2026-11-21

### Added

- Compare the initial context with the latest recorded context on the session detail page. Both bars show character counts, and the current panel reports the persisted token total when available.
- Open context sections inline with formatted, syntax-highlighted XML.
- Reconstruct stored conversation turns from SQLite when a session has no event stream.

### Changed

- Simplify the interface around the session list and detail view. Display costs in reported AI Credits.

### Fixed

- Use the latest system prompt for the current context after a session resumes and include initial runtime instruction updates in both views.
- Hide sessions that contain only harness commands when the recorded data confirms there was no model activity.

## [0.2.2] - 2026-08-19

### Added

- Reconstruct the initial context window from the persisted system and transformed user messages recorded before the first assistant response.
- Open each context message or section directly from the context-window bar and legend.

### Changed

- Split system messages into tools, skills, custom instructions, and remaining system content while preserving nested definitions.
- Present the initial context in recorded message order with clearer context-window labels.

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

[Unreleased]: https://github.com/mirekholec/copilot-debugger/compare/v1.1.0...HEAD
[1.1.0]: https://www.npmjs.com/package/copilot-debugger/v/1.1.0
[1.0.0]: https://www.npmjs.com/package/copilot-debugger/v/1.0.0
[0.2.2]: https://www.npmjs.com/package/copilot-debugger/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/copilot-debugger/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/copilot-debugger/v/0.2.0
[0.1.4]: https://www.npmjs.com/package/copilot-debugger/v/0.1.4
