import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentHostUsageRow } from './AgentHostStoreReader.js';
import type { AgentInfo, AgentTurnInfo, AttachmentInfo, InstructionInfo, SessionOverview, SkillInfo, ToolCallInfo, ToolInfo, TurnInfo } from './SessionSource.js';

const HEADER_LIMIT_BYTES = 256 * 1024;
const TEXT_LIMIT = 20_000;
const NON_TOOL_CONTEXT_BLOCKS = new Set([
  'available_skills',
  'code_search_tools',
  'example',
  'examples_for_fetch_documentation',
  'gh_cli_preference',
  'shell_security',
  'sql'
]);

interface AgentHostEvent {
  id?: string;
  parentId?: string;
  timestamp?: string;
  type?: string;
  data: Record<string, unknown>;
  order: number;
}

interface EventCacheEntry {
  inode: number;
  size: number;
  mtimeMs: number;
  events: AgentHostEvent[];
  partialLine: string;
}

interface HeaderCacheEntry {
  size: number;
  mtimeMs: number;
  header: AgentHostEventHeader;
}

export interface AgentHostEventHeader {
  sessionId?: string;
  producer?: string;
  copilotVersion?: string;
  startTime?: string;
  updatedAt?: string;
  selectedModel?: string;
  reasoningEffort?: string;
  cwd?: string;
  repository?: string;
  branch?: string;
  schemaVersion?: number;
  firstUserMessage?: string;
  clientName?: string;
}

export interface AgentHostEventDetails {
  turns: TurnInfo[];
  overview: SessionOverview;
  tools: string[];
  agents: string[];
  messageCount: number;
  userTurnCount: number;
  firstUserMessage?: string;
  warnings: string[];
  instructionBlocks: InstructionBlock[];
}

interface InstructionBlock extends InstructionInfo {
  content: string;
  sourceText: string;
}

interface MutableTool {
  id: string;
  name: string;
  turnId?: string;
  detail?: string;
  deferred?: boolean;
  returnedTools?: string[];
  inputChars: number;
  outputChars: number;
  subagentName?: string;
  subagentTurns?: AgentTurnInfo[];
}

interface MutableTurn {
  index: number;
  eventTurnId?: string;
  interactionId?: string;
  userMessage?: string;
  timestamp: string;
  models: Set<string>;
  assistantMessages: Array<{ turnId?: string; model?: string; reasoningEffort?: string; outputTokens: number; timestamp: string }>;
  tools: MutableTool[];
  toolIds: Set<string>;
  usage: AgentHostUsageRow[];
  hasBrowserContext: boolean;
}

export class AgentHostEventReader {
  private readonly cache = new Map<string, EventCacheEntry>();
  private readonly headerCache = new Map<string, HeaderCacheEntry>();

  async readHeader(filePath: string): Promise<AgentHostEventHeader> {
    let file: fs.FileHandle | undefined;
    try {
      file = await fs.open(filePath, 'r');
      const stats = await file.stat();
      const cached = this.headerCache.get(filePath);
      if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.header;
      const length = Math.min(stats.size, HEADER_LIMIT_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, 0);
      const lines = buffer.toString('utf8').split(/\r?\n/);
      const header: AgentHostEventHeader = { updatedAt: stats.mtime.toISOString() };
      for (const line of lines) {
        const event = parseEvent(line, 0);
        if (!event) continue;
        consumeHeaderEvent(header, event);
      }
      this.headerCache.set(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, header });
      return header;
    } catch {
      return {};
    } finally {
      await file?.close();
    }
  }

  async readDetails(filePath: string, usage: AgentHostUsageRow[]): Promise<AgentHostEventDetails> {
    const { events, warnings } = await this.readEvents(filePath);
    return foldEvents(events, usage, warnings);
  }

  isCached(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  private async readEvents(filePath: string): Promise<{ events: AgentHostEvent[]; warnings: string[] }> {
    const stats = await fs.stat(filePath);
    const cached = this.cache.get(filePath);
    if (cached && cached.inode === stats.ino && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      return { events: cached.events, warnings: [] };
    }

    const canAppend = cached && cached.inode === stats.ino && stats.size >= cached.size;
    const events = canAppend ? [...cached.events] : [];
    const start = canAppend ? cached.size : 0;
    let buffer = canAppend ? cached.partialLine : '';
    let malformedLines = 0;
    let order = events.length;
    const stream = createReadStream(filePath, { encoding: 'utf8', start });

    for await (const chunk of stream) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseEvent(line, order);
        if (event) {
          events.push(event);
          order += 1;
        } else {
          malformedLines += 1;
        }
      }
    }

    this.cache.set(filePath, {
      inode: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      events,
      partialLine: buffer
    });

    const warnings: string[] = [];
    if (malformedLines > 0) warnings.push(`${malformedLines} malformed event line(s) were skipped`);
    if (buffer.trim()) warnings.push('The final event line is incomplete and was deferred');
    return { events, warnings };
  }
}

function parseEvent(line: string, order: number): AgentHostEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!isRecord(value)) return undefined;
    const data = isRecord(value.data) ? { ...value.data } : {};
    if (value.type === 'session.binary_asset') delete data.data;
    return {
      id: stringValue(value.id),
      parentId: stringValue(value.parentId),
      timestamp: isoValue(value.timestamp),
      type: stringValue(value.type),
      data,
      order
    };
  } catch {
    return undefined;
  }
}

function consumeHeaderEvent(header: AgentHostEventHeader, event: AgentHostEvent): void {
  const data = event.data;
  header.updatedAt = maxIso(header.updatedAt, event.timestamp);
  if (event.type === 'session.start') {
    header.sessionId = stringValue(data.sessionId) ?? header.sessionId;
    header.producer = stringValue(data.producer) ?? header.producer;
    header.copilotVersion = stringValue(data.copilotVersion) ?? header.copilotVersion;
    header.startTime = isoValue(data.startTime) ?? event.timestamp ?? header.startTime;
    header.schemaVersion = numberValue(data.version) ?? header.schemaVersion;
    header.selectedModel = stringValue(data.selectedModel) ?? header.selectedModel;
    header.reasoningEffort = getReasoningEffort(data) ?? header.reasoningEffort;
    consumeContext(header, data.context);
  } else if (event.type === 'session.resume') {
    header.selectedModel = stringValue(data.selectedModel) ?? header.selectedModel;
    header.reasoningEffort = getReasoningEffort(data) ?? header.reasoningEffort;
    consumeContext(header, data.context);
  } else if (event.type === 'session.context_changed') {
    consumeContext(header, data);
  } else if (event.type === 'session.model_change') {
    header.selectedModel = stringValue(data.newModel) ?? header.selectedModel;
    header.reasoningEffort = getReasoningEffort(data) ?? header.reasoningEffort;
  } else if (event.type === 'user.message' && !header.firstUserMessage) {
    header.firstUserMessage = textValue(data.content)?.slice(0, 280);
  }
}

function consumeContext(header: AgentHostEventHeader, value: unknown): void {
  if (!isRecord(value)) return;
  header.cwd = stringValue(value.cwd) ?? header.cwd;
  header.repository = stringValue(value.repository) ?? header.repository;
  header.branch = stringValue(value.branch) ?? header.branch;
  header.clientName = stringValue(value.clientName) ?? stringValue(value.client_name) ?? header.clientName;
}

function foldEvents(events: AgentHostEvent[], usage: AgentHostUsageRow[], warnings: string[]): AgentHostEventDetails {
  const ordered = [...events].sort((left, right) => {
    if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) return left.timestamp.localeCompare(right.timestamp);
    return left.order - right.order;
  });
  const turns: MutableTurn[] = [];
  const turnByEventId = new Map<string, MutableTurn>();
  const turnByInteraction = new Map<string, MutableTurn>();
  const toolById = new Map<string, MutableTool>();
  const pendingUsers: Array<{ content?: string; interactionId?: string; timestamp: string; attachments: unknown[] }> = [];
  const attachments: AttachmentInfo[] = [];
  const usedTools = new Set<string>();
  const deferredTools = new Set<string>();
  const usedAgents = new Set<string>();
  const systemMessages: string[] = [];
  let initialAttachmentChars = 0;
  let initialAttachmentContent = '';
  let systemTokens: number | undefined;
  let conversationTokens: number | undefined;
  let toolDefinitionsTokens: number | undefined;
  let messageCount = 0;
  const reasoningEffortByModel = new Map<string, string>();

  const createTurn = (event: AgentHostEvent, data: Record<string, unknown>): MutableTurn => {
    const interactionId = stringValue(data.interactionId);
    const eventTurnId = stringValue(data.turnId);
    const matchingUserIndex = interactionId
      ? pendingUsers.findIndex((item) => item.interactionId === interactionId)
      : pendingUsers.length ? 0 : -1;
    const user = matchingUserIndex >= 0 ? pendingUsers.splice(matchingUserIndex, 1)[0] : undefined;
    const turn: MutableTurn = {
      index: turns.length,
      eventTurnId,
      interactionId,
      userMessage: user?.content,
      timestamp: user?.timestamp ?? event.timestamp ?? new Date(0).toISOString(),
      models: new Set(),
      assistantMessages: [],
      tools: [],
      toolIds: new Set(),
      usage: [],
      hasBrowserContext: Boolean(user?.attachments.some(isBrowserAttachment))
    };
    turns.push(turn);
    if (eventTurnId) turnByEventId.set(eventTurnId, turn);
    if (interactionId) turnByInteraction.set(interactionId, turn);
    return turn;
  };

  const resolveTurn = (event: AgentHostEvent, create = true): MutableTurn | undefined => {
    const eventTurnId = stringValue(event.data.turnId);
    const interactionId = stringValue(event.data.interactionId);
    const existing = interactionId
      ? turnByInteraction.get(interactionId)
      : eventTurnId
        ? turnByEventId.get(eventTurnId)
        : turns.at(-1);
    return existing ?? (create ? createTurn(event, event.data) : undefined);
  };

  for (const event of ordered) {
    const data = event.data;
    if (event.type === 'session.start' || event.type === 'session.resume') {
      const model = stringValue(data.selectedModel);
      const reasoningEffort = getReasoningEffort(data);
      if (model && reasoningEffort) reasoningEffortByModel.set(model, reasoningEffort);
      continue;
    }

    if (event.type === 'session.model_change') {
      const model = stringValue(data.newModel);
      const reasoningEffort = getReasoningEffort(data);
      if (model && reasoningEffort) reasoningEffortByModel.set(model, reasoningEffort);
      continue;
    }

    if (event.type === 'user.message') {
      const content = textValue(data.content)?.slice(0, TEXT_LIMIT);
      if (content?.trimStart().startsWith('<skill-context')) continue;
      const interactionId = stringValue(data.interactionId);
      const rawAttachments = Array.isArray(data.attachments) ? data.attachments : [];
      const existingTurn = interactionId ? turnByInteraction.get(interactionId) : undefined;
      const pendingIndex = interactionId ? pendingUsers.findIndex((item) => item.interactionId === interactionId) : -1;
      let isNewMessage = false;
      if (existingTurn) {
        existingTurn.userMessage ??= content;
        existingTurn.hasBrowserContext ||= rawAttachments.some(isBrowserAttachment);
      } else if (pendingIndex >= 0) {
        pendingUsers[pendingIndex] = {
          content: pendingUsers[pendingIndex].content ?? content,
          interactionId,
          timestamp: pendingUsers[pendingIndex].timestamp,
          attachments: [...pendingUsers[pendingIndex].attachments, ...rawAttachments]
        };
      } else {
        isNewMessage = true;
        pendingUsers.push({
          content,
          interactionId,
          timestamp: event.timestamp ?? new Date(0).toISOString(),
          attachments: rawAttachments
        });
        if (messageCount === 0) {
          const initialAttachments = rawAttachments.map(normalizeContextAttachment);
          attachments.push(...initialAttachments);
          initialAttachmentChars = initialAttachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
          initialAttachmentContent = rawAttachments.map(serialize).join('\n\n');
        }
      }
      if (isNewMessage) messageCount += 1;
      continue;
    }

    if (event.type === 'assistant.turn_start') {
      const eventTurnId = stringValue(data.turnId);
      const turn = resolveTurn(event);
      if (eventTurnId && turn) turnByEventId.set(eventTurnId, turn);
      continue;
    }

    if (event.type === 'assistant.message') {
      const turn = resolveTurn(event);
      if (!turn) continue;
      const eventTurnId = stringValue(data.turnId);
      const model = stringValue(data.model);
      const reasoningEffort = getReasoningEffort(data) ?? (model ? reasoningEffortByModel.get(model) : undefined);
      if (model) turn.models.add(model);
      if (model && reasoningEffort) reasoningEffortByModel.set(model, reasoningEffort);
      turn.assistantMessages.push({ turnId: eventTurnId, model, reasoningEffort, outputTokens: numberValue(data.outputTokens) ?? 0, timestamp: event.timestamp ?? turn.timestamp });
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      for (const [requestIndex, requestValue] of toolRequests.entries()) {
        if (!isRecord(requestValue)) continue;
        const id = stringValue(requestValue.toolCallId) ?? stringValue(requestValue.id) ?? `${event.id ?? event.order}-request-${requestIndex}`;
        const name = stringValue(requestValue.toolName) ?? stringValue(requestValue.name) ?? 'unknown-tool';
        const argumentsValue = requestValue.arguments ?? requestValue.input;
        const tool = toolById.get(id) ?? {
          id,
          name,
          turnId: eventTurnId,
          detail: extractToolDetail(name, argumentsValue),
          inputChars: serialize(argumentsValue).length,
          outputChars: 0
        };
        toolById.set(id, tool);
        if (!turn.toolIds.has(id)) {
          turn.tools.push(tool);
          turn.toolIds.add(id);
        }
        usedTools.add(name);
      }
      messageCount += 1;
      continue;
    }

    if (event.type === 'tool.execution_start' || event.type === 'external_tool.requested') {
      const turn = resolveTurn(event);
      if (!turn) continue;
      const id = stringValue(data.toolCallId) ?? stringValue(data.requestId) ?? event.id ?? `tool-${event.order}`;
      const name = stringValue(data.toolName) ?? 'unknown-tool';
      const argumentsText = serialize(data.arguments);
      let tool = toolById.get(id);
      if (!tool) {
        tool = { id, name, turnId: stringValue(data.turnId), detail: extractToolDetail(name, data.arguments), inputChars: argumentsText.length, outputChars: 0 };
        toolById.set(id, tool);
      } else {
        tool.name = name;
        tool.detail ??= extractToolDetail(name, data.arguments);
        tool.inputChars = Math.max(tool.inputChars, argumentsText.length);
      }
      const requestId = stringValue(data.requestId);
      if (requestId) toolById.set(requestId, tool);
      if (!turn.toolIds.has(id)) {
        turn.tools.push(tool);
        turn.toolIds.add(id);
      }
      usedTools.add(name);
      continue;
    }

    if (event.type === 'tool.execution_complete' || event.type === 'external_tool.completed') {
      const id = stringValue(data.toolCallId) ?? stringValue(data.requestId);
      const tool = id ? toolById.get(id) : undefined;
      if (tool) {
        tool.outputChars = serialize(data.result).length;
        if (tool.name === 'tool_search_tool') {
          tool.returnedTools = parseDeferredToolNames(data.result);
          for (const name of tool.returnedTools) deferredTools.add(name);
        }
      }
      continue;
    }

    if (event.type === 'subagent.started' || event.type === 'subagent.completed') {
      const id = stringValue(data.toolCallId);
      const agentName = stringValue(data.agentName) ?? stringValue(data.agentId);
      if (agentName) {
        usedAgents.add(agentName);
      }
      if (id && agentName) {
        const tool = toolById.get(id);
        if (tool) tool.subagentName = agentName;
      }
      continue;
    }

    if (event.type === 'skill.invoked') {
      continue;
    }

    if (event.type === 'system.message') {
      const content = textValue(data.content);
      if (content) systemMessages.push(content);
      continue;
    }

    if (event.type === 'session.compaction_start' || event.type === 'session.shutdown') {
      systemTokens ??= numberValue(data.systemTokens);
      conversationTokens ??= numberValue(data.conversationTokens);
      toolDefinitionsTokens ??= numberValue(data.toolDefinitionsTokens);
    }
  }

  while (pendingUsers.length) {
    const user = pendingUsers.shift();
    if (!user) break;
    turns.push({
      index: turns.length,
      interactionId: user.interactionId,
      userMessage: user.content,
      timestamp: user.timestamp,
      models: new Set(),
      assistantMessages: [],
      tools: [],
      toolIds: new Set(),
      usage: [],
      hasBrowserContext: user.attachments.some(isBrowserAttachment)
    });
  }

  for (const row of usage) {
    if (row.agentId && row.parentToolCallId) {
      const tool = toolById.get(row.parentToolCallId);
      if (tool) {
        tool.subagentName ??= row.agentId;
        tool.subagentTurns ??= [];
        tool.subagentTurns.push(toAgentTurn(row, tool.subagentTurns.length));
      }
      usedAgents.add(row.agentId);
      continue;
    }
    const turn = findTurnForUsage(turns, row.timestamp);
    if (!turn) continue;
    turn.models.add(row.model);
    turn.usage.push(row);
  }

  for (const tool of toolById.values()) {
    tool.deferred = deferredTools.has(tool.name);
  }

  const systemPrompt = systemMessages[0] ?? '';
  const availableSkills = parseNamedBlocks<SkillInfo>(systemPrompt, 'available_skills', 'skill');
  const catalogAgents = parseNamedBlocks<AgentInfo>(systemPrompt, 'agents', 'agent');
  const contextTools = parseSystemToolBlocks(systemPrompt);
  const instructionBlocks = parseInstructionBlocks(systemPrompt);
  const userInstructionsChars = instructionBlocks.reduce((sum, instruction) => sum + instruction.sizeChars, 0);
  const agentDefinitionsChars = blockCharLength(systemPrompt, 'agents');
  const skillDefinitionsChars = blockCharLength(systemPrompt, 'skills') + blockCharLength(systemPrompt, 'available_skills');
  const toolDefinitionsChars = blockCharLength(systemPrompt, 'tools');
  const systemPromptChars = Math.max(0, systemPrompt.length - userInstructionsChars - agentDefinitionsChars - skillDefinitionsChars - toolDefinitionsChars);
  const contextContent = {
    system: stripContextBlocks(systemPrompt),
    instructions: instructionBlocks.map((instruction) => instruction.sourceText).join('\n\n'),
    agents: blocksText(systemPrompt, 'agents'),
    skills: [blocksText(systemPrompt, 'skills'), blocksText(systemPrompt, 'available_skills')].filter(Boolean).join('\n\n'),
    tools: blocksText(systemPrompt, 'tools'),
    conversation: turns[0]?.userMessage ?? '',
    other: initialAttachmentContent
  };

  const normalizedTurns = turns.map((turn) => normalizeTurn(turn, reasoningEffortByModel));
  const overview: SessionOverview = {
    skills: availableSkills.sort(bySizeThenName),
    skillsAvailability: availableSkills.length ? 'catalog' : 'unavailable',
    agents: catalogAgents.sort(bySizeThenName),
    agentsAvailability: catalogAgents.length ? 'catalog' : 'unavailable',
    userInstructions: instructionBlocks.map(({ content: _content, ...instruction }) => instruction),
    attachments: attachments.sort(bySizeThenName),
    tools: contextTools,
    toolsAvailability: contextTools.length ? 'definitions' : 'unavailable',
    contextContent,
    contextSizes: {
      systemPromptTotalBytes: Buffer.byteLength(systemPrompt, 'utf8'),
      systemPromptSkillsBytes: blockByteLength(systemPrompt, 'available_skills'),
      systemPromptAgentsBytes: blockByteLength(systemPrompt, 'agents'),
      systemPromptAttachmentsBytes: attachments.reduce((sum, item) => sum + item.sizeBytes, 0),
      userPromptBytes: normalizedTurns.reduce((sum, turn) => sum + Buffer.byteLength(turn.userMessage ?? '', 'utf8'), 0),
      systemPromptChars,
      userInstructionsChars,
      agentDefinitionsChars,
      skillDefinitionsChars,
      toolDefinitionsChars,
      mcpDefinitionsChars: 0,
      conversationChars: normalizedTurns[0]?.userMessage?.length ?? 0,
      otherChars: initialAttachmentChars,
      model: normalizedTurns.flatMap((turn) => turn.models)[0],
      systemTokens,
      conversationTokens,
      toolDefinitionsTokens
    }
  };

  return {
    turns: normalizedTurns,
    overview,
    tools: [...usedTools].sort(),
    agents: [...usedAgents].sort(),
    messageCount,
    userTurnCount: turns.filter((turn) => Boolean(turn.userMessage)).length,
    firstUserMessage: turns.find((turn) => turn.userMessage)?.userMessage?.slice(0, 280),
    warnings,
    instructionBlocks
  };
}

function normalizeTurn(turn: MutableTurn, reasoningEffortByModel: Map<string, string>): TurnInfo {
  const agentTurns: AgentTurnInfo[] = turn.usage.length
    ? turn.usage.map((row, index) => {
        return { ...toAgentTurn(row, index, reasoningEffortByModel.get(row.model)), toolCalls: toolsForTurn(turn.tools, index) };
      })
    : turn.assistantMessages.map((message, index) => ({
        index: numericTurnId(message.turnId) ?? index,
        model: message.model,
        reasoningEffort: message.reasoningEffort,
        inputTokens: 0,
        outputTokens: message.outputTokens,
        cachedTokens: 0,
        timestamp: message.timestamp,
        toolCalls: toolsForTurn(turn.tools, numericTurnId(message.turnId) ?? index)
      }));
  if (agentTurns.length === 0 && turn.tools.length) {
    agentTurns.push({ index: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, timestamp: turn.timestamp, toolCalls: turn.tools.map(normalizeTool) });
  }
  return {
    index: turn.index,
    userMessage: turn.userMessage,
    timestamp: turn.timestamp,
    models: [...turn.models].sort(),
    inputTokens: turn.usage.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: turn.usage.reduce((sum, row) => sum + row.outputTokens, 0) || turn.assistantMessages.reduce((sum, message) => sum + message.outputTokens, 0),
    cachedTokens: turn.usage.reduce((sum, row) => sum + row.cachedTokens, 0),
    aiCredits: optionalPositive(turn.usage.reduce((sum, row) => sum + row.nanoAiu / 1_000_000_000, 0)),
    llmRequestCount: turn.usage.length || turn.assistantMessages.length,
    toolCalls: turn.tools.map(normalizeTool),
    turns: agentTurns,
    hasBrowserContext: turn.hasBrowserContext
  };
}

function findTurnForUsage(turns: MutableTurn[], timestamp: string | undefined): MutableTurn | undefined {
  if (!turns.length) return undefined;
  if (!timestamp) return turns.at(-1);
  const usageTime = Date.parse(timestamp);
  if (Number.isNaN(usageTime)) return turns.at(-1);
  return [...turns].reverse().find((turn) => Date.parse(turn.timestamp) <= usageTime) ?? turns[0];
}

function numericTurnId(turnId: string | undefined): number | undefined {
  if (turnId === undefined) return undefined;
  const value = Number(turnId);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toolsForTurn(tools: MutableTool[], turnIndex: number): ToolCallInfo[] {
  return tools
    .filter((tool) => numericTurnId(tool.turnId) === turnIndex || (tool.turnId === undefined && turnIndex === 0))
    .map(normalizeTool);
}

function toAgentTurn(row: AgentHostUsageRow, index = 0, fallbackReasoningEffort?: string): AgentTurnInfo {
  return {
    index,
    model: row.model,
    reasoningEffort: row.reasoningEffort ?? fallbackReasoningEffort,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    aiCredits: optionalPositive(row.nanoAiu / 1_000_000_000),
    timestamp: row.timestamp ?? new Date(0).toISOString(),
    toolCalls: []
  };
}

function normalizeTool(tool: MutableTool): ToolCallInfo {
  return {
    name: tool.name,
    detail: tool.detail,
    deferred: tool.deferred,
    returnedTools: tool.returnedTools,
    inputChars: tool.inputChars,
    outputChars: tool.outputChars,
    subagentName: tool.subagentName,
    subagentTurns: tool.subagentTurns
  };
}

function parseDeferredToolNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  for (const candidate of [value.content, value.detailedContent]) {
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return [...new Set(parsed)];
      }
    } catch {
      // Tool search output is not guaranteed to be JSON in every runtime version.
    }
  }
  return [];
}

function normalizeAttachment(value: unknown): AttachmentInfo {
  const record = isRecord(value) ? value : {};
  const name = stringValue(record.name) ?? path.basename(stringValue(record.path) ?? stringValue(record.filePath) ?? stringValue(record.id) ?? 'attachment');
  const description = stringValue(record.description) ?? stringValue(record.mimeType) ?? '';
  return { name, description, sizeBytes: numberValue(record.byteLength) ?? Buffer.byteLength(serialize(value), 'utf8') };
}

function normalizeContextAttachment(value: unknown): AttachmentInfo {
  return { ...normalizeAttachment(value), sizeBytes: serialize(value).length };
}

function parseNamedBlocks<T extends SkillInfo | AgentInfo>(text: string, container: string, item: string): T[] {
  const containerMatch = text.match(new RegExp(`<${container}>([\\s\\S]*?)<\\/${container}>`));
  if (!containerMatch) return [];
  const results: T[] = [];
  const expression = new RegExp(`<${item}>[\\s\\S]*?<name>([\\s\\S]*?)<\\/name>[\\s\\S]*?<description>([\\s\\S]*?)<\\/description>[\\s\\S]*?<\\/${item}>`, 'g');
  for (const match of containerMatch[1].matchAll(expression)) {
    results.push({ name: match[1].trim(), description: match[2].trim(), sizeChars: match[0].length } as T);
  }
  return results;
}

function parseSystemToolBlocks(text: string): ToolInfo[] {
  const toolsMatch = text.match(/<tools>([\s\S]*?)<\/tools>/);
  if (!toolsMatch) return [];
  const tools: ToolInfo[] = [];
  const openingTag = /^<([A-Za-z][A-Za-z0-9_.:-]*)>\s*$/gm;
  for (const match of toolsMatch[1].matchAll(openingTag)) {
    const name = match[1];
    if (NON_TOOL_CONTEXT_BLOCKS.has(name)) continue;
    const blockMatch = toolsMatch[1].slice(match.index).match(new RegExp(`^<${escapeRegExp(name)}>([\\s\\S]*?)<\\/${escapeRegExp(name)}>`));
    if (!blockMatch) continue;
    const block = blockMatch[0];
    const description = blockMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    tools.push({
      name,
      description,
      isMcp: false,
      sizeBytes: Buffer.byteLength(block, 'utf8')
    });
  }
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()].sort(bySizeThenName);
}

function blockByteLength(text: string, name: string): number {
  const match = text.match(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`));
  return Buffer.byteLength(match?.[0] ?? '', 'utf8');
}

function blockCharLength(text: string, name: string): number {
  return text.match(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`))?.[0].length ?? 0;
}

function blocksCharLength(text: string, name: string): number {
  return [...text.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`, 'g'))]
    .reduce((sum, match) => sum + match[0].length, 0);
}

function blocksText(text: string, name: string): string {
  return [...text.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`, 'g'))]
    .map((match) => match[0])
    .join('\n\n');
}

function stripContextBlocks(text: string): string {
  const blockNames = ['agents', 'skills', 'available_skills', 'tools'];
  let result = text;
  for (const name of blockNames) {
    result = result.replace(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`, 'g'), '');
  }
  result = result
    .replace(/<custom_instruction(?:\s[^>]*)?>[\s\S]*?<\/custom_instruction>/g, '')
    .replace(/<attachment\s[^>]*filePath="[^"]+"[^>]*>[\s\S]*?<\/attachment>/g, '');
  return result;
}

function parseInstructionBlocks(text: string): InstructionBlock[] {
  const blocks: InstructionBlock[] = [];
  const expressions = [
    /<custom_instruction(?:\s[^>]*)?>([\s\S]*?)<\/custom_instruction>/g,
    /<attachment\s[^>]*filePath="([^"]+)"[^>]*>([\s\S]*?)<\/attachment>/g
  ];
  for (const [expressionIndex, expression] of expressions.entries()) {
    for (const match of text.matchAll(expression)) {
      const content = match[expressionIndex === 0 ? 1 : 2].trim();
      const explicitPath = expressionIndex === 1
        ? match[1]
        : content.match(/<imported_custom_instruction\s+source="([^"]+)"/)?.[1];
      const heading = content.match(/^#{1,6}\s+(.+)$/m)?.[1].trim();
      blocks.push({
        name: explicitPath ? path.basename(explicitPath) : heading ?? 'Instructions',
        path: explicitPath,
        sizeChars: match[0].length,
        content,
        sourceText: match[0]
      });
    }
  }
  return blocks;
}

function extractToolDetail(name: string, value: unknown): string | undefined {
  if (name === 'apply_patch' && typeof value === 'string') {
    const files = [...value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]);
    return files.length ? `files: ${formatPaths(files)}` : `patch: ${formatChars(value.length)}`;
  }
  if (typeof value === 'string') return formatDetailText(value);
  if (!isRecord(value)) return 'no arguments';

  const command = stringValue(value.command);
  if (command) return `command: ${formatDetailText(command)}`;

  const filePaths = stringArray(value.filePaths);
  if (filePaths.length) return `files: ${formatPaths(filePaths)}`;

  const filePath = stringValue(value.filePath) ?? stringValue(value.path);
  if (filePath) {
    const range = Array.isArray(value.view_range) && value.view_range.length === 2
      ? ` · lines ${String(value.view_range[0])}-${String(value.view_range[1])}`
      : '';
    return `file: ${compactPath(filePath)}${range}`;
  }

  const pattern = stringValue(value.pattern);
  const searchPaths = stringValue(value.paths);
  if (pattern) return `pattern: ${formatDetailText(pattern)}${searchPaths ? ` · in ${compactPath(searchPaths)}` : ''}`;

  const query = stringValue(value.query) ?? stringValue(value.searchText);
  if (query) return `query: ${formatDetailText(query)}`;

  const skill = stringValue(value.skill);
  if (skill) return `skill: ${skill}`;

  const library = stringValue(value.libraryName) ?? stringValue(value.context7CompatibleLibraryID);
  if (library) {
    const topic = stringValue(value.topic);
    return `library: ${library}${topic ? ` · ${formatDetailText(topic)}` : ''}`;
  }

  const urls = stringArray(value.urls);
  if (urls.length) return `URLs: ${formatPaths(urls)}`;

  const candidate = stringValue(value.description) ?? stringValue(value.explanation) ?? stringValue(value.goal);
  if (candidate) return formatDetailText(candidate);

  const entries = Object.entries(value).slice(0, 2);
  return entries.length
    ? entries.map(([key, entry]) => `${key}: ${formatDetailValue(entry)}`).join(' · ').slice(0, 280)
    : name === 'problems' ? 'workspace diagnostics' : 'no arguments';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function formatPaths(values: string[]): string {
  const visible = values.slice(0, 3).map(compactPath).join(', ');
  return values.length > 3 ? `${visible} +${values.length - 3}` : visible;
}

function compactPath(value: string): string {
  if (/^https?:\/\//.test(value)) return formatDetailText(value, 120);
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-3).join('/') || value;
}

function formatDetailText(value: string, limit = 220): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function formatDetailValue(value: unknown): string {
  if (typeof value === 'string') return formatDetailText(value, 120);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.slice(0, 3).map(formatDetailValue).join(', ');
  return formatDetailText(serialize(value), 120);
}

function formatChars(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k chars` : `${value} chars`;
}

function isBrowserAttachment(value: unknown): boolean {
  return serialize(value).toLowerCase().includes('browser');
}

function serialize(value: unknown): string {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return serialized.slice(0, TEXT_LIMIT);
  } catch {
    return '';
  }
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value.map((item) => isRecord(item) ? stringValue(item.text) ?? stringValue(item.content) ?? '' : '').filter(Boolean).join('\n');
    return text || undefined;
  }
  if (isRecord(value)) return stringValue(value.text) ?? stringValue(value.content);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getReasoningEffort(data: Record<string, unknown>): string | undefined {
  return stringValue(data.reasoningEffort) ?? stringValue(data.reasoning_effort);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isoValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function maxIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function optionalPositive(value: number): number | undefined {
  return value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bySizeThenName<T extends { sizeBytes?: number; sizeChars?: number; name: string }>(left: T, right: T): number {
  return (right.sizeChars ?? right.sizeBytes ?? 0) - (left.sizeChars ?? left.sizeBytes ?? 0) || left.name.localeCompare(right.name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}