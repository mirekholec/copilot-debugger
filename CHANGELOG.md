# Changelog

All notable changes to Copilot Debugger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-10

### Added

- Read-only Copilot Agent Host support for `~/.copilot`, including both event storage generations.
- SQLite-backed token and AI Credit totals with WAL support and schema feature detection.
- Lazy Agent Host turn, tool, skill, attachment, subagent, and compaction parsing.
- Source, client, storage paths, context inventory, and incomplete-data warnings in the session UI.
- Fixture tests for Agent Host events, SQLite usage, ID collisions, and incremental refresh behavior.
- Clickable context-window segments with the persisted source text for each section.
- Relevant argument summaries for tool calls, including files, commands, search patterns, skills, and documentation queries.

### Changed

- Removed the legacy VS Code transcript/debug-log source; the application now targets Agent Host only.
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

[Unreleased]: https://github.com/mirekholec/copilot-debugger/compare/v0.2.0...HEAD
[0.2.0]: https://www.npmjs.com/package/copilot-debugger/v/0.2.0
[0.1.4]: https://www.npmjs.com/package/copilot-debugger/v/0.1.4