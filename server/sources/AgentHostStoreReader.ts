import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import type { SessionCostInfo } from './SessionSource.js';

export interface AgentHostUsageRow {
  sessionId: string;
  turnIndex?: number;
  agentId?: string;
  parentToolCallId?: string;
  model: string;
  reasoningEffort?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  nanoAiu: number;
  timestamp?: string;
}

export interface AgentHostStoreSession {
  id: string;
  cwd?: string;
  repository?: string;
  branch?: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  hostType?: string;
  firstUserMessage?: string;
  turnCount: number;
  messageCount: number;
  cost: SessionCostInfo;
  agents: string[];
}

export interface AgentHostStoreSnapshot {
  sessions: Map<string, AgentHostStoreSession>;
  usageBySession: Map<string, AgentHostUsageRow[]>;
  schemaVersion?: number;
  warning?: string;
}

interface SqliteSessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
  host_type: string | null;
}

interface SqliteTurnRow {
  session_id: string;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

interface SqliteUsageRow {
  session_id: string;
  turn_index: number | null;
  agent_id: string | null;
  parent_tool_call_id: string | null;
  model: string;
  reasoning_effort: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_nano_aiu: number | null;
  created_at: string | null;
}

export class AgentHostStoreReader {
  constructor(private readonly databasePath: string) {}

  async readSnapshot(): Promise<AgentHostStoreSnapshot> {
    try {
      await fs.access(this.databasePath);
    } catch {
      return { sessions: new Map(), usageBySession: new Map(), warning: 'Agent Host session-store.db is unavailable' };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return this.readDatabase();
      } catch (error) {
        lastError = error;
        if (!isBusyError(error) || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    return {
      sessions: new Map(),
      usageBySession: new Map(),
      warning: `Agent Host session store could not be read: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    };
  }

  private readDatabase(): AgentHostStoreSnapshot {
    const database = new Database(this.databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 250
    });

    try {
      const tables = new Set(
        (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
      );
      const schemaVersion = tables.has('schema_version')
        ? (database.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version?: number } | undefined)?.version
        : undefined;
      const sessions = new Map<string, AgentHostStoreSession>();
      const usageBySession = new Map<string, AgentHostUsageRow[]>();

      if (tables.has('sessions') && this.hasColumns(database, 'sessions', ['id'])) {
        const available = this.columnNames(database, 'sessions');
        const select = ['id', 'cwd', 'repository', 'branch', 'summary', 'created_at', 'updated_at', 'host_type']
          .map((column) => available.has(column) ? column : `NULL AS ${column}`)
          .join(', ');
        const rows = database.prepare(`SELECT ${select} FROM sessions`).all() as SqliteSessionRow[];
        for (const row of rows) {
          sessions.set(row.id, {
            id: row.id,
            cwd: optionalString(row.cwd),
            repository: optionalString(row.repository),
            branch: optionalString(row.branch),
            summary: optionalString(row.summary),
            createdAt: toIso(row.created_at),
            updatedAt: toIso(row.updated_at),
            hostType: optionalString(row.host_type),
            turnCount: 0,
            messageCount: 0,
            cost: { models: [], perModel: [] },
            agents: []
          });
        }
      }

      if (tables.has('turns') && this.hasColumns(database, 'turns', ['session_id', 'turn_index'])) {
        const available = this.columnNames(database, 'turns');
        const select = ['session_id', 'turn_index', 'user_message', 'assistant_response', 'timestamp']
          .map((column) => available.has(column) ? column : `NULL AS ${column}`)
          .join(', ');
        const rows = database.prepare(`SELECT ${select} FROM turns ORDER BY session_id, turn_index`).all() as SqliteTurnRow[];
        for (const row of rows) {
          const session = sessions.get(row.session_id);
          if (!session) continue;
          session.turnCount += 1;
          session.messageCount += Number(Boolean(row.user_message)) + Number(Boolean(row.assistant_response));
          session.firstUserMessage ??= optionalString(row.user_message)?.slice(0, 280);
          session.updatedAt = maxIso(session.updatedAt, toIso(row.timestamp));
        }
      }

      if (tables.has('assistant_usage_events') && this.hasColumns(database, 'assistant_usage_events', ['session_id', 'model'])) {
        const available = this.columnNames(database, 'assistant_usage_events');
        const columns = [
          'session_id', 'turn_index', 'agent_id', 'parent_tool_call_id', 'model', 'reasoning_effort', 'input_tokens', 'output_tokens',
          'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_nano_aiu', 'created_at'
        ];
        const select = columns.map((column) => available.has(column) ? column : `NULL AS ${column}`).join(', ');
        const orderColumn = available.has('id') ? 'id' : available.has('created_at') ? 'created_at' : 'session_id';
        const rows = database.prepare(`SELECT ${select} FROM assistant_usage_events ORDER BY session_id, ${orderColumn}`).all() as SqliteUsageRow[];
        for (const row of rows) {
          const usage: AgentHostUsageRow = {
            sessionId: row.session_id,
            turnIndex: optionalNumber(row.turn_index),
            agentId: optionalString(row.agent_id),
            parentToolCallId: optionalString(row.parent_tool_call_id),
            model: row.model,
            reasoningEffort: optionalString(row.reasoning_effort),
            inputTokens: row.input_tokens ?? 0,
            outputTokens: row.output_tokens ?? 0,
            cachedTokens: row.cache_read_tokens ?? 0,
            cacheWriteTokens: row.cache_write_tokens ?? 0,
            reasoningTokens: row.reasoning_tokens ?? 0,
            nanoAiu: row.total_nano_aiu ?? 0,
            timestamp: toIso(row.created_at)
          };
          const usageRows = usageBySession.get(row.session_id) ?? [];
          usageRows.push(usage);
          usageBySession.set(row.session_id, usageRows);
        }
      }

      for (const [sessionId, usageRows] of usageBySession) {
        let session = sessions.get(sessionId);
        if (!session) {
          session = { id: sessionId, turnCount: 0, messageCount: 0, cost: { models: [], perModel: [] }, agents: [] };
          sessions.set(sessionId, session);
        }
        session.cost = aggregateUsage(usageRows);
        session.agents = [...new Set(usageRows.map((row) => row.agentId).filter((value): value is string => Boolean(value)))].sort();
      }

      return { sessions, usageBySession, schemaVersion };
    } finally {
      database.close();
    }
  }

  private columnNames(database: Database.Database, table: string): Set<string> {
    return new Set((database.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name));
  }

  private hasColumns(database: Database.Database, table: string, required: string[]): boolean {
    const columns = this.columnNames(database, table);
    return required.every((column) => columns.has(column));
  }
}

function aggregateUsage(rows: AgentHostUsageRow[]): SessionCostInfo {
  const models = new Map<string, {
    aiCredits: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    requestCount: number;
    reasoningEfforts: Set<string>;
  }>();
  let aiCredits = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  for (const row of rows) {
    aiCredits += row.nanoAiu / 1_000_000_000;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cachedTokens += row.cachedTokens;
    const model = models.get(row.model) ?? {
      aiCredits: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      requestCount: 0,
      reasoningEfforts: new Set<string>()
    };
    model.aiCredits += row.nanoAiu / 1_000_000_000;
    model.inputTokens += row.inputTokens;
    model.outputTokens += row.outputTokens;
    model.cachedTokens += row.cachedTokens;
    model.requestCount += 1;
    if (row.reasoningEffort) model.reasoningEfforts.add(row.reasoningEffort);
    models.set(row.model, model);
  }

  return {
    aiCredits: rows.length ? aiCredits : undefined,
    aiCreditUnit: rows.length ? 'AIC' : undefined,
    aiCreditSource: rows.length ? 'assistant_usage_events.total_nano_aiu' : undefined,
    inputTokens: inputTokens || undefined,
    outputTokens: outputTokens || undefined,
    cachedTokens: cachedTokens || undefined,
    requestCount: rows.length || undefined,
    models: [...models.keys()].sort(),
    perModel: [...models.entries()]
      .map(([model, value]) => ({
        model,
        aiCredits: value.aiCredits,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        cachedTokens: value.cachedTokens,
        requestCount: value.requestCount,
        reasoningEffort: value.reasoningEfforts.size ? [...value.reasoningEfforts].sort().join(', ') : undefined
      }))
      .sort((left, right) => (right.aiCredits ?? 0) - (left.aiCredits ?? 0) || left.model.localeCompare(right.model))
  };
}

function optionalString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function maxIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function isBusyError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}