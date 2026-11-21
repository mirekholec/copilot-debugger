import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';
import { AgentHostCustomizationsReader } from './AgentHostCustomizationsReader.js';
import { AgentHostEventReader, createUsageContextSnapshot, isSlashCommand, type AgentHostEventDetails, type AgentHostEventHeader } from './AgentHostEventReader.js';
import { AgentHostProcessLogReader } from './AgentHostProcessLogReader.js';
import { AgentHostStoreReader, type AgentHostStoredTurn, type AgentHostStoreSession, type AgentHostStoreSnapshot, type AgentHostUsageRow } from './AgentHostStoreReader.js';
import type { AgentInfo, AgentTurnInfo, NormalizedSession, SessionSource, SessionSourceSnapshot, TurnInfo, SessionOverview } from './SessionSource.js';

interface CopilotAgentHostSourceOptions {
  agentHostRoot: string;
  customizationsRoot?: string;
  pollIntervalMs: number;
}

interface WorkspaceMetadata {
  id?: string;
  cwd?: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  clientName?: string;
  repository?: string;
  branch?: string;
}

interface SessionFiles {
  events?: string;
  workspaceMetadata?: string;
}

export class CopilotAgentHostSource implements SessionSource {
  private readonly eventReader = new AgentHostEventReader();
  private readonly customizationsReader: AgentHostCustomizationsReader;
  private readonly processLogReader: AgentHostProcessLogReader;
  private readonly storeReader: AgentHostStoreReader;
  private readonly sessionStateRoot: string;
  private readonly databasePath: string;
  private sessions = new Map<string, NormalizedSession>();
  private usageBySession: AgentHostStoreSnapshot['usageBySession'] = new Map();
  private turnsBySession: AgentHostStoreSnapshot['turnsBySession'] = new Map();
  private detailPromises = new Map<string, Promise<AgentHostEventDetails | undefined>>();
  private details = new Map<string, AgentHostEventDetails>();
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private refreshInFlight?: Promise<void>;
  private lastRefreshAt?: string;
  private error?: string;

  constructor(private readonly options: CopilotAgentHostSourceOptions) {
    this.sessionStateRoot = path.join(options.agentHostRoot, 'session-state');
    this.databasePath = path.join(options.agentHostRoot, 'session-store.db');
    this.storeReader = new AgentHostStoreReader(this.databasePath);
    this.processLogReader = new AgentHostProcessLogReader(path.join(options.agentHostRoot, 'logs'));
    this.customizationsReader = new AgentHostCustomizationsReader(options.customizationsRoot);
  }

  async start(): Promise<void> {
    await this.refresh();
    await this.startWatcher();
    this.pollTimer = setInterval(() => this.scheduleRefresh(), this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.watcher?.close();
  }

  listSessions(): SessionSourceSnapshot {
    return {
      sessions: [...this.sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      lastRefreshAt: this.lastRefreshAt,
      error: this.error
    };
  }

  getSession(id: string): NormalizedSession | undefined {
    return this.sessions.get(id);
  }

  async getSessionTurns(id: string): Promise<TurnInfo[]> {
    return (await this.getDetails(id))?.turns ?? [];
  }

  async getSessionOverview(id: string): Promise<SessionOverview | undefined> {
    return (await this.getDetails(id))?.overview;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 350);
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    try {
      const [files, store] = await Promise.all([this.discoverFiles(), this.storeReader.readSnapshot()]);
      const ids = new Set([...files.keys(), ...store.sessions.keys()]);
      const next = new Map<string, NormalizedSession>();

      for (const id of ids) {
        const sessionFiles = files.get(id) ?? {};
        const [workspace, header] = await Promise.all([
          sessionFiles.workspaceMetadata ? readWorkspaceMetadata(sessionFiles.workspaceMetadata) : Promise.resolve(undefined),
          sessionFiles.events && shouldReadHeader(store.sessions.get(id), sessionFiles.workspaceMetadata)
            ? this.eventReader.readHeader(sessionFiles.events)
            : Promise.resolve({} as AgentHostEventHeader)
        ]);
        const normalized = await this.normalizeSession(id, sessionFiles, store, workspace, header);
        const storedTurns = store.turnsBySession.get(normalized.id) ?? store.turnsBySession.get(id) ?? [];
        if (!isEmptySession(normalized) && !isHarnessOnlySession(normalized, header, storedTurns)) {
          next.set(normalized.id, normalized);
        }
      }

      this.sessions = next;
      this.usageBySession = store.usageBySession;
      this.turnsBySession = store.turnsBySession;
      this.details.clear();
      this.detailPromises.clear();
      this.lastRefreshAt = new Date().toISOString();
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.lastRefreshAt = new Date().toISOString();
    }
  }

  private async discoverFiles(): Promise<Map<string, SessionFiles>> {
    const toGlob = (value: string) => value.replace(/\\/g, '/');
    const [directoryEvents, rootEvents, workspaceFiles] = await Promise.all([
      fg(toGlob(path.join(this.sessionStateRoot, '*', 'events.jsonl')), { onlyFiles: true, suppressErrors: true }),
      fg(toGlob(path.join(this.sessionStateRoot, '*.jsonl')), { onlyFiles: true, suppressErrors: true }),
      fg(toGlob(path.join(this.sessionStateRoot, '*', 'workspace.yaml')), { onlyFiles: true, suppressErrors: true })
    ]);
    const files = new Map<string, SessionFiles>();
    for (const filePath of rootEvents) {
      const id = path.basename(filePath, '.jsonl');
      files.set(id, { ...(files.get(id) ?? {}), events: filePath });
    }
    for (const filePath of directoryEvents) {
      const id = path.basename(path.dirname(filePath));
      files.set(id, { ...(files.get(id) ?? {}), events: filePath });
    }
    for (const filePath of workspaceFiles) {
      const id = path.basename(path.dirname(filePath));
      files.set(id, { ...(files.get(id) ?? {}), workspaceMetadata: filePath });
    }
    return files;
  }

  private async normalizeSession(
    discoveredId: string,
    files: SessionFiles,
    store: AgentHostStoreSnapshot,
    workspace: WorkspaceMetadata | undefined,
    header: AgentHostEventHeader
  ): Promise<NormalizedSession> {
    const id = header.sessionId ?? workspace?.id ?? discoveredId;
    const dbSession = store.sessions.get(id) ?? store.sessions.get(discoveredId);
    const eventStats = files.events ? await safeStats(files.events) : undefined;
    const cwd = workspace?.cwd ?? header.cwd ?? dbSession?.cwd;
    const repository = workspace?.repository ?? header.repository ?? dbSession?.repository;
    const workspaceKey = cwd ?? repository ?? id;
    const warnings: string[] = [];
    if (header.sessionId && header.sessionId !== discoveredId) warnings.push(`Event session ID differs from storage ID ${discoveredId}`);
    if (store.warning) warnings.push(store.warning);
    if (!files.events) warnings.push('Detailed event stream is unavailable');
    if (!dbSession?.cost.requestCount) warnings.push('Precise usage data is unavailable');

    const cost = dbSession?.cost ?? { models: header.selectedModel ? [header.selectedModel] : [], perModel: [] };
    if (!cost.models.length && header.selectedModel) cost.models = [header.selectedModel];
    const updatedAt = maxIso(workspace?.updatedAt, dbSession?.updatedAt, header.updatedAt, eventStats?.mtime.toISOString()) ?? new Date(0).toISOString();
    const startTime = minIso(workspace?.createdAt, dbSession?.createdAt, header.startTime, eventStats?.birthtime.toISOString());

    return {
      id,
      workspaceStorageId: workspaceKey,
      workspaceKey,
      workspaceName: cwd ? path.basename(cwd) : repository ? path.basename(repository) : undefined,
      sourcePaths: {
        events: files.events,
        workspaceMetadata: files.workspaceMetadata,
        sessionStore: store.warning ? undefined : this.databasePath
      },
      sourceKind: 'copilot-agent-host',
      clientName: workspace?.clientName ?? header.clientName ?? dbSession?.hostType,
      repository,
      branch: workspace?.branch ?? header.branch ?? dbSession?.branch,
      hostType: dbSession?.hostType,
      schemaVersion: store.schemaVersion ?? header.schemaVersion,
      dataCompleteness: {
        hasEvents: Boolean(files.events),
        hasWorkspaceMetadata: Boolean(files.workspaceMetadata),
        hasUsageData: Boolean(dbSession?.cost.requestCount),
        warnings
      },
      startTime,
      updatedAt,
      producer: header.producer ?? 'Copilot Agent Host',
      copilotVersion: header.copilotVersion,
      firstUserMessage: dbSession?.firstUserMessage ?? workspace?.summary ?? header.firstUserMessage ?? dbSession?.summary,
      messageCount: dbSession?.messageCount ?? 0,
      userTurnCount: dbSession?.turnCount ?? 0,
      agents: dbSession?.agents ?? [],
      tools: [],
      hasDebugLog: Boolean(files.events),
      hasDetailedEvents: Boolean(files.events),
      cost
    };
  }

  private async getDetails(id: string): Promise<AgentHostEventDetails | undefined> {
    const existing = this.details.get(id);
    if (existing) return existing;
    const inFlight = this.detailPromises.get(id);
    if (inFlight) return inFlight;
    const session = this.sessions.get(id);
    const eventsPath = session?.sourcePaths.events;
    if (!session) return undefined;

    const usage = this.usageBySession.get(id) ?? [];
    const storedTurns = this.turnsBySession.get(id) ?? [];
    const eventDetails = eventsPath
      ? this.eventReader.readDetails(eventsPath, usage)
      : Promise.resolve(createStoredDetails(session, storedTurns, usage));
    const promise = Promise.all([
      eventDetails,
      this.processLogReader.readMcpServers(id),
      this.customizationsReader.read(id)
    ])
      .then(([details, mcpServers, customizations]) => {
        if (customizations.skills.length && details.overview.skills.length === 0) {
          details.overview.skills = customizations.skills;
          details.overview.skillsAvailability = 'catalog';
        }
        if (customizations.agents.length && details.overview.agents.length === 0) {
          details.overview.agents = customizations.agents;
          details.overview.agentsAvailability = 'catalog';
          addAgentCatalogToContext(details.overview, customizations.agents);
        }
        if (customizations.sourcePath) session.sourcePaths.customizations = customizations.sourcePath;
        details.overview.userInstructions = details.instructionBlocks.map((block) => {
          const matchingInstruction = customizations.instructions
            .filter((instruction) => block.content.includes(instruction.content.trim()))
            .sort((left, right) => right.content.length - left.content.length)[0];
          return matchingInstruction
            ? { name: matchingInstruction.name, path: matchingInstruction.path, sizeChars: block.sizeChars }
            : { name: block.name, path: block.path, sizeChars: block.sizeChars };
        });
        details.overview.mcpServers = mcpServers;
        details.overview.mcpServersAvailability = mcpServers.length ? 'initialized' : 'unavailable';
        if (details.overview.contextContent) {
          details.overview.contextContent.mcp = mcpServers
            .map((server) => server.instructions)
            .filter((instructions): instructions is string => Boolean(instructions))
            .join('\n\n');
        }
        if (details.overview.contextSizes) {
          details.overview.contextSizes.mcpDefinitionsChars = mcpServers.reduce((sum, server) => sum + server.instructionBytes, 0);
        }
        this.details.set(id, details);
        session.tools = details.tools;
        session.agents = [...new Set([...session.agents, ...details.agents])].sort();
        session.messageCount ||= details.messageCount;
        session.userTurnCount ||= details.userTurnCount;
        session.firstUserMessage ??= details.firstUserMessage;
        if (session.dataCompleteness && details.warnings.length) {
          session.dataCompleteness.warnings = [...new Set([...session.dataCompleteness.warnings, ...details.warnings])];
        }
        return details;
      })
      .catch(() => undefined)
      .finally(() => this.detailPromises.delete(id));
    this.detailPromises.set(id, promise);
    return promise;
  }

  private async startWatcher(): Promise<void> {
    this.watcher = chokidar.watch([
      this.sessionStateRoot,
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`
    ], {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });
    this.watcher.on('addDir', () => this.scheduleRefresh());
    this.watcher.on('add', () => this.scheduleRefresh());
    this.watcher.on('change', () => this.scheduleRefresh());
    this.watcher.on('unlink', () => this.scheduleRefresh());
    this.watcher.on('error', (error) => {
      this.error = error instanceof Error ? error.message : String(error);
    });
  }
}

function shouldReadHeader(session: AgentHostStoreSession | undefined, workspacePath?: string): boolean {
  return !session?.cost.requestCount || !workspacePath || !session.firstUserMessage;
}

function isHarnessOnlySession(
  session: NormalizedSession,
  header: AgentHostEventHeader,
  storedTurns: AgentHostStoredTurn[]
): boolean {
  if (session.cost.requestCount || storedTurns.some((turn) => turn.assistantResponse)) return false;

  if (session.sourcePaths.events) {
    return header.commandOnly === true && storedTurns.every((turn) => isSlashCommand(turn.userMessage));
  }

  // VS Code can persist /env as a catalog entry without writing a turn or an event log.
  return session.clientName === 'vscode-agent-host'
    && session.firstUserMessage?.trim() === '/env'
    && storedTurns.length === 0;
}

function createStoredDetails(
  session: NormalizedSession,
  storedTurns: AgentHostStoredTurn[],
  usage: AgentHostUsageRow[]
): AgentHostEventDetails {
  const turnRows = [...storedTurns].sort((left, right) => left.turnIndex - right.turnIndex);
  const knownTurnIndexes = new Set(turnRows.map((turn) => turn.turnIndex));
  for (const row of usage) {
    if (row.turnIndex !== undefined) knownTurnIndexes.add(row.turnIndex);
  }
  for (const turnIndex of [...knownTurnIndexes].sort((left, right) => left - right)) {
    if (!turnRows.some((turn) => turn.turnIndex === turnIndex)) turnRows.push({ turnIndex });
  }
  turnRows.sort((left, right) => left.turnIndex - right.turnIndex);

  const turns = turnRows.map((storedTurn, index) => {
    const turnUsage = usage.filter((row) =>
      row.turnIndex === storedTurn.turnIndex
      || (row.turnIndex === undefined && index === 0)
    );
    return createStoredTurn(storedTurn, index, turnUsage, session.updatedAt);
  });
  const latestUsage = createUsageContextSnapshot(usage);
  const model = latestUsage?.model;
  const conversationChars = turns.reduce((sum, turn) => sum + (turn.userMessage?.length ?? 0), 0);

  return {
    turns,
    overview: {
      skills: [],
      skillsAvailability: 'unavailable',
      agents: [],
      agentsAvailability: 'unavailable',
      userInstructions: [],
      attachments: [],
      tools: [],
      toolsAvailability: 'unavailable',
      contextSizes: {
        systemPromptTotalBytes: 0,
        systemPromptSkillsBytes: 0,
        systemPromptAgentsBytes: 0,
        systemPromptAttachmentsBytes: 0,
        userPromptBytes: turns.reduce((sum, turn) => sum + Buffer.byteLength(turn.userMessage ?? '', 'utf8'), 0),
        systemPromptChars: 0,
        userInstructionsChars: 0,
        agentDefinitionsChars: 0,
        skillDefinitionsChars: 0,
        toolDefinitionsChars: 0,
        mcpDefinitionsChars: 0,
        conversationChars,
        otherChars: 0,
        model
      },
      finalContext: latestUsage
    },
    tools: [],
    agents: [],
    messageCount: session.messageCount,
    userTurnCount: turns.filter((turn) => Boolean(turn.userMessage)).length,
    firstUserMessage: session.firstUserMessage,
    warnings: ['Detailed event stream is unavailable; turns reconstructed from session store'],
    instructionBlocks: []
  };
}

function createStoredTurn(
  stored: AgentHostStoredTurn,
  index: number,
  usage: AgentHostUsageRow[],
  fallbackTimestamp: string
): TurnInfo {
  const models = [...new Set(usage.map((row) => row.model))].sort();
  const agentTurns: AgentTurnInfo[] = usage.map((row, requestIndex) => ({
    index: requestIndex,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    aiCredits: row.nanoAiu > 0 ? row.nanoAiu / 1_000_000_000 : undefined,
    timestamp: row.timestamp ?? stored.timestamp ?? fallbackTimestamp,
    toolCalls: []
  }));
  return {
    index,
    userMessage: stored.userMessage,
    timestamp: stored.timestamp ?? usage[0]?.timestamp ?? fallbackTimestamp,
    models,
    inputTokens: usage.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: usage.reduce((sum, row) => sum + row.outputTokens, 0),
    cachedTokens: usage.reduce((sum, row) => sum + row.cachedTokens, 0),
    aiCredits: usage.length
      ? usage.reduce((sum, row) => sum + row.nanoAiu / 1_000_000_000, 0)
      : undefined,
    llmRequestCount: usage.length,
    toolCalls: [],
    turns: agentTurns,
    hasBrowserContext: false
  };
}

async function readWorkspaceMetadata(filePath: string): Promise<WorkspaceMetadata | undefined> {
  try {
    const parsed = parseYaml(await fs.readFile(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      id: stringValue(parsed.id),
      cwd: stringValue(parsed.cwd),
      summary: stringValue(parsed.summary),
      createdAt: isoValue(parsed.created_at ?? parsed.createdAt),
      updatedAt: isoValue(parsed.updated_at ?? parsed.updatedAt),
      clientName: stringValue(parsed.client_name ?? parsed.clientName),
      repository: stringValue(parsed.repository),
      branch: stringValue(parsed.branch)
    };
  } catch {
    return undefined;
  }
}

async function safeStats(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isoValue(value: unknown): string | undefined {
  if (!(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function maxIso(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function minIso(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(0);
}

function isEmptySession(session: NormalizedSession): boolean {
  return !session.firstUserMessage
    && session.messageCount === 0
    && session.userTurnCount === 0
    && (session.cost.requestCount ?? 0) === 0
    && (session.cost.aiCredits ?? 0) === 0
    && session.tools.length === 0
    && session.agents.length === 0;
}

function addAgentCatalogToContext(overview: SessionOverview, agents: AgentInfo[]): void {
  const content = serializeAgentCatalog(agents);
  if (!content) return;

  overview.contextContent ??= {};
  overview.contextContent.agents = content;
  const messages = overview.initialContextMessages ?? (overview.initialContextMessages = []);
  const agentSection = { key: 'agents' as const, label: 'Agents', chars: content.length, content };
  const systemMessage = messages.find((message) => message.type === 'system');

  if (systemMessage) {
    const sections = systemMessage.sections?.length
      ? systemMessage.sections
      : [{ key: 'other' as const, label: 'System message', chars: systemMessage.content.length, content: systemMessage.content }];
    systemMessage.content += content;
    systemMessage.chars = systemMessage.content.length;
    systemMessage.sections = [...sections, agentSection];
  } else {
    messages.unshift({
      id: 'custom-agent-catalog',
      type: 'system',
      label: 'System message 1',
      chars: content.length,
      content,
      sections: [agentSection]
    });
  }

  if (overview.contextSizes) {
    const bytes = Buffer.byteLength(content, 'utf8');
    overview.contextSizes.systemPromptTotalBytes += bytes;
    overview.contextSizes.systemPromptAgentsBytes = bytes;
    overview.contextSizes.agentDefinitionsChars = content.length;
  }
}

function serializeAgentCatalog(agents: AgentInfo[]): string {
  if (!agents.length) return '';
  const entries = agents.map((agent) => {
    const sourcePath = agent.path ? `\n    <path>${escapeXml(displayAgentPath(agent.path))}</path>` : '';
    return [
      '  <agent>',
      `    <name>${escapeXml(agent.name)}</name>`,
      `    <description>${escapeXml(agent.description)}</description>${sourcePath}`,
      '  </agent>'
    ].join('\n');
  });
  return ['<agents>', ...entries, '</agents>'].join('\n');
}

function displayAgentPath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const homePath = os.homedir().replace(/\\/g, '/').replace(/\/$/, '');
  return normalizedPath === homePath
    ? '~'
    : normalizedPath.startsWith(`${homePath}/`)
      ? `~${normalizedPath.slice(homePath.length)}`
      : normalizedPath;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;'
    };
    return entities[character];
  });
}
