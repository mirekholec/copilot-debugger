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
  assert.match(
    details.overview.initialContextMessages?.[0].sections?.find((section) => section.key === 'agents')?.content ?? '',
    /fixture-agent/
  );
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

test('event reader keeps the latest context snapshot for the current context bar', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-context-snapshots-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const events = [
    { id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', type: 'session.compaction_start', data: { systemTokens: 100, conversationTokens: 200, toolDefinitionsTokens: 50 } },
    {
      id: 's1',
      timestamp: '2026-01-01T10:00:10.000Z',
      type: 'session.shutdown',
      data: { currentTokens: 900, systemTokens: 110, conversationTokens: 300, toolDefinitionsTokens: 490, model: 'latest-model' }
    }
  ];
  await fs.writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  const details = await new AgentHostEventReader().readDetails(eventPath, []);

  assert.deepEqual(details.overview.finalContext, {
    currentTokens: 900,
    systemTokens: 110,
    conversationTokens: 300,
    toolDefinitionsTokens: 490,
    model: 'latest-model',
    capturedAt: '2026-01-01T10:00:10.000Z',
    source: 'event'
  });
  assert.equal(details.overview.contextSizes?.systemTokens, 100);
  assert.equal(details.overview.contextSizes?.conversationTokens, 200);
  assert.equal(details.overview.contextSizes?.toolDefinitionsTokens, 50);
});

test('event reader falls back to the latest main usage request for current context', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-usage-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  await fs.writeFile(eventPath, JSON.stringify({
    type: 'user.message',
    timestamp: '2026-01-01T10:00:00.000Z',
    data: { content: 'Inspect usage' }
  }) + '\n');

  const details = await new AgentHostEventReader().readDetails(eventPath, [
    { sessionId: 'fixture-session', model: 'first-model', inputTokens: 100, outputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: '2026-01-01T10:00:01.000Z' },
    { sessionId: 'fixture-session', model: 'latest-model', inputTokens: 200, outputTokens: 20, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: '2026-01-01T10:00:02.000Z' },
    { sessionId: 'fixture-session', agentId: 'subagent', parentToolCallId: 'tool-1', model: 'sub-model', inputTokens: 900, outputTokens: 30, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: '2026-01-01T10:00:03.000Z' }
  ]);

  assert.deepEqual(details.overview.finalContext, {
    currentTokens: 200,
    model: 'latest-model',
    capturedAt: '2026-01-01T10:00:02.000Z',
    source: 'usage'
  });
});

test('current context prefers the latest real request over a later shutdown estimate', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-shutdown-estimate-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  await fs.writeFile(eventPath, JSON.stringify({
    type: 'session.shutdown',
    timestamp: '2026-01-01T10:00:05.000Z',
    data: { currentTokens: 9000, toolDefinitionsTokens: 8000 }
  }) + '\n');

  const details = await new AgentHostEventReader().readDetails(eventPath, [
    { sessionId: 'fixture-session', model: 'fixture-model', inputTokens: 300, outputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: '2026-01-01T10:00:01.000Z' }
  ]);

  assert.equal(details.overview.finalContext?.currentTokens, 300);
  assert.equal(details.overview.finalContext?.source, 'usage');
});

test('current context reflects the latest compaction and keeps the window before it', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-compaction-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const timestamp = (second: number) => `2026-01-01T10:00:${String(second).padStart(2, '0')}.000Z`;
  const events = [
    { type: 'system.message', data: { content: 'System prompt' } },
    { type: 'user.message', data: { content: 'First question' } },
    { type: 'tool.execution_start', data: { toolCallId: 'tool-1', toolName: 'view', arguments: 'a.ts' } },
    { type: 'tool.execution_complete', data: { toolCallId: 'tool-1', result: { content: 'Compacted tool result' } } },
    { type: 'assistant.message', data: { content: 'First answer' } },
    { type: 'session.compaction_start', data: { compactionAttemptId: 'attempt-1', currentTokens: 500, trigger: 'manual' } },
    {
      type: 'session.compaction_complete',
      data: {
        compactionAttemptId: 'attempt-1', success: true, outcome: 'applied', trigger: 'manual', messagesRemoved: 3, behaviorModelId: 'fixture-model',
        postCompactionTokens: 200, systemTokens: 100, conversationTokens: 20, toolDefinitionsTokens: 80, summaryContent: 'Summary of the first question'
      }
    },
    { type: 'session.shutdown', data: { currentTokens: 9000 } }
  ];
  await fs.writeFile(eventPath, events.map((event, index) => JSON.stringify({ ...event, timestamp: timestamp(index) })).join('\n') + '\n');
  const usageRow = (inputTokens: number, second: number, initiator?: string): AgentHostUsageRow => ({
    sessionId: 'fixture-session', model: 'fixture-model', initiator, inputTokens, outputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: timestamp(second)
  });
  const reader = new AgentHostEventReader();

  const compacted = await reader.readDetails(eventPath, [usageRow(450, 2), usageRow(480, 4), usageRow(700, 6, 'compaction')]);
  assert.deepEqual(compacted.overview.finalContext, {
    currentTokens: 200,
    systemTokens: 100,
    conversationTokens: 20,
    toolDefinitionsTokens: 80,
    model: 'fixture-model',
    capturedAt: timestamp(6),
    source: 'compaction'
  });
  const current = compacted.overview.currentContextDetails?.find(({ key }) => key === 'conversation');
  assert.deepEqual(current?.entries?.map(({ kind, start, end }) => [kind, current.content.slice(start, end)]), [
    ['summary', 'Summary of the first question']
  ]);

  const compaction = compacted.overview.lastCompaction;
  assert.equal(compaction?.startedAt, timestamp(5));
  assert.equal(compaction?.completedAt, timestamp(6));
  assert.equal(compaction?.trigger, 'manual');
  assert.equal(compaction?.messagesRemoved, 3);
  assert.equal(compaction?.before?.currentTokens, 480);
  assert.equal(compaction?.before?.source, 'usage');
  const before = compaction?.beforeDetails?.find(({ key }) => key === 'conversation');
  assert.deepEqual(before?.entries?.map(({ kind }) => kind), ['user', 'tool-call', 'tool-result', 'assistant']);
  assert.doesNotMatch(before?.content ?? '', /Summary of the first question/);

  await fs.appendFile(eventPath, [
    { type: 'user.message', data: { content: 'Second question' } },
    { type: 'session.usage_record', data: {} }
  ].map((event, index) => JSON.stringify({ ...event, timestamp: timestamp(8 + index) })).join('\n') + '\n');
  const continued = await reader.readDetails(eventPath, [usageRow(450, 2), usageRow(480, 4), usageRow(700, 6, 'compaction'), usageRow(260, 9)]);
  assert.equal(continued.overview.finalContext?.currentTokens, 260);
  assert.equal(continued.overview.finalContext?.source, 'usage');
  const next = continued.overview.currentContextDetails?.find(({ key }) => key === 'conversation');
  assert.deepEqual(next?.entries?.map(({ kind }) => kind), ['summary', 'user']);
  assert.doesNotMatch(next?.content ?? '', /Compacted tool result/);
});

test('current context shows recorded tool discovery and excludes later tool results', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-current-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const timestamp = (second: number) => `2026-01-01T10:00:0${second}.000Z`;
  const events = [
    { type: 'system.message', data: { content: '<available_skills><skill>A</skill></available_skills>System prompt<agents><agent>B</agent></agents><tools><read>Read</read></tools><custom_instruction>Initial instruction</custom_instruction>' } },
    { type: 'instruction.update', data: { name: 'sandbox-guidance', content: 'Recorded instruction' } },
    { type: 'tool.execution_start', data: { toolCallId: 'search', toolName: 'tool_search_tool' } },
    { type: 'tool.execution_complete', data: { toolCallId: 'search', result: { content: 'Found 1 matching tool(s): doist-todoist-ai-find-tasks' } } },
    { type: 'tool.execution_start', data: { toolCallId: 'todoist', toolName: 'doist-todoist-ai-find-tasks' } },
    { type: 'session.usage_record', data: { usage: { availableToolCount: 238 } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'todoist', result: { content: 'Result after snapshot' } } }
  ];
  await fs.writeFile(eventPath, events.map((event, index) => JSON.stringify({ ...event, timestamp: timestamp(index) })).join('\n') + '\n');
  const details = await new AgentHostEventReader().readDetails(eventPath, [
    { sessionId: 'fixture-session', model: 'fixture-model', inputTokens: 100, outputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, nanoAiu: 0, timestamp: timestamp(5) }
  ]);
  const sections = details.overview.currentContextDetails;

  assert.deepEqual(sections?.map((section) => section.key), ['tools', 'system', 'agents', 'skills', 'instructions', 'conversation']);
  assert.equal(sections?.find((section) => section.key === 'system')?.content, 'System prompt');
  assert.match(sections?.find((section) => section.key === 'agents')?.content ?? '', /<agent>B<\/agent>/);
  assert.match(sections?.find((section) => section.key === 'skills')?.content ?? '', /<skill>A<\/skill>/);
  assert.match(sections?.find((section) => section.key === 'instructions')?.content ?? '', /Initial instruction[\s\S]*Recorded instruction/);
  assert.match(sections?.find((section) => section.key === 'tools')?.content ?? '', /238[\s\S]*doist-todoist-ai-find-tasks/);
  const conversation = sections?.find((section) => section.key === 'conversation');
  assert.ok(conversation);
  assert.match(conversation.content, /doist-todoist-ai-find-tasks · call/);
  assert.doesNotMatch(conversation.content, /Result after snapshot/);
  assert.deepEqual(conversation.entries?.map(({ kind, toolName, start, end }) =>
    [kind, toolName, conversation.content.slice(start, end)]
  ), [
    ['tool-call', 'tool_search_tool', '""'],
    ['tool-result', 'tool_search_tool', 'Found 1 matching tool(s): doist-todoist-ai-find-tasks'],
    ['tool-call', 'doist-todoist-ai-find-tasks', '""']
  ]);
  assert.equal(details.turns[0].toolCalls.find((tool) => tool.name === 'doist-todoist-ai-find-tasks')?.deferred, true);
});

test('current context uses the rebuilt prompt after resume and both views include initial runtime instructions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-resumed-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'events.jsonl');
  const userMessage = 'User message 📎\n\nAssistant · 2026-01-01T10:00:00.000Z\nQuoted header';
  const attachments = [{ name: 'notes.txt' }];
  const events = [
    { type: 'instruction.update', data: { name: 'runtime', content: 'Initial runtime instruction', postInitial: false } },
    { type: 'system.message', data: { content: 'System prompt<tools><read/></tools><available_skills><skill>A</skill></available_skills><custom_instruction>Common instruction</custom_instruction>' } },
    { type: 'user.message', data: { content: userMessage, attachments } },
    { type: 'assistant.message', data: { content: 'First answer' } },
    { type: 'session.resume', data: {} },
    { type: 'system.message', data: { content: 'System prompt<tools><read/></tools><available_skills><skill>B</skill></available_skills><custom_instruction>Common instruction</custom_instruction><custom_instruction>New instruction</custom_instruction>' } },
    { type: 'instruction.update', data: { name: 'later', content: 'Later runtime instruction', postInitial: true } },
    { type: 'session.shutdown', data: { currentTokens: 100 } },
    { type: 'system.message', data: { content: 'Prompt logged after snapshot' } }
  ];
  await fs.writeFile(eventPath, events.map((event, index) =>
    JSON.stringify({ ...event, timestamp: `2026-01-01T10:00:0${index}.000Z` })
  ).join('\n') + '\n');

  const { overview } = await new AgentHostEventReader().readDetails(eventPath, []);
  const initial = overview.initialContextMessages?.[0];
  assert.equal(initial?.sections?.reduce((sum, section) => sum + section.chars, 0), initial?.chars);
  const initialInstructions = initial?.sections?.find(({ key }) => key === 'instructions')?.content;
  assert.equal(initialInstructions, '<custom_instruction>Common instruction</custom_instruction>\n\nInstruction update: runtime\nInitial runtime instruction');

  const current = Object.fromEntries((overview.currentContextDetails ?? []).map(({ key, content }) => [key, content]));
  assert.equal(current.system, 'System prompt');
  assert.equal(current.tools, '<tools><read/></tools>');
  assert.equal(current.skills, '<available_skills><skill>B</skill></available_skills>');
  assert.equal(current.instructions, '<custom_instruction>Common instruction</custom_instruction><custom_instruction>New instruction</custom_instruction>\n\nInstruction update: runtime\nInitial runtime instruction\n\nInstruction update: later\nLater runtime instruction');
  assert.match(current.conversation, /First answer/);
  const entries = overview.currentContextDetails?.find(({ key }) => key === 'conversation')?.entries;
  assert.deepEqual(entries?.map(({ kind, start, end }) => [kind, current.conversation.slice(start, end)]), [
    ['user', userMessage],
    ['attachments', JSON.stringify(attachments, null, 2)],
    ['assistant', 'First answer']
  ]);
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
  assert.equal(snapshot.turnsBySession.get('fixture-session')?.[0].userMessage, 'Inspect the fixture');
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

test('customizations reader returns model-invokable session-scoped agents and skills', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-customizations-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentDefinition = '---\nname: Fixture Agent\ndisable-model-invocation: false\n---\nAgent instructions';
  const implicitAgentDefinition = '---\nname: Implicit Agent\n---\nImplicit agent instructions';
  const disabledAgentDefinition = '---\nname: Disabled Agent\ndisable-model-invocation: true\n---\nDisabled agent instructions';
  const recoveredAgentDefinition = '---\nname: Recovered Agent\n---\nRecovered agent instructions';
  const recoveredDisabledAgentDefinition = '---\nname: Recovered Disabled Agent\ndisable-model-invocation: true\n---\nRecovered disabled agent instructions';
  const skillDefinition = '---\nname: fixture-skill\n---\nSkill instructions';
  const agentPath = path.join(root, 'fixture.agent.md');
  const implicitAgentPath = path.join(root, 'implicit.agent.md');
  const disabledAgentPath = path.join(root, 'disabled.agent.md');
  const renamedAgentsPath = path.join(root, 'renamed-agents');
  const recoveredAgentPath = path.join(renamedAgentsPath, 'recovered.agent.md');
  const recoveredDisabledAgentPath = path.join(renamedAgentsPath, 'recovered-disabled.agent.md');
  const skillPath = path.join(root, 'SKILL.md');
  await fs.writeFile(agentPath, agentDefinition);
  await fs.writeFile(implicitAgentPath, implicitAgentDefinition);
  await fs.writeFile(disabledAgentPath, disabledAgentDefinition);
  await fs.mkdir(renamedAgentsPath);
  await fs.writeFile(recoveredAgentPath, recoveredAgentDefinition);
  await fs.writeFile(recoveredDisabledAgentPath, recoveredDisabledAgentDefinition);
  await fs.writeFile(skillPath, skillDefinition);
  await fs.writeFile(path.join(root, 'fixture-session.json'), JSON.stringify([
    {
      type: 'directory',
      enabled: true,
      children: [
        { type: 'agent', name: 'Fixture Agent', description: 'Agent attached to the fixture', uri: pathToFileURL(agentPath).href },
        { type: 'agent', name: 'Implicit Agent', description: 'Uses the default model-invocation setting', uri: pathToFileURL(implicitAgentPath).href },
        { type: 'agent', name: 'Disabled Agent', description: 'Must not be listed', uri: pathToFileURL(disabledAgentPath).href },
        { type: 'skill', name: 'fixture-skill', description: 'Skill attached to the fixture', uri: pathToFileURL(skillPath).href }
      ]
    },
    {
      type: 'directory',
      enabled: true,
      uri: pathToFileURL(renamedAgentsPath).href,
      children: [
        { type: 'agent', name: 'Recovered Agent', uri: pathToFileURL(path.join(renamedAgentsPath, 'old-recovered.agent.md')).href },
        { type: 'agent', name: 'Recovered Disabled Agent', uri: pathToFileURL(path.join(renamedAgentsPath, 'old-recovered-disabled.agent.md')).href }
      ]
    }
  ]));

  const customizations = await new AgentHostCustomizationsReader(root).read('fixture-session');

  assert.deepEqual(customizations.agents.map((agent) => agent.name), ['Fixture Agent', 'Implicit Agent', 'Recovered Agent']);
  assert.deepEqual(customizations.skills.map((skill) => skill.name), ['fixture-skill']);
  assert.equal(customizations.agents.find((agent) => agent.name === 'Fixture Agent')?.path, agentPath);
  assert.equal(customizations.agents.find((agent) => agent.name === 'Fixture Agent')?.sizeChars, agentDefinition.length);
  assert.equal(customizations.agents.find((agent) => agent.name === 'Recovered Agent')?.path, recoveredAgentPath);
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
  assert.equal(fixture?.title, 'Fixture title');
  assert.equal(fixture?.cost.aiCredits, 0.6);
  assert.equal((await source.getSessionTurns('fixture-session')).length, 1);
  assert.deepEqual((await source.getSessionOverview('fixture-session'))?.agents.map((agent) => agent.name), ['fixture-agent']);
  assert.equal(source.getSession('root-session')?.hasDetailedEvents, true);
  assert.equal(source.getSession('empty-session'), undefined);
});

test('Agent Host source hides harness-only sessions and keeps model calls without credits', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-harness-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'session-state');
  const databasePath = path.join(root, 'session-store.db');
  await fs.mkdir(stateRoot, { recursive: true });
  createFixtureDatabase(databasePath);

  const database = new Database(databasePath);
  try {
    database.exec(`
      INSERT INTO sessions (id, summary, host_type) VALUES ('env-catalog', '/env', 'vscode-agent-host');
      INSERT INTO sessions (id, summary, host_type) VALUES ('zero-credits', '/env', 'vscode-agent-host');
      INSERT INTO assistant_usage_events (id, session_id, model, total_nano_aiu) VALUES (3, 'zero-credits', 'fixture-model', 0);
    `);
  } finally {
    database.close();
  }

  const workspaceOnly = path.join(stateRoot, 'env-workspace');
  await fs.mkdir(workspaceOnly);
  await fs.writeFile(path.join(workspaceOnly, 'workspace.yaml'), 'summary: /env\nclient_name: vscode-agent-host\n');

  const command = { type: 'user.message', data: { content: '/env' } };
  for (const [id, events] of [
    ['local-command', [command, { type: 'assistant.turn_start' }, { type: 'assistant.turn_end' }]],
    ['logged-model-call', [command, { type: 'model.model_call_started' }]],
    ['legacy-response', [command, { type: 'assistant.message' }]],
    ['mixed-prompts', [command, { type: 'user.message', data: { content: 'Explain this workspace' } }]]
  ] as const) {
    await fs.writeFile(path.join(stateRoot, `${id}.jsonl`), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
  await fs.writeFile(path.join(stateRoot, 'incomplete-log.jsonl'), JSON.stringify(command) + '\n{"type":');

  const source = new CopilotAgentHostSource({ agentHostRoot: root, pollIntervalMs: 3_600_000 });
  context.after(() => source.stop());
  await source.start();

  assert.deepEqual(source.listSessions().sessions.map((session) => session.id).sort(), [
    'fixture-session', 'incomplete-log', 'legacy-response', 'logged-model-call', 'mixed-prompts', 'zero-credits'
  ]);
  assert.equal(source.getSession('zero-credits')?.cost.aiCredits, 0);
});

test('Agent Host source reconstructs stored turns when the event stream is unavailable', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-store-only-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'session-state'), { recursive: true });
  createFixtureDatabase(path.join(root, 'session-store.db'));

  const source = new CopilotAgentHostSource({ agentHostRoot: root, pollIntervalMs: 3_600_000 });
  context.after(() => source.stop());

  await source.start();
  const turns = await source.getSessionTurns('fixture-session');
  const overview = await source.getSessionOverview('fixture-session');

  assert.equal(source.getSession('fixture-session')?.hasDetailedEvents, false);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].userMessage, 'Inspect the fixture');
  assert.equal(turns[0].turns.length, 2);
  assert.equal(turns[0].turns[0].inputTokens, 100);
  assert.equal(overview?.finalContext?.currentTokens, 100);
  assert.equal(overview?.finalContext?.source, 'usage');
});

test('Agent Host source adds model-invokable customizations to the initial context', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-debugger-unpersisted-customizations-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = 'unpersisted-session';
  const stateRoot = path.join(root, 'session-state');
  const customizationsRoot = path.join(root, 'customizations');
  const agentPath = path.join(root, 'live.agent.md');
  const skillPath = path.join(root, 'SKILL.md');
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.mkdir(customizationsRoot);
  await fs.writeFile(agentPath, '---\nname: Live Agent\ndescription: Live agent description\ndisable-model-invocation: false\n---\nLive agent definition');
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
  assert.ok((overview?.contextSizes?.agentDefinitionsChars ?? 0) > 0);
  assert.equal(overview?.contextSizes?.skillDefinitionsChars, 0);
  assert.match(overview?.contextContent?.agents ?? '', /<name>Live Agent<\/name>/);
  assert.match(overview?.contextContent?.agents ?? '', /<path>.*live\.agent\.md<\/path>/);
  assert.equal(overview?.contextContent?.skills, '');
  const agentSection = overview?.initialContextMessages?.find((message) => message.type === 'system')
    ?.sections?.find((section) => section.key === 'agents');
  assert.equal(agentSection?.content, overview?.contextContent?.agents);
  assert.equal(agentSection?.chars, overview?.contextSizes?.agentDefinitionsChars);
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
