import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { AgentHostCustomizationsReader } from './AgentHostCustomizationsReader.js';
import { AgentHostEventReader } from './AgentHostEventReader.js';
import { AgentHostProcessLogReader } from './AgentHostProcessLogReader.js';
import { AgentHostStoreReader, type AgentHostUsageRow } from './AgentHostStoreReader.js';
import { CopilotAgentHostSource } from './CopilotAgentHostSource.js';

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'agent-host');

test('event reader folds turns, tools, subagents, overview and incomplete lines', async () => {
  const reader = new AgentHostEventReader();
  const usage: AgentHostUsageRow[] = [
    {
      sessionId: 'fixture-session',
      turnIndex: 1,
      model: 'fixture-model',
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 30,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      nanoAiu: 500_000_000,
      timestamp: '2026-01-01T10:00:04.000Z'
    },
    {
      sessionId: 'fixture-session',
      turnIndex: 2,
      agentId: 'fixture-agent',
      parentToolCallId: 'tool-1',
      model: 'fixture-sub-model',
      inputTokens: 40,
      outputTokens: 10,
      cachedTokens: 5,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      nanoAiu: 100_000_000,
      timestamp: '2026-01-01T10:00:08.000Z'
    }
  ];

  const header = await reader.readHeader(path.join(fixtureRoot, 'events.jsonl'));
  const details = await reader.readDetails(path.join(fixtureRoot, 'events.jsonl'), usage);

  assert.equal(header.sessionId, 'fixture-session');
  assert.equal(header.schemaVersion, 2);
  assert.equal(header.reasoningEffort, 'high');
  assert.equal(details.turns[0].turns[0].reasoningEffort, 'high');
  assert.equal(details.turns.length, 1);
  assert.equal(details.turns[0].index, 0);
  assert.equal(details.turns[0].toolCalls.length, 1);
  assert.equal(details.turns[0].toolCalls[0].subagentTurns?.[0].model, 'fixture-sub-model');
  assert.equal(details.turns[0].hasBrowserContext, true);
  assert.equal(details.overview.skillsAvailability, 'catalog');
  assert.equal(details.overview.skills.length, 2);
  assert.equal(details.overview.agentsAvailability, 'catalog');
  assert.equal(details.overview.toolsAvailability, 'definitions');
  assert.deepEqual(details.overview.tools.map((tool) => tool.name), ['read_file']);
  assert.equal(details.overview.contextSizes?.toolsBytes, undefined);
  assert.equal(details.overview.contextSizes?.conversationChars, 'Inspect the fixture'.length);
  assert.equal(details.overview.contextContent?.conversation, 'Inspect the fixture');
  assert.equal(details.overview.contextContent?.instructions, '');
  assert.match(details.overview.contextContent?.agents ?? '', /fixture-agent/);
  assert.match(details.overview.contextContent?.skills ?? '', /fixture-skill/);
  assert.match(details.overview.contextContent?.tools ?? '', /read_file/);
  assert.match(details.overview.contextContent?.other ?? '', /browser-context\.json/);
  assert.ok((details.overview.contextSizes?.skillDefinitionsChars ?? 0) > 0);
  assert.ok((details.overview.contextSizes?.agentDefinitionsChars ?? 0) > 0);
  assert.ok((details.overview.contextSizes?.toolDefinitionsChars ?? 0) > 0);
  assert.equal(
    (details.overview.contextSizes?.systemPromptChars ?? 0)
      + (details.overview.contextSizes?.userInstructionsChars ?? 0)
      + (details.overview.contextSizes?.skillDefinitionsChars ?? 0)
      + (details.overview.contextSizes?.agentDefinitionsChars ?? 0)
      + (details.overview.contextSizes?.toolDefinitionsChars ?? 0),
    details.overview.contextSizes?.systemPromptTotalBytes
  );
  assert.deepEqual(details.tools, ['read_file']);
  assert.equal(details.overview.contextSizes?.toolDefinitionsTokens, 50);
  assert.deepEqual(details.tools, ['read_file']);
  assert.ok(details.warnings.some((warning) => warning.includes('malformed')));
  assert.ok(details.warnings.some((warning) => warning.includes('incomplete')));
});

test('event reader counts model-visible tool result content once', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-tool-results-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const events = [
    { id: 'u1', timestamp: '2026-01-01T10:00:00.000Z', type: 'user.message', data: { interactionId: 'interaction-1', content: 'Inspect results' } },
    { id: 't1', timestamp: '2026-01-01T10:00:01.000Z', type: 'tool.execution_start', data: { turnId: '0', toolCallId: 'tool-1', toolName: 'view', arguments: {} } },
    {
      id: 't2',
      timestamp: '2026-01-01T10:00:02.000Z',
      type: 'tool.execution_complete',
      data: { turnId: '0', toolCallId: 'tool-1', result: { content: 'model payload', detailedContent: 'debug trace that must not be counted' } }
    },
    { id: 't3', timestamp: '2026-01-01T10:00:03.000Z', type: 'tool.execution_start', data: { turnId: '0', toolCallId: 'tool-2', toolName: 'rg', arguments: {} } },
    {
      id: 't4',
      timestamp: '2026-01-01T10:00:04.000Z',
      type: 'tool.execution_complete',
      data: { turnId: '0', toolCallId: 'tool-2', result: { detailedContent: 'fallback payload' } }
    }
  ];
  await fs.writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  const details = await new AgentHostEventReader().readDetails(eventPath, []);

  assert.deepEqual(
    details.turns[0].toolCalls.map((tool) => tool.outputChars),
    ['model payload'.length, 'fallback payload'.length]
  );
});

test('event reader builds initial context from JSONL messages before the first assistant response', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-initial-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const systemContent = 'before<tools><available_skills><skill>A</skill></available_skills><read>Read</read></tools><custom_instruction>Keep <tools>nested text</tools></custom_instruction>after';
  const events = [
    { id: 's1', timestamp: '2026-01-01T10:00:00.000Z', type: 'system.message', data: { content: systemContent } },
    { id: 'u1', timestamp: '2026-01-01T10:00:01.000Z', type: 'user.message', data: { content: 'Original', transformedContent: 'Final user prompt' } },
    { id: 't1', timestamp: '2026-01-01T10:00:02.000Z', type: 'assistant.turn_start', data: { turnId: '0' } },
    { id: 'u2', timestamp: '2026-01-01T10:00:03.000Z', type: 'user.message', data: { content: '', transformedContent: '<system_reminder>Remember</system_reminder>' } },
    { id: 'a1', timestamp: '2026-01-01T10:00:04.000Z', type: 'assistant.message', data: { turnId: '0', content: 'Answer' } },
    { id: 'u3', timestamp: '2026-01-01T10:00:05.000Z', type: 'user.message', data: { content: 'Next round' } }
  ];
  await fs.writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  const details = await new AgentHostEventReader().readDetails(eventPath, []);
  const messages = details.overview.initialContextMessages ?? [];

  assert.deepEqual(messages.map((message) => message.type), ['system', 'user', 'user']);
  assert.equal(messages[1].content, 'Final user prompt');
  assert.equal(messages[2].content, '<system_reminder>Remember</system_reminder>');
  assert.equal(messages[0].sections?.find((section) => section.key === 'tools')?.content, '<tools><read>Read</read></tools>');
  assert.match(messages[0].sections?.find((section) => section.key === 'instructions')?.content ?? '', /<tools>nested text<\/tools>/);
  assert.equal(messages[0].sections?.reduce((sum, section) => sum + section.chars, 0), systemContent.length);
});

test('event reader groups assistant iterations under user interactions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-rounds-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const events = [
    { id: 'u1', timestamp: '2026-01-01T10:00:00.000Z', type: 'user.message', data: { interactionId: 'interaction-1', content: 'First request' } },
    { id: 's1', timestamp: '2026-01-01T10:00:01.000Z', type: 'assistant.turn_start', data: { interactionId: 'interaction-1', turnId: '0' } },
    { id: 'a1', timestamp: '2026-01-01T10:00:02.000Z', type: 'assistant.message', data: { interactionId: 'interaction-1', turnId: '0', model: 'fixture-model', outputTokens: 10 } },
    { id: 't1', timestamp: '2026-01-01T10:00:03.000Z', type: 'tool.execution_start', data: { turnId: '0', toolCallId: 'tool-1', toolName: 'read_file', arguments: {} } },
    { id: 'c1', timestamp: '2026-01-01T10:00:04.000Z', type: 'user.message', data: { interactionId: 'interaction-1', content: '<skill-context name="fixture">Injected</skill-context>' } },
    { id: 's2', timestamp: '2026-01-01T10:00:05.000Z', type: 'assistant.turn_start', data: { interactionId: 'interaction-1', turnId: '1' } },
    { id: 'a2', timestamp: '2026-01-01T10:00:06.000Z', type: 'assistant.message', data: { interactionId: 'interaction-1', turnId: '1', model: 'fixture-model', outputTokens: 20 } },
    { id: 'u2', timestamp: '2026-01-01T10:01:00.000Z', type: 'user.message', data: { interactionId: 'interaction-2', content: 'Second request' } },
    { id: 's3', timestamp: '2026-01-01T10:01:01.000Z', type: 'assistant.turn_start', data: { interactionId: 'interaction-2', turnId: '0' } },
    { id: 'a3', timestamp: '2026-01-01T10:01:02.000Z', type: 'assistant.message', data: { interactionId: 'interaction-2', turnId: '0', model: 'fixture-model', outputTokens: 30 } },
    { id: 't2', timestamp: '2026-01-01T10:01:03.000Z', type: 'tool.execution_start', data: { turnId: '0', toolCallId: 'tool-2', toolName: 'apply_patch', arguments: '*** Begin Patch\n*** Update File: /workspace/src/App.tsx\n*** End Patch' } },
    { id: 't3', timestamp: '2026-01-01T10:01:04.000Z', type: 'tool.execution_start', data: { turnId: '0', toolCallId: 'tool-3', toolName: 'problems', arguments: { filePaths: ['/workspace/src/App.tsx'] } } }
  ];
  await fs.writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const usage: AgentHostUsageRow[] = [
    { sessionId: 'fixture-session', turnIndex: 7, model: 'fixture-model', inputTokens: 100, outputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: '2026-01-01T10:00:02.000Z' },
    { sessionId: 'fixture-session', turnIndex: 7, model: 'fixture-model', inputTokens: 120, outputTokens: 20, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: '2026-01-01T10:00:06.000Z' },
    { sessionId: 'fixture-session', turnIndex: 12, model: 'fixture-model', inputTokens: 80, outputTokens: 30, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: '2026-01-01T10:01:02.000Z' }
  ];

  const details = await new AgentHostEventReader().readDetails(eventPath, usage);

  assert.equal(details.turns.length, 2);
  assert.deepEqual(details.turns.map((turn) => turn.userMessage), ['First request', 'Second request']);
  assert.deepEqual(details.turns.map((turn) => turn.turns.length), [2, 1]);
  assert.deepEqual(details.turns[0].turns[0].toolCalls.map((tool) => tool.name), ['read_file']);
  assert.deepEqual(details.turns[1].turns[0].toolCalls.map((tool) => tool.name), ['apply_patch', 'problems']);
  assert.equal(details.turns[1].turns[0].toolCalls[0].detail, 'files: workspace/src/App.tsx');
  assert.equal(details.turns[1].turns[0].toolCalls[1].detail, 'files: workspace/src/App.tsx');
});

test('event reader marks tools returned by tool search as deferred', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-deferred-tools-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const events = [
    { id: 'u1', timestamp: '2026-01-01T10:00:00.000Z', type: 'user.message', data: { content: 'Inspect the page' } },
    { id: 's1', timestamp: '2026-01-01T10:00:01.000Z', type: 'assistant.turn_start', data: { turnId: '0' } },
    { id: 't1', timestamp: '2026-01-01T10:00:02.000Z', type: 'tool.execution_start', data: { turnId: '0', toolCallId: 'search-1', toolName: 'tool_search_tool', arguments: { query: 'browser tools' } } },
    { id: 't2', timestamp: '2026-01-01T10:00:03.000Z', type: 'tool.execution_complete', data: { toolCallId: 'search-1', result: { content: '["runPlaywrightCode","readPage"]', detailedContent: '["runPlaywrightCode","readPage"]' } } },
    { id: 't3', timestamp: '2026-01-01T10:00:04.000Z', type: 'tool.execution_start', data: { turnId: '0', toolCallId: 'browser-1', toolName: 'runPlaywrightCode', arguments: { code: 'return true' } } }
  ];
  await fs.writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  const details = await new AgentHostEventReader().readDetails(eventPath, []);
  const tools = details.turns[0].toolCalls;

  assert.equal(tools.find((tool) => tool.name === 'tool_search_tool')?.deferred, false);
  assert.deepEqual(tools.find((tool) => tool.name === 'tool_search_tool')?.returnedTools, ['runPlaywrightCode', 'readPage']);
  assert.equal(tools.find((tool) => tool.name === 'runPlaywrightCode')?.deferred, true);
});

test('event reader incrementally appends and resets after truncation', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-events-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const reader = new AgentHostEventReader();
  await fs.writeFile(eventPath, '{"type":"user.message","timestamp":"2026-01-01T00:00:00.000Z","data":{"content":"first"}}\n{"type":"assistant.message"');

  const initial = await reader.readDetails(eventPath, []);
  assert.equal(initial.turns.length, 1);
  assert.ok(initial.warnings.some((warning) => warning.includes('incomplete')));

  await fs.appendFile(eventPath, ',"timestamp":"2026-01-01T00:00:01.000Z","data":{"content":"done"}}\n');
  const appended = await reader.readDetails(eventPath, []);
  assert.equal(appended.messageCount, 2);

  await fs.writeFile(eventPath, '{"type":"user.message","timestamp":"2026-01-02T00:00:00.000Z","data":{"content":"replacement"}}\n');
  const replaced = await reader.readDetails(eventPath, []);
  assert.equal(replaced.messageCount, 1);
  assert.equal(replaced.firstUserMessage, 'replacement');
});

test('store reader reads WAL-compatible catalog and aggregates usage once', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-store-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'session-store.db');
  createFixtureDatabase(databasePath);

  const snapshot = await new AgentHostStoreReader(databasePath).readSnapshot();
  const session = snapshot.sessions.get('fixture-session');

  assert.equal(snapshot.schemaVersion, 6);
  assert.equal(session?.firstUserMessage, 'Inspect the fixture');
  assert.equal(session?.turnCount, 1);
  assert.equal(session?.cost.aiCredits, 0.6);
  assert.equal(session?.cost.requestCount, 2);
  assert.deepEqual(session?.cost.models, ['fixture-model', 'fixture-sub-model']);
  assert.equal(session?.cost.perModel.find((model) => model.model === 'fixture-model')?.reasoningEffort, 'high');
  assert.equal(snapshot.usageBySession.get('fixture-session')?.[0].turnIndex, 1);
});

test('process log reader returns MCP servers initialized for the session window', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-process-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(path.join(fixtureRoot, 'process.log'), path.join(root, 'process-1.log'));

  const servers = await new AgentHostProcessLogReader(root).readMcpServers('fixture-session');

  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'docs-server');
  assert.equal(servers[0].title, 'Docs MCP');
  assert.deepEqual(servers[0].documentedTools, ['docs_search']);
});

test('customizations reader returns enabled session-scoped agents and skills', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-customizations-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDefinition = '---\nname: Fixture Agent\n---\nAgent instructions';
  const skillDefinition = '---\nname: fixture-skill\n---\nSkill instructions';
  const agentPath = path.join(root, 'fixture.agent.md');
  const skillPath = path.join(root, 'SKILL.md');
  await fs.writeFile(agentPath, agentDefinition);
  await fs.writeFile(skillPath, skillDefinition);
  await fs.writeFile(path.join(root, 'fixture-session.json'), JSON.stringify([{
    type: 'directory',
    enabled: true,
    children: [
      { type: 'agent', name: 'Fixture Agent', description: 'Agent attached to the fixture', uri: pathToFileURL(agentPath).href },
      { type: 'skill', name: 'fixture-skill', description: 'Skill attached to the fixture', uri: pathToFileURL(skillPath).href }
    ]
  }]));

  const customizations = await new AgentHostCustomizationsReader(root).read('fixture-session');

  assert.deepEqual(customizations.agents.map((agent) => agent.name), ['Fixture Agent']);
  assert.deepEqual(customizations.skills.map((skill) => skill.name), ['fixture-skill']);
  assert.equal(customizations.agents[0].sizeChars, agentDefinition.length);
  assert.equal(customizations.skills[0].sizeChars, skillDefinition.length);
  assert.ok(customizations.sourcePath?.endsWith('fixture-session.json'));
});

test('Agent Host source discovers directory and root JSONL generations lazily', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-source-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'session-state');
  const directoryRoot = path.join(stateRoot, 'fixture-session');
  await fs.mkdir(directoryRoot, { recursive: true });
  await fs.copyFile(path.join(fixtureRoot, 'events.jsonl'), path.join(directoryRoot, 'events.jsonl'));
  await fs.copyFile(path.join(fixtureRoot, 'workspace.yaml'), path.join(directoryRoot, 'workspace.yaml'));
  await fs.writeFile(path.join(stateRoot, 'root-session.jsonl'), '{"type":"session.start","timestamp":"2026-01-02T00:00:00.000Z","data":{"sessionId":"root-session","version":1}}\n{"type":"user.message","timestamp":"2026-01-02T00:00:01.000Z","data":{"content":"Root fixture"}}\n');
  await fs.writeFile(path.join(stateRoot, 'empty-session.jsonl'), '{"type":"session.start","timestamp":"2026-01-03T00:00:00.000Z","data":{"sessionId":"empty-session","version":1}}\n');
  createFixtureDatabase(path.join(root, 'session-store.db'));
  const customizationsRoot = path.join(root, 'customizations');
  await fs.mkdir(customizationsRoot);
  await fs.copyFile(path.join(fixtureRoot, 'customizations.json'), path.join(customizationsRoot, 'fixture-session.json'));
  const source = new CopilotAgentHostSource({ agentHostRoot: root, customizationsRoot, pollIntervalMs: 3_600_000 });
  context.after(() => source.stop());

  await source.start();
  const snapshot = source.listSessions();
  const fixture = source.getSession('fixture-session');

  assert.equal(snapshot.sessions.length, 2);
  assert.equal(fixture?.sourceKind, 'copilot-agent-host');
  assert.equal(fixture?.clientName, 'vscode-agent-host');
  assert.equal(fixture?.cost.aiCredits, 0.6);
  assert.equal((await source.getSessionTurns('fixture-session')).length, 1);
  assert.deepEqual((await source.getSessionOverview('fixture-session'))?.agents.map((agent) => agent.name), ['fixture-agent']);
  assert.equal(source.getSession('root-session')?.hasDetailedEvents, true);
  assert.equal(source.getSession('empty-session'), undefined);
});

test('Agent Host source keeps unpersisted customizations out of the initial prompt', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-unpersisted-customizations-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = 'unpersisted-session';
  const stateRoot = path.join(root, 'session-state');
  const customizationsRoot = path.join(root, 'customizations');
  const agentPath = path.join(root, 'live.agent.md');
  const skillPath = path.join(root, 'SKILL.md');
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.mkdir(customizationsRoot);
  await fs.writeFile(agentPath, 'Live agent definition');
  await fs.writeFile(skillPath, 'Live skill definition');
  await fs.writeFile(
    path.join(stateRoot, `${sessionId}.jsonl`),
    [
      { id: 's1', timestamp: '2026-01-01T10:00:00.000Z', type: 'session.start', data: { sessionId, version: 1 } },
      { id: 's2', timestamp: '2026-01-01T10:00:01.000Z', type: 'system.message', data: { content: '<tools><view>Read a file.</view></tools>' } },
      { id: 'u1', timestamp: '2026-01-01T10:00:02.000Z', type: 'user.message', data: { content: 'Inspect the session' } }
    ].map((event) => JSON.stringify(event)).join('\n') + '\n'
  );
  await fs.writeFile(path.join(customizationsRoot, `${sessionId}.json`), JSON.stringify([{
    type: 'directory',
    enabled: true,
    children: [
      { type: 'agent', name: 'Live Agent', uri: pathToFileURL(agentPath).href },
      { type: 'skill', name: 'live-skill', uri: pathToFileURL(skillPath).href }
    ]
  }]));
  const source = new CopilotAgentHostSource({ agentHostRoot: root, customizationsRoot, pollIntervalMs: 3_600_000 });
  context.after(() => source.stop());

  await source.start();
  const overview = await source.getSessionOverview(sessionId);

  assert.deepEqual(overview?.agents.map((agent) => agent.name), ['Live Agent']);
  assert.deepEqual(overview?.skills.map((skill) => skill.name), ['live-skill']);
  assert.equal(overview?.contextSizes?.agentDefinitionsChars, 0);
  assert.equal(overview?.contextSizes?.skillDefinitionsChars, 0);
  assert.equal(overview?.contextContent?.agents, '');
  assert.equal(overview?.contextContent?.skills, '');
});

function createFixtureDatabase(databasePath: string): void {
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (6);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT, host_type TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT, timestamp TEXT);
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, turn_index INTEGER, agent_id TEXT, parent_tool_call_id TEXT,
      model TEXT NOT NULL, reasoning_effort TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, total_nano_aiu INTEGER, created_at TEXT
    );
    INSERT INTO sessions VALUES ('fixture-session', '/fixture/workspace', 'owner/repository', 'feature/test', 'Inspect the fixture', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:12.000Z', 'vscode-agent-host');
    INSERT INTO turns VALUES (1, 'fixture-session', 1, 'Inspect the fixture', 'Done', '2026-01-01T10:00:04.000Z');
    INSERT INTO assistant_usage_events VALUES (1, 'fixture-session', 1, NULL, NULL, 'fixture-model', 'high', 100, 20, 30, 0, 0, 500000000, '2026-01-01T10:00:04.000Z');
    INSERT INTO assistant_usage_events VALUES (2, 'fixture-session', 1, 'fixture-agent', 'tool-1', 'fixture-sub-model', 'low', 40, 10, 5, 0, 0, 100000000, '2026-01-01T10:00:08.000Z');
  `);
  database.close();
}
