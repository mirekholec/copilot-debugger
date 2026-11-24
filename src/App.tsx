import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, Clock3, Coins, Filter, RefreshCw, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ContextCompaction, CurrentContextDetail, CurrentContextEntry } from '../server/sources/SessionSource';
import { ContextContent } from './ContextContent';

interface NormalizedSession {
  id: string;
  workspaceStorageId: string;
  workspaceName?: string;
  sourceKind: 'copilot-agent-host';
  clientName?: string;
  repository?: string;
  dataCompleteness?: {
    hasEvents: boolean;
    hasWorkspaceMetadata: boolean;
    hasUsageData: boolean;
    warnings: string[];
  };
  updatedAt: string;
  producer: string;
  copilotVersion?: string;
  vscodeVersion?: string;
  firstUserMessage?: string;
  agents: string[];
  tools: string[];
  hasDebugLog: boolean;
  hasDetailedEvents: boolean;
  cost: {
    aiCredits?: number;
    aiCreditUnit?: 'AIC';
    aiCreditSource?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    requestCount?: number;
    models: string[];
  };
}

interface ToolCallInfo {
  name: string;
  detail?: string;
  deferred?: boolean;
  returnedTools?: string[];
  inputChars: number;
  outputChars: number;
  subagentName?: string;
  subagentTurns?: AgentTurnInfo[];
}

// One individual agent LLM call inside a round. The main agent uses one model
// throughout a round; subagent turns may use a different model.
interface AgentTurnInfo {
  index: number;
  model?: string;
  reasoningEffort?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  aiCredits?: number;
  timestamp: string;
  toolCalls: ToolCallInfo[];
}

interface TurnInfo {
  index: number;
  userMessage?: string;
  timestamp: string;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  aiCredits?: number;
  llmRequestCount: number;
  toolCalls: ToolCallInfo[];
  turns: AgentTurnInfo[];
  hasBrowserContext: boolean;
}

interface SessionsResponse {
  sessions: NormalizedSession[];
  total: number;
  lastRefreshAt?: string;
  error?: string;
}

interface SkillInfo {
  name: string;
  description: string;
  sizeBytes?: number;
  sizeChars?: number;
}

interface AgentInfo {
  name: string;
  description: string;
  path?: string;
  sizeBytes?: number;
  sizeChars?: number;
}

interface AttachmentInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

interface InstructionInfo {
  name: string;
  path?: string;
  sizeChars: number;
}

interface ToolInfo {
  name: string;
  description: string;
  isMcp: boolean;
  deferred?: boolean;
  mcpServer?: string;
  sizeBytes: number;
}

interface McpServerInfo {
  name: string;
  title?: string;
  instructionBytes: number;
  instructions?: string;
  documentedTools: string[];
}

type ContextSectionKey = 'system' | 'instructions' | 'agents' | 'skills' | 'tools' | 'mcp' | 'conversation' | 'other';

type InitialContextSectionKey = 'agents' | 'skills' | 'tools' | 'instructions' | 'other';

interface InitialContextSection {
  key: InitialContextSectionKey;
  label: string;
  chars: number;
  content: string;
}

interface InitialContextMessage {
  id: string;
  type: 'system' | 'user';
  label: string;
  chars: number;
  content: string;
  sections?: InitialContextSection[];
}

interface ContextSizes {
  systemPromptTotalBytes: number;
  systemPromptSkillsBytes: number;
  systemPromptAgentsBytes: number;
  systemPromptAttachmentsBytes: number;
  toolsBytes?: number;
  userPromptBytes: number;
  systemPromptChars: number;
  userInstructionsChars: number;
  agentDefinitionsChars: number;
  skillDefinitionsChars: number;
  toolDefinitionsChars: number;
  mcpDefinitionsChars: number;
  conversationChars: number;
  otherChars: number;
  maxContextTokens?: number;
  model?: string;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
}

interface ContextWindowSnapshot {
  currentTokens?: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
  model?: string;
  capturedAt?: string;
  source?: 'event' | 'usage' | 'compaction';
}

interface SessionOverview {
  skills: SkillInfo[];
  skillsAvailability?: 'catalog' | 'unavailable';
  agents: AgentInfo[];
  agentsAvailability?: 'catalog' | 'unavailable';
  userInstructions: InstructionInfo[];
  attachments: AttachmentInfo[];
  tools: ToolInfo[];
  toolsAvailability?: 'definitions' | 'unavailable';
  mcpServers?: McpServerInfo[];
  mcpServersAvailability?: 'initialized' | 'unavailable';
  contextSizes?: ContextSizes;
  contextContent?: Partial<Record<ContextSectionKey, string>>;
  initialContextMessages?: InitialContextMessage[];
  finalContext?: ContextWindowSnapshot;
  currentContextDetails?: CurrentContextDetail[];
  lastCompaction?: ContextCompaction;
}

const SESSION_ROUTE_PREFIX = '/sessions/';

function toLocalDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function defaultDateFrom(): string {
  const now = new Date();
  return toLocalDateInput(new Date(now.getFullYear(), now.getMonth(), 1));
}

function defaultDateTo(): string {
  return toLocalDateInput(new Date());
}

const FILTERS_STORAGE_KEY = 'copilot-debugger.filters';

interface StoredFilters {
  dateFrom: string;
  dateTo: string;
  workspaceFilter: string;
}

function loadStoredFilters(): StoredFilters {
  try {
    const raw = window.sessionStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return { dateFrom: defaultDateFrom(), dateTo: defaultDateTo(), workspaceFilter: 'all' };
    const parsed = JSON.parse(raw) as Partial<StoredFilters>;
    return {
      dateFrom: typeof parsed.dateFrom === 'string' && parsed.dateFrom ? parsed.dateFrom : defaultDateFrom(),
      dateTo: typeof parsed.dateTo === 'string' && parsed.dateTo ? parsed.dateTo : defaultDateTo(),
      workspaceFilter: typeof parsed.workspaceFilter === 'string' && parsed.workspaceFilter ? parsed.workspaceFilter : 'all'
    };
  } catch {
    return { dateFrom: defaultDateFrom(), dateTo: defaultDateTo(), workspaceFilter: 'all' };
  }
}

function getRouteSessionId() {
  if (!window.location.pathname.startsWith(SESSION_ROUTE_PREFIX)) return undefined;
  const encodedId = window.location.pathname.slice(SESSION_ROUTE_PREFIX.length);
  if (!encodedId) return undefined;
  return decodeURIComponent(encodedId);
}

function sessionUrl(id: string) {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(id)}`;
}

function formatChars(value: number, includeUnit = true) {
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 100 ? 2 : value < 10_000 ? 1 : 0
  }).format(value / 1000);
  return `${formatted}k${includeUnit ? ' chars' : ''}`;
}

function formatInstructionPath(value: string) {
  if (value.length <= 40) return value;
  const separatorIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const fileNameLength = value.length - separatorIndex - 1;
  const suffixLength = Math.max(42, fileNameLength);
  return `...${value.slice(-suffixLength)}`;
}

export default function App() {
  const [sessions, setSessions] = useState<NormalizedSession[]>([]);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState(() => loadStoredFilters().workspaceFilter);
  const [detailSessionId, setDetailSessionId] = useState<string | undefined>(() => getRouteSessionId());
  const [turns, setTurns] = useState<TurnInfo[]>();
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [overview, setOverview] = useState<SessionOverview | null>();
  const [dateFrom, setDateFrom] = useState(() => loadStoredFilters().dateFrom);
  const [dateTo, setDateTo] = useState(() => loadStoredFilters().dateTo);
  const [apiConnecting, setApiConnecting] = useState(true);
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    const filters: StoredFilters = { dateFrom, dateTo, workspaceFilter };
    window.sessionStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  }, [dateFrom, dateTo, workspaceFilter]);

  async function loadSessions() {
    try {
      const response = await fetch('/api/sessions');
      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }
      const payload = (await response.json()) as SessionsResponse;
      if (!hasConnectedRef.current && payload.lastRefreshAt === undefined && payload.error === undefined) {
        // API is reachable but hasn't finished its first storage scan yet.
        // Keep the connecting loader up and poll again shortly.
        window.setTimeout(() => void loadSessions(), 500);
        return;
      }
      hasConnectedRef.current = true;
      setApiConnecting(false);
      setSessions(payload.sessions);
      setError(payload.error);
    } catch (caught) {
      if (!hasConnectedRef.current) {
        // API is still starting up (e.g. scanning storage before it opens its port).
        // Keep showing the connecting loader and retry shortly instead of surfacing an error.
        window.setTimeout(() => void loadSessions(), 500);
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    if (!detailSessionId || apiConnecting) return;
    const controller = new AbortController();
    const { signal } = controller;
    const url = `/api/sessions/${encodeURIComponent(detailSessionId)}`;
    setTurns(undefined);
    setOverview(undefined);
    setDetailError(undefined);
    setTurnsLoading(true);

    async function refreshOverview() {
      try {
        const response = await fetch(`${url}/overview`, { signal });
        if (!response.ok) return;
        const payload = (await response.json()) as SessionOverview;
        if (!signal.aborted) setOverview(payload);
      } catch {
        // The next poll can retry unavailable overview data.
      }
    }

    async function fetchTurns() {
      try {
        const response = await fetch(`${url}/turns`, { signal });
        if (!response.ok) {
          throw new Error(response.status === 404 ? 'Session not found.' : `API returned ${response.status}`);
        }
        const payload = (await response.json()) as { turns: TurnInfo[] };
        if (!signal.aborted) setTurns(payload.turns);
      } catch (caught) {
        if (!signal.aborted) setDetailError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!signal.aborted) setTurnsLoading(false);
      }
    }

    void fetchTurns();
    void refreshOverview();
    const interval = window.setInterval(() => void refreshOverview(), 5_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [detailSessionId, apiConnecting]);

  function openDetail(id: string) {
    setDetailSessionId(id);
    window.history.pushState(null, '', sessionUrl(id));
    window.scrollTo(0, 0);
  }

  function navigateToSessions() {
    if (window.location.pathname === '/') return;
    window.history.pushState(null, '', '/');
    setDetailSessionId(undefined);
    setTurns(undefined);
    setOverview(undefined);
    window.scrollTo(0, 0);
  }

  useEffect(() => {
    void loadSessions();
    const interval = window.setInterval(() => void loadSessions(), 5_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    function syncRoute() {
      const id = getRouteSessionId();
      if (!id && window.location.pathname !== '/') {
        window.history.replaceState(null, '', '/');
      }
      setDetailSessionId(id);
    }

    syncRoute();
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, []);

  const workspaces = useMemo(() => {
    const fromDate = dateFrom ? new Date(dateFrom + 'T00:00:00') : null;
    const toDate = dateTo ? new Date(dateTo + 'T23:59:59') : null;
    const names = new Set<string>();
    sessions.forEach((session) => {
      const updatedAt = new Date(session.updatedAt);
      if (fromDate && updatedAt < fromDate) return;
      if (toDate && updatedAt > toDate) return;
      names.add(session.workspaceName ?? session.workspaceStorageId);
    });
    return [...names].sort();
  }, [sessions, dateFrom, dateTo]);

  useEffect(() => {
    if (workspaceFilter !== 'all' && !workspaces.includes(workspaceFilter)) {
      setWorkspaceFilter('all');
    }
  }, [workspaces, workspaceFilter]);

  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const fromDate = dateFrom ? new Date(dateFrom + 'T00:00:00') : null;
    const toDate = dateTo ? new Date(dateTo + 'T23:59:59') : null;
    return sessions.filter((session) => {
      const updatedAt = new Date(session.updatedAt);
      if (fromDate && updatedAt < fromDate) return false;
      if (toDate && updatedAt > toDate) return false;
      const matchesQuery = normalizedQuery
        ? [session.id, session.workspaceStorageId, session.workspaceName, session.firstUserMessage, session.producer, session.clientName, session.repository]
            .filter(Boolean)
            .some((value) => value?.toLowerCase().includes(normalizedQuery))
        : true;
      const sessionWorkspace = session.workspaceName ?? session.workspaceStorageId;
      const matchesWorkspace = workspaceFilter === 'all' || sessionWorkspace === workspaceFilter;
      return matchesQuery && matchesWorkspace;
    });
  }, [workspaceFilter, query, sessions, dateFrom, dateTo]);

  const detailSession = sessions.find((s) => s.id === detailSessionId);

  if (apiConnecting) {
    return (
      <main className="app-shell">
        <div className="api-connecting-screen">
          <RefreshCw size={28} className="spin" aria-hidden="true" />
          <h2>Connecting to API…</h2>
          <p>Backend is starting up and scanning local storage. Retrying…</p>
        </div>
        <Footer />
      </main>
    );
  }

  if (detailSessionId) {
    const aiCredits = detailSession?.cost.aiCredits;
    const warnings = detailSession?.dataCompleteness?.warnings ?? [];
    const titleChars = Array.from(detailSession?.firstUserMessage || 'Session detail');
    const titleLimit = 70;
    const title = titleChars.length > titleLimit
      ? titleChars.slice(0, titleLimit - 1).join('') + '…'
      : titleChars.join('');
    return (
      <main className="app-shell">
        <header className="session-heading">
          <div className="session-heading-bar">
            <button type="button" className="back-link" onClick={navigateToSessions} aria-label="Back to sessions">
              <ArrowLeft size={15} aria-hidden="true" />
              Sessions
            </button>
            <h1>{title}</h1>
            <div className="cost-summary-pill">
              <Coins size={14} aria-hidden="true" />
              {aiCredits !== undefined
                ? <strong>{formatAic(aiCredits)} AIC</strong>
                : <span>No AIC data</span>}
            </div>
          </div>
          {warnings.length > 0 && <div className="completeness-warning">{warnings.join(' · ')}</div>}
        </header>

        <section className="turns-area">
          {overview && <SessionOverviewPanel overview={overview} />}
          {turnsLoading ? (
            <StateMessage title="Loading turns" detail="Parsing JSONL log file…" />
          ) : detailError ? (
            <StateMessage title="Unable to load session" detail={detailError} />
          ) : turns && turns.length === 0 ? (
            <StateMessage title="No turns found" detail="This session has no event stream, stored turns, or recorded user messages." />
          ) : turns ? (
            <>
              <ToolPayloadAnalysis turns={turns} />
              <div className="turns-list">
                {turns.map((turn) => (
                  <TurnCard key={turn.index} turn={turn} />
                ))}
              </div>
            </>
          ) : null}
          {overview && <CurrentContextPanel overview={overview} />}
        </section>
        <Footer />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="list-toolbar">
        <h1>Sessions <span>{formatNumber(filteredSessions.length)}</span></h1>
        <div className="filters" role="group" aria-label="Session filters">
          <label className="search-box">
            <Search size={17} aria-hidden="true" />
            <input type="search" aria-label="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" />
          </label>

          <label className="select-box">
            <Filter size={17} aria-hidden="true" />
            <select aria-label="Workspace" value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}>
              <option value="all">All workspaces</option>
              {workspaces.map((ws) => (
                <option key={ws} value={ws}>
                  {ws.length > 25 ? ws.slice(0, 25) + '…' : ws}
                </option>
              ))}
            </select>
          </label>

          <label className="date-box">
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label="From date" />
          </label>

          <label className="date-box">
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label="To date" />
          </label>
        </div>
      </header>

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

      <section className="session-table" aria-label="Session list">
        {filteredSessions.length === 0 ? (
          <StateMessage
            title="No sessions found"
            detail={sessions.length ? 'Try a different search or date range.' : 'Continue a Copilot Chat turn to create a session.'}
          />
        ) : (
          <>
            <div className="session-columns" aria-hidden="true">
              <span>Session</span>
              <span>Updated</span>
              <span>AI credits</span>
            </div>
            <ul className="session-list" role="list">
              {filteredSessions.map((session) => (
                <li key={session.id}>
                  <a
                    className="session-row"
                    href={sessionUrl(session.id)}
                    onClick={(event) => {
                      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      openDetail(session.id);
                    }}
                  >
                    <span className="session-title">
                      <strong>{session.firstUserMessage || 'Untitled session'}</strong>
                      <small>{session.workspaceName ?? session.workspaceStorageId}</small>
                    </span>
                    <time className="session-date" dateTime={session.updatedAt}>{formatDateTime(session.updatedAt)}</time>
                    <span className="session-credits">
                      {session.cost.aiCredits === undefined ? '—' : `${formatAic(session.cost.aiCredits)} AIC`}
                    </span>
                    <ChevronRight className="session-arrow" size={16} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <Footer />
    </main>
  );
}

function Footer() {
  return (
    <footer className="app-footer">
      <a
        href="https://github.com/mirekholec/copilot-debugger/blob/main/CHANGELOG.md"
        target="_blank"
        rel="noopener noreferrer"
      >
        v{__APP_VERSION__} · Changelog
      </a>
      <span className="app-footer-sep">·</span>
      <a href="https://github.com/mirekholec/copilot-debugger" target="_blank" rel="noopener noreferrer">
        GitHub
      </a>
      <span className="app-footer-sep">·</span>
      <a href="https://holec.ai" target="_blank" rel="noopener noreferrer">
        holec.ai
      </a>
    </footer>
  );
}

function ToolCallRow({ tc }: { tc: ToolCallInfo }) {
  const subagentTurns = tc.name === 'runSubagent' ? tc.subagentTurns : undefined;

  return (
    <div className="activity-tool">
      <div className="activity-row">
        <span className="activity-value">
          <span className="activity-tool-summary">
            <span className="activity-tool-name">{tc.name}</span>
            {tc.detail ? <span className="activity-detail" title={tc.detail}>{tc.detail}</span> : null}
          </span>
          {tc.returnedTools?.length ? (
            <span className="activity-tool-results" title={tc.returnedTools.join(', ')}>
              returned: {tc.returnedTools.join(', ')}
            </span>
          ) : null}
        </span>
        {subagentTurns?.length ? (
          <span className="activity-subagent-label">{tc.subagentName ?? 'subagent'} · {subagentTurns.length} turns</span>
        ) : null}
      </div>
      {subagentTurns?.length ? (
        <div className="activity-subagent-detail">
          {subagentTurns.map((turn) => (
            <AgentTurnActivity key={turn.index} turn={turn} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentTurnActivity({ turn }: { turn: AgentTurnInfo }) {
  return (
    <div className="activity-turn">
      <div className="activity-turn-heading">
        <span className="activity-label">Turn {turn.index + 1}</span>
        <span className="activity-turn-model">{turn.model ?? 'Unknown model'}</span>
      </div>
      {turn.toolCalls.map((tc, index) => (
        <ToolCallRow key={index} tc={tc} />
      ))}
    </div>
  );
}

function TurnCard({ turn }: { turn: TurnInfo }) {
  const [showTurns, setShowTurns] = useState(false);
  const hasActivity = turn.toolCalls.length > 0 || turn.turns.length > 0;
  const hasMultipleRequests = turn.llmRequestCount > 1;
  const latestInputTokens = turn.turns.at(-1)?.inputTokens;
  const aggregateInputTitle = hasMultipleRequests
    ? `Total across ${turn.llmRequestCount} model calls${latestInputTokens ? `. Latest input: ${formatNumber(latestInputTokens)} tokens.` : '.'}`
    : undefined;
  const aggregateTokenTitle = hasMultipleRequests ? `Total across ${turn.llmRequestCount} model calls.` : undefined;
  const getModelEffort = (model: string): string | undefined => {
    const efforts = [...new Set(
      turn.turns
        .filter((agentTurn) => agentTurn.model === model && agentTurn.reasoningEffort)
        .map((agentTurn) => agentTurn.reasoningEffort)
        .filter((effort): effort is string => Boolean(effort))
    )];
    return efforts.length ? efforts.join(', ') : undefined;
  };

  return (
    <div className="turn-card" id={`turn-${turn.index}`}>
      <div className="turn-header">
        <span className="turn-index">#{turn.index + 1}</span>
        <span className="turn-message">{turn.userMessage ?? '(no message)'}</span>
        <span className="turn-time">{formatDateTime(turn.timestamp)}</span>
      </div>
      <div className="turn-body">
        <div className="turn-aic">
          <Coins size={14} aria-hidden="true" />
          {turn.aiCredits !== undefined ? <strong>{formatAic(turn.aiCredits)} AIC</strong> : <span className="no-aic">—</span>}
        </div>
        <div className="turn-chips">
          {turn.inputTokens > 0 ? <span title={aggregateInputTitle}>{formatNumber(turn.inputTokens)} in{hasMultipleRequests ? ' total' : ''}</span> : null}
          {turn.outputTokens > 0 ? <span title={aggregateTokenTitle}>{formatNumber(turn.outputTokens)} out{hasMultipleRequests ? ' total' : ''}</span> : null}
          {turn.cachedTokens > 0 ? <span title={aggregateTokenTitle}>{formatNumber(turn.cachedTokens)} cached{hasMultipleRequests ? ' total' : ''}</span> : null}
          {turn.llmRequestCount > 0 ? <span>{turn.llmRequestCount} turns</span> : null}
          {turn.models.map((m) => {
            const effort = getModelEffort(m);
            return (
              <span
                key={m}
                className="model-chip"
                data-tooltip={effort ? `Reasoning effort: ${effort}` : undefined}
                aria-label={effort ? `${m}, reasoning effort ${effort}` : m}
              >
                {m}
              </span>
            );
          })}
          {turn.hasBrowserContext && <span className="browser-chip" title="Contains Attached Element Context">🌐 browser</span>}
        </div>
        {hasActivity && (
          <button type="button" className="turns-toggle" aria-expanded={showTurns} onClick={() => setShowTurns((v) => !v)}>
            {showTurns ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {showTurns ? 'Hide turns' : 'Show turns'}
          </button>
        )}
      </div>
      {hasActivity && showTurns && (
        <div className="turn-activity">
          {turn.turns.length > 0 ? (
            turn.turns.map((t) => (
              <AgentTurnActivity key={t.index} turn={t} />
            ))
          ) : (
            turn.toolCalls.map((tc, i) => <ToolCallRow key={i} tc={tc} />)
          )}
        </div>
      )}
    </div>
  );
}

function ToolPayloadAnalysis({ turns }: { turns: TurnInfo[] }) {
  const rows = useMemo(() => {
    const map = new Map<string, { name: string; deferred: boolean; calls: number; input: number; output: number }>();
    for (const turn of turns) {
      for (const tool of turn.toolCalls) {
        const current = map.get(tool.name) ?? { name: tool.name, deferred: false, calls: 0, input: 0, output: 0 };
        current.deferred ||= Boolean(tool.deferred);
        current.calls += 1;
        current.input += tool.inputChars;
        current.output += tool.outputChars;
        map.set(tool.name, current);
      }
    }
    return [...map.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output) || a.name.localeCompare(b.name));
  }, [turns]);

  if (rows.length === 0) {
    return null;
  }

  const totalInput = rows.reduce((sum, row) => sum + row.input, 0);
  const totalOutput = rows.reduce((sum, row) => sum + row.output, 0);
  const HIGHLIGHT_SHARE_THRESHOLD = 0.2;
  const highlightClass = (value: number, total: number) => (total > 0 && value / total >= HIGHLIGHT_SHARE_THRESHOLD ? 'tool-token-bar tool-token-bar--highlight' : 'tool-token-bar');

  return (
    <div className="tool-token-analysis">
      <div className="tool-token-header">
        <div>
          <h3>Tool Payloads</h3>
          <p>Raw characters in tool calls and results passed to the model; not token usage.</p>
        </div>
        <div className="tool-token-total">
          {formatChars(totalInput + totalOutput)} total
          <span>{formatChars(totalInput)} in / {formatChars(totalOutput)} out</span>
        </div>
      </div>
      <div className="tool-token-table">
        <div className="tool-token-row tool-token-row--head">
          <span>Tool</span>
          <span>Calls</span>
          <span>Input</span>
          <span>Output</span>
          <span>Total</span>
        </div>
        {rows.map((row) => (
          <div key={row.name} className="tool-token-row">
            <span className="tool-token-name">
              {row.name}
              {row.deferred && <Clock3 size={12} aria-label="Deferred tool" />}
            </span>
            <span>{formatNumber(row.calls)}</span>
            <span className={highlightClass(row.input, totalInput)} title={`${formatNumber(row.input)} C`}>{formatChars(row.input)}</span>
            <span className={highlightClass(row.output, totalOutput)} title={`${formatNumber(row.output)} C`}>{formatChars(row.output)}</span>
            <span title={`${formatNumber(row.input + row.output)} C`}>{formatChars(row.input + row.output)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StateMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="state-message">
      <Clock3 size={22} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

function SessionOverviewPanel({ overview }: { overview: SessionOverview }) {
  if (!overview.contextSizes || !overview.initialContextMessages) {
    return null;
  }

  return (
    <div className="session-overview">
      <InitialPromptBar
        sizes={overview.contextSizes}
        messages={overview.initialContextMessages}
        scaleChars={contextScaleChars(overview)}
      />
    </div>
  );
}

function CurrentContextPanel({ overview }: { overview: SessionOverview }) {
  const compaction = overview.lastCompaction;
  const fallbackModel = overview.contextSizes?.model;
  const scaleChars = contextScaleChars(overview);

  return (
    <div className="session-overview session-overview--current">
      {compaction && (
        <CurrentContextBar
          label="Context window · before compact"
          meta={formatCompaction(compaction)}
          snapshot={compaction.before}
          fallbackModel={fallbackModel}
          details={compaction.beforeDetails}
          scaleChars={scaleChars}
        />
      )}
      <CurrentContextBar snapshot={overview.finalContext} fallbackModel={fallbackModel} details={overview.currentContextDetails} scaleChars={scaleChars} />
    </div>
  );
}

function formatCompaction({ completedAt, trigger, messagesRemoved }: ContextCompaction) {
  return [
    `Compacted ${formatDateTime(completedAt)}`,
    trigger,
    messagesRemoved !== undefined ? `${formatNumber(messagesRemoved)} messages removed` : undefined
  ].filter(Boolean).join(' · ');
}

function countCurrentContextChars(details: CurrentContextDetail[] = []) {
  return details.reduce((sum, detail) => sum + detail.content.length, 0);
}

/** All context bars share one scale so they can be compared directly. */
function contextScaleChars(overview: SessionOverview) {
  return Math.max(
    (overview.initialContextMessages ?? []).reduce((sum, message) => sum + message.chars, 0),
    countCurrentContextChars(overview.currentContextDetails),
    countCurrentContextChars(overview.lastCompaction?.beforeDetails)
  );
}

function CurrentContextBar({ label = 'Context window · current', meta, snapshot, fallbackModel, details = [], scaleChars }: {
  label?: string;
  meta?: string;
  snapshot?: ContextWindowSnapshot;
  fallbackModel?: string;
  details?: CurrentContextDetail[];
  scaleChars?: number;
}) {
  const totalChars = countCurrentContextChars(details);
  const knownTokens = (snapshot?.toolDefinitionsTokens ?? 0) + (snapshot?.systemTokens ?? 0)
    + (snapshot?.conversationTokens ?? 0);
  const totalTokens = snapshot?.currentTokens ?? (knownTokens > 0 ? knownTokens : undefined);
  const estimated = snapshot?.source !== 'usage';
  const snapshotTitle = snapshot?.capturedAt
    ? `${estimated ? 'Local estimate' : 'Last model request'}: ${formatDateTime(snapshot.capturedAt)}`
    : undefined;

  return (
    <div className="ctx-window">
      <div className="ctx-window-header">
        <span className="ctx-window-label">{label}</span>
        {(snapshot?.model ?? fallbackModel) && <span className="ctx-window-model">{snapshot?.model ?? fallbackModel}</span>}
        {meta && <span className="ctx-window-meta">{meta}</span>}
        <span className="ctx-window-usage" title={snapshotTitle}>
          {totalChars > 0 && `${formatChars(totalChars)} recorded`}
          {totalChars > 0 && totalTokens !== undefined && ' · '}
          {totalTokens !== undefined && `${estimated ? '≈ ' : ''}${formatNumber(totalTokens)} tokens`}
        </span>
      </div>
      {totalChars > 0 ? (
        <ContextBreakdown
          label={`${label} by recorded character count`}
          scaleChars={Math.max(totalChars, scaleChars ?? 0)}
          items={details.map((detail) => ({ ...detail, id: detail.key, chars: detail.content.length }))}
        />
      ) : (
        <div className="ctx-window-empty">
          {snapshot ? 'No session log entries were recorded for this snapshot.' : 'No persisted context snapshot is available for this session yet.'}
        </div>
      )}
    </div>
  );
}

const initialContextOrder: Record<InitialContextSectionKey | 'user', number> = {
  tools: 0,
  other: 1,
  agents: 2,
  skills: 3,
  instructions: 4,
  user: 5
};

function InitialPromptBar({ sizes, messages, scaleChars }: {
  sizes: ContextSizes;
  messages: InitialContextMessage[];
  scaleChars: number;
}) {
  const visibleMessages = messages.filter((message) => message.chars > 0);
  const total = visibleMessages.reduce((sum, message) => sum + message.chars, 0);
  const systemCount = visibleMessages.filter((message) => message.type === 'system').length;
  const items = visibleMessages.flatMap<ContextBreakdownItem<InitialContextSectionKey | 'user'>>((message) =>
    message.type === 'system'
      ? (message.sections?.length ? message.sections : [{ ...message, key: 'other' as const, label: 'System message' }]).map((section, index) => ({
          id: `${message.id}-${index}`,
          key: section.key,
          label: systemCount > 1 ? `${message.label} · ${section.label}` : section.label,
          chars: section.chars,
          content: section.content
        }))
      : [{ id: message.id, key: 'user' as const, label: message.label, chars: message.chars, content: message.content }]
  ).sort((a, b) => initialContextOrder[a.key] - initialContextOrder[b.key]);

  return (
    <div className="ctx-window">
      <div className="ctx-window-header">
        <span className="ctx-window-label">Context window</span>
        {sizes.model && <span className="ctx-window-model">{sizes.model}</span>}
        <span className="ctx-window-usage">{formatChars(total)} raw text</span>
      </div>
      <ContextBreakdown label="Initial context by character count" scaleChars={Math.max(total, scaleChars)} items={items} />
    </div>
  );
}

interface ContextBreakdownItem<Key extends string = string> {
  id: string;
  key: Key;
  label: string;
  chars: number;
  content: string;
  entries?: CurrentContextEntry[];
}

function ContextBreakdown({ label, scaleChars, items }: {
  label: string;
  scaleChars: number;
  items: ContextBreakdownItem[];
}) {
  const contentId = useId();
  const [selected, setSelected] = useState<string>();
  const selectedItem = items.find((item) => item.id === selected);
  const toggleDetail = (id: string) => setSelected((current) => current === id ? undefined : id);

  return (
    <>
      <div className="ctx-bar" role="group" aria-label={label}>
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`ctx-seg ctx-seg--${item.key}`}
            style={{ width: scaleChars > 0 ? `${(item.chars / scaleChars) * 100}%` : '0%' }}
            title={`${item.label}: ${formatChars(item.chars)}`}
            aria-label={item.label}
            aria-expanded={selected === item.id}
            aria-controls={contentId}
            onClick={() => toggleDetail(item.id)}
          />
        ))}
      </div>
      <div className="ctx-legend" role="group" aria-label="Context sections">
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`ctx-legend-item ctx-legend-item--${item.key}`}
            aria-expanded={selected === item.id}
            aria-controls={contentId}
            onClick={() => toggleDetail(item.id)}
          >
            <span className="ctx-legend-dot" />
            {item.label} <span className="ctx-legend-val">{formatChars(item.chars, false)}</span>
          </button>
        ))}
      </div>
      <div id={contentId} role="region" aria-label={selectedItem?.label} hidden={!selectedItem}>
        {selectedItem?.entries?.length ? (
          <ContextConversation entries={selectedItem.entries} content={selectedItem.content} />
        ) : selectedItem && <ContextContent key={selectedItem.id} content={selectedItem.content} />}
      </div>
    </>
  );
}

const contextEntryLabels: Record<CurrentContextEntry['kind'], string> = {
  user: 'User',
  assistant: 'Assistant',
  'tool-call': 'Tool call',
  'tool-result': 'Tool result',
  attachments: 'Attachments',
  summary: 'Compaction summary'
};
const contextEntryTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });

function ContextConversation({ entries, content }: { entries: CurrentContextEntry[]; content: string }) {
  const listRef = useRef<HTMLOListElement>(null);

  function scrollToEntry(index: number, direction: 'previous' | 'next') {
    const list = listRef.current;
    const entry = list?.children.item(index);
    if (!list || !(entry instanceof HTMLElement)) return;

    const top = list.scrollTop + entry.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop;
    const control = entry.querySelector<HTMLButtonElement>(`[data-direction="${direction}"]:enabled`) ?? entry;
    control.focus({ preventScroll: true });
    list.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  return (
    <ol ref={listRef} className="ctx-conversation" tabIndex={0} aria-label="Recorded messages and tool calls">
      {entries.map(({ kind, timestamp, toolName, start, end }, index) => (
        <li key={start} className={`ctx-entry ctx-entry--${kind}`} tabIndex={-1}>
          <div className="ctx-entry-header">
            <strong>{contextEntryLabels[kind]}</strong>
            {toolName && <span>{toolName}</span>}
            <div className="ctx-entry-actions">
              <time dateTime={timestamp}>{contextEntryTime.format(new Date(timestamp))}</time>
              <button type="button" className="ctx-entry-step" data-direction="previous" aria-label="Previous entry" title="Previous entry"
                disabled={index === 0} onClick={() => scrollToEntry(index - 1, 'previous')}>
                <ArrowUp size={14} aria-hidden="true" />
              </button>
              <button type="button" className="ctx-entry-step" data-direction="next" aria-label="Next entry" title="Next entry"
                disabled={index === entries.length - 1} onClick={() => scrollToEntry(index + 1, 'next')}>
                <ArrowDown size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
          {end > start && <ContextContent content={content.slice(start, end)} />}
        </li>
      ))}
    </ol>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
}

function formatAic(value: number) {
  return value.toFixed(2);
}
