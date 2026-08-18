import { Calendar, ChevronDown, ChevronRight, Clock3, Coins, ExternalLink, Filter, PanelsTopLeft, RefreshCw, Search, Settings as SettingsIcon, Terminal, X } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface SourceFileInfo {
  transcript?: string;
  debugLog?: string;
  events?: string;
  workspaceMetadata?: string;
  sessionStore?: string;
  customizations?: string;
}

interface ModelCostInfo {
  model: string;
  reasoningEffort?: string;
  aiCredits?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  requestCount?: number;
}

interface ModelAggregateRow {
  model: string;
  aiCredits: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requestCount: number;
  sessionCount: number;
}

interface NormalizedSession {
  id: string;
  workspaceStorageId: string;
  workspaceName?: string;
  sourcePaths: SourceFileInfo;
  sourceKind: 'copilot-agent-host';
  clientName?: string;
  repository?: string;
  branch?: string;
  dataCompleteness?: {
    hasEvents: boolean;
    hasWorkspaceMetadata: boolean;
    hasUsageData: boolean;
    warnings: string[];
  };
  startTime?: string;
  updatedAt: string;
  producer: string;
  copilotVersion?: string;
  vscodeVersion?: string;
  firstUserMessage?: string;
  messageCount: number;
  userTurnCount: number;
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
    perModel: ModelCostInfo[];
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
}

type LoadState = 'loading' | 'ready' | 'error';

const SESSION_ROUTE_PREFIX = '/sessions/';

type AppPage = 'sessions' | 'models' | 'settings';

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

const SETTINGS_STORAGE_KEY = 'copilot-debugger.settings';
const DEFAULT_RATE = 4.8;
const DEFAULT_CURRENCY = 'Kč';

interface AppSettings {
  rate: number;
  currency: string;
}

function loadStoredSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { rate: DEFAULT_RATE, currency: DEFAULT_CURRENCY };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      rate: typeof parsed.rate === 'number' && parsed.rate > 0 ? parsed.rate : DEFAULT_RATE,
      currency: typeof parsed.currency === 'string' && parsed.currency.trim() ? parsed.currency : DEFAULT_CURRENCY
    };
  } catch {
    return { rate: DEFAULT_RATE, currency: DEFAULT_CURRENCY };
  }
}

const SettingsContext = createContext<{
  rate: number;
  currency: string;
  setRate: (rate: number) => void;
  setCurrency: (currency: string) => void;
} | null>(null);

function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}

function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => loadStoredSettings());

  function persist(next: AppSettings) {
    setSettings(next);
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  }

  return (
    <SettingsContext.Provider
      value={{
        rate: settings.rate,
        currency: settings.currency,
        setRate: (rate) => persist({ ...settings, rate }),
        setCurrency: (currency) => persist({ ...settings, currency })
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

function getRouteSessionId() {
  if (!window.location.pathname.startsWith(SESSION_ROUTE_PREFIX)) return undefined;
  const encodedId = window.location.pathname.slice(SESSION_ROUTE_PREFIX.length);
  if (!encodedId) return undefined;
  return decodeURIComponent(encodedId);
}

function getRoutePage(): AppPage {
  if (window.location.pathname.startsWith('/models')) return 'models';
  if (window.location.pathname.startsWith('/settings')) return 'settings';
  return 'sessions';
}

function sessionUrl(id: string) {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(id)}`;
}

function formatChars(value: number) {
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 100 ? 2 : value < 10_000 ? 1 : 0
  }).format(value / 1000);
  return `${formatted}k chars`;
}

function formatInstructionPath(value: string) {
  if (value.length <= 40) return value;
  const separatorIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const fileNameLength = value.length - separatorIndex - 1;
  const suffixLength = Math.max(42, fileNameLength);
  return `...${value.slice(-suffixLength)}`;
}

export default function App() {
  return (
    <SettingsProvider>
      <AppInner />
    </SettingsProvider>
  );
}

function AppInner() {
  const { rate, currency } = useSettings();
  const [sessions, setSessions] = useState<NormalizedSession[]>([]);
  const [status, setStatus] = useState<LoadState>('loading');
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState(() => loadStoredFilters().workspaceFilter);
  const [page, setPage] = useState<AppPage>(() => getRoutePage());
  const [detailSessionId, setDetailSessionId] = useState<string | undefined>(() => getRouteSessionId());
  const [turns, setTurns] = useState<TurnInfo[]>();
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
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
      setStatus(payload.error ? 'error' : 'ready');
    } catch (caught) {
      if (!hasConnectedRef.current) {
        // API is still starting up (e.g. scanning storage before it opens its port).
        // Keep showing the connecting loader and retry shortly instead of surfacing an error.
        window.setTimeout(() => void loadSessions(), 500);
        return;
      }
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function loadDetail(id: string) {
    setTurns(undefined);
    setOverview(null);
    setTurnsLoading(true);
    try {
      const [turnsRes, overviewRes] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(id)}/turns`),
        fetch(`/api/sessions/${encodeURIComponent(id)}/overview`)
      ]);
      if (!turnsRes.ok) throw new Error(`API returned ${turnsRes.status}`);
      const payload = (await turnsRes.json()) as { turns: TurnInfo[] };
      setTurns(payload.turns);
      if (overviewRes.ok) {
        const ov = (await overviewRes.json()) as SessionOverview;
        setOverview(ov);
      }
    } catch {
      setTurns([]);
    } finally {
      setTurnsLoading(false);
    }
  }

  function openDetail(id: string, updateUrl = true) {
    setDetailSessionId(id);
    setSelectedId(id);
    void loadDetail(id);
    if (updateUrl) {
      window.history.pushState(null, '', sessionUrl(id));
    }
  }

  function navigateToPage(target: AppPage) {
    if (target === page && !detailSessionId) return;
    setPage(target);
    setDetailSessionId(undefined);
    setTurns(undefined);
    setOverview(undefined);
    window.history.pushState(null, '', target === 'models' ? '/models' : target === 'settings' ? '/settings' : '/');
  }

  useEffect(() => {
    void loadSessions();
    const routeSessionId = getRouteSessionId();
    if (routeSessionId) {
      openDetail(routeSessionId, false);
    }
    const interval = window.setInterval(() => void loadSessions(), 5_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    function handlePopState() {
      setPage(getRoutePage());
      const routeSessionId = getRouteSessionId();
      if (routeSessionId) {
        openDetail(routeSessionId, false);
        return;
      }

      setDetailSessionId(undefined);
      setTurns(undefined);
      setOverview(undefined);
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
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

  const modelsPageSessions = useMemo(() => {
    const fromDate = dateFrom ? new Date(dateFrom + 'T00:00:00') : null;
    const toDate = dateTo ? new Date(dateTo + 'T23:59:59') : null;
    return sessions.filter((session) => {
      const updatedAt = new Date(session.updatedAt);
      if (fromDate && updatedAt < fromDate) return false;
      if (toDate && updatedAt > toDate) return false;
      const sessionWorkspace = session.workspaceName ?? session.workspaceStorageId;
      return workspaceFilter === 'all' || sessionWorkspace === workspaceFilter;
    });
  }, [sessions, dateFrom, dateTo, workspaceFilter]);

  const modelRows = useMemo(() => {
    const map = new Map<string, ModelAggregateRow>();
    const ensure = (name: string) => {
      let entry = map.get(name);
      if (!entry) {
        entry = { model: name, aiCredits: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requestCount: 0, sessionCount: 0 };
        map.set(name, entry);
      }
      return entry;
    };
    for (const session of modelsPageSessions) {
      const usedModels = new Set(session.cost.models);
      for (const modelCost of session.cost.perModel) {
        usedModels.add(modelCost.model);
        const entry = ensure(modelCost.model);
        entry.aiCredits += modelCost.aiCredits ?? 0;
        entry.inputTokens += modelCost.inputTokens ?? 0;
        entry.outputTokens += modelCost.outputTokens ?? 0;
        entry.cachedTokens += modelCost.cachedTokens ?? 0;
        entry.requestCount += modelCost.requestCount ?? 0;
      }
      for (const modelName of usedModels) {
        ensure(modelName).sessionCount += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.aiCredits - a.aiCredits || b.requestCount - a.requestCount || a.model.localeCompare(b.model));
  }, [modelsPageSessions]);

  const modelHighlights = useMemo(() => {
    if (modelRows.length === 0) return undefined;
    return {
      mostUsed: [...modelRows].sort((a, b) => b.sessionCount - a.sessionCount || b.requestCount - a.requestCount)[0],
      topAic: [...modelRows].sort((a, b) => b.aiCredits - a.aiCredits)[0],
      topInput: [...modelRows].sort((a, b) => b.inputTokens - a.inputTokens)[0],
      topOutput: [...modelRows].sort((a, b) => b.outputTokens - a.outputTokens)[0]
    };
  }, [modelRows]);

  const modelTotals = useMemo(
    () =>
      modelRows.reduce(
        (acc, row) => ({
          requestCount: acc.requestCount + row.requestCount,
          aiCredits: acc.aiCredits + row.aiCredits,
          inputTokens: acc.inputTokens + row.inputTokens,
          outputTokens: acc.outputTokens + row.outputTokens,
          cachedTokens: acc.cachedTokens + row.cachedTokens
        }),
        { requestCount: 0, aiCredits: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
      ),
    [modelRows]
  );

  const selectedSession = filteredSessions.find((session) => session.id === selectedId) ?? filteredSessions[0];
  const selectedCost = selectedSession?.cost ?? { models: [], perModel: [] };
  const detailSession = sessions.find((s) => s.id === detailSessionId);
  const filteredAiCredits = filteredSessions.reduce((sum, session) => sum + (session.cost.aiCredits ?? 0), 0);

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
    const detailCost = detailSession?.cost ?? { models: [], perModel: [] };
    return (
      <main className="app-shell">
        <AppHeader
          page={page}
          onNavigate={navigateToPage}
          costSummary={
            <div className="cost-summary-pill">
              <Coins size={14} aria-hidden="true" />
              {detailCost.aiCredits !== undefined
                ? <strong>{formatAic(detailCost.aiCredits)} AIC <span className="kc-price">({aicToKc(detailCost.aiCredits, rate)} {currency})</span></strong>
                : <span>No AIC data</span>}
            </div>
          }
        />

        <section className="turns-area">
          {overview && <SessionOverviewPanel overview={overview} />}
          {turnsLoading ? (
            <StateMessage title="Loading turns" detail="Parsing JSONL log file…" />
          ) : turns && turns.length === 0 ? (
            <StateMessage title="No turns found" detail="This session has no debug log or no user messages were recorded." />
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
        </section>
        <Footer />
      </main>
    );
  }

  if (page === 'settings') {
    return (
      <main className="app-shell">
        <AppHeader page={page} onNavigate={navigateToPage} />
        <SettingsPage />
        <Footer />
      </main>
    );
  }

  if (page === 'models') {
    const modelsAiCredits = modelsPageSessions.reduce((sum, session) => sum + (session.cost.aiCredits ?? 0), 0);
    return (
      <main className="app-shell">
        <AppHeader
          page={page}
          onNavigate={navigateToPage}
          costSummary={
            <div className="cost-summary-pill">
              <Coins size={14} aria-hidden="true" />
              <strong>{formatAic(modelsAiCredits)} AIC</strong> <span className="kc-price">({aicToKc(modelsAiCredits, rate)} {currency})</span>
            </div>
          }
        />

        {modelHighlights ? (
          <section className="model-highlights" aria-label="Model usage highlights">
            <div className="model-highlight-card">
              <span className="model-highlight-label">Most Used</span>
              <strong className="model-highlight-value">{modelHighlights.mostUsed.model}</strong>
              <span className="model-highlight-meta">{formatNumber(modelHighlights.mostUsed.sessionCount)} sessions · {formatNumber(modelHighlights.mostUsed.requestCount)} req</span>
            </div>
            <div className="model-highlight-card">
              <span className="model-highlight-label">Top AIC</span>
              <strong className="model-highlight-value">{modelHighlights.topAic.model}</strong>
              <span className="model-highlight-meta">{formatAic(modelHighlights.topAic.aiCredits)} AIC</span>
            </div>
            <div className="model-highlight-card">
              <span className="model-highlight-label">Top Input Tokens</span>
              <strong className="model-highlight-value">{modelHighlights.topInput.model}</strong>
              <span className="model-highlight-meta">{formatNumber(modelHighlights.topInput.inputTokens)} in</span>
            </div>
            <div className="model-highlight-card">
              <span className="model-highlight-label">Top Output Tokens</span>
              <strong className="model-highlight-value">{modelHighlights.topOutput.model}</strong>
              <span className="model-highlight-meta">{formatNumber(modelHighlights.topOutput.outputTokens)} out</span>
            </div>
          </section>
        ) : null}

        <section className="filters" aria-label="Model filters">
          <label className="date-box">
            <Calendar size={17} aria-hidden="true" />
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} title="From date" />
          </label>

          <label className="date-box">
            <Calendar size={17} aria-hidden="true" />
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} title="To date" />
          </label>

          <label className="select-box">
            <Filter size={17} aria-hidden="true" />
            <select value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}>
              <option value="all">All workspaces</option>
              {workspaces.map((ws) => (
                <option key={ws} value={ws}>
                  {ws.length > 25 ? ws.slice(0, 25) + '…' : ws}
                </option>
              ))}
            </select>
          </label>

          <div className="meta-strip" aria-label="Filtered models summary">
            <span className="meta-count">
              <strong>{modelRows.length}</strong>
              <span>models</span>
            </span>
          </div>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="models-table" role="region" aria-label="Model usage list">
          {status === 'loading' ? <StateMessage title="Loading sessions" detail="Scanning local VS Code storage." /> : null}
          {status !== 'loading' && modelRows.length === 0 ? (
            <StateMessage title="No model data found" detail="No sessions with model usage match current filters." />
          ) : null}
          {modelRows.length > 0 ? (
            <div className="models-table-grid">
              <div className="models-row models-row--head">
                <span>Model</span>
                <span>Sessions</span>
                <span>Requests</span>
                <span>AIC</span>
                <span>Price</span>
                <span>Input</span>
                <span>Output</span>
                <span>Cached</span>
              </div>
              {modelRows.map((row) => (
                <div key={row.model} className="models-row">
                  <span className="models-row-name">{row.model}</span>
                  <span>{formatNumber(row.sessionCount)}</span>
                  <span>{formatNumber(row.requestCount)}</span>
                  <span className="models-row-aic">{formatAic(row.aiCredits)}</span>
                  <span className="models-row-price">{aicToKc(row.aiCredits, rate)} {currency}</span>
                  <span>{formatNumber(row.inputTokens)}</span>
                  <span>{formatNumber(row.outputTokens)}</span>
                  <span>{formatNumber(row.cachedTokens)}</span>
                </div>
              ))}
              <div className="models-row models-row--total">
                <span className="models-row-name">Total</span>
                <span>{formatNumber(modelsPageSessions.length)}</span>
                <span>{formatNumber(modelTotals.requestCount)}</span>
                <span className="models-row-aic">{formatAic(modelTotals.aiCredits)}</span>
                <span className="models-row-price">{aicToKc(modelTotals.aiCredits, rate)} {currency}</span>
                <span>{formatNumber(modelTotals.inputTokens)}</span>
                <span>{formatNumber(modelTotals.outputTokens)}</span>
                <span>{formatNumber(modelTotals.cachedTokens)}</span>
              </div>
            </div>
          ) : null}
        </section>
        <Footer />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <AppHeader
        page={page}
        onNavigate={navigateToPage}
        costSummary={
          <div className="cost-summary-pill">
            <Coins size={14} aria-hidden="true" />
            <strong>{formatAic(filteredAiCredits)} AIC</strong> <span className="kc-price">({aicToKc(filteredAiCredits, rate)} {currency})</span>
          </div>
        }
      />

      <section className="filters" aria-label="Session filters">
        <label className="search-box">
          <Search size={17} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" />
        </label>

        <label className="date-box">
          <Calendar size={17} aria-hidden="true" />
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} title="From date" />
        </label>

        <label className="date-box">
          <Calendar size={17} aria-hidden="true" />
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} title="To date" />
        </label>

        <label className="select-box">
          <Filter size={17} aria-hidden="true" />
          <select value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}>
            <option value="all">All workspaces</option>
            {workspaces.map((ws) => (
              <option key={ws} value={ws}>
                {ws.length > 25 ? ws.slice(0, 25) + '…' : ws}
              </option>
            ))}
          </select>
        </label>

        <div className="meta-strip" aria-label="Filtered sessions summary">
          <span className="meta-count">
            <strong>{filteredSessions.length}</strong>
            <span>sessions</span>
          </span>
        </div>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="content-grid">
        <div className="session-table" role="region" aria-label="Session list">
          {status === 'loading' ? <StateMessage title="Loading sessions" detail="Scanning local VS Code storage." /> : null}
          {status !== 'loading' && filteredSessions.length === 0 ? (
            <StateMessage title="No sessions found" detail="Check the storage root or continue a Copilot Chat turn to create local artifacts." />
          ) : null}

          {filteredSessions.map((session) => (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              className={`session-row ${selectedSession?.id === session.id ? 'selected' : ''} ${(session.cost.aiCredits ?? 0) <= 1 ? 'dim' : ''}`}
              onClick={() => setSelectedId(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedId(session.id);
                }
              }}
            >
              <span className="summary-cell">
                <span className="summary-text">
                  <strong>{truncate(session.firstUserMessage ?? 'Untitled session', 60)}</strong>
                  <small>{session.workspaceName ?? session.workspaceStorageId}</small>
                </span>
              </span>
              <span>{formatDateTime(session.updatedAt)}</span>
              <span className="stats-cell">
                <span className="turns-badge">{session.userTurnCount}</span>
                <span className="req-count">{session.cost.requestCount ?? '—'}</span>
              </span>
              <span className="aic-cell">
                {session.cost.aiCredits !== undefined
                  ? <><Coins size={13} aria-hidden="true" />{formatAic(session.cost.aiCredits)}</>
                  : '—'}
              </span>
              <span className="source-cell">
                <SessionSourceIcon session={session} onOpenDetail={() => void openDetail(session.id)} />
              </span>
            </div>
          ))}
        </div>

        <aside className="detail-panel" aria-label="Selected session metadata">
          {selectedSession ? (
            <>
              <div className="detail-heading">
                <h2>{selectedSession.firstUserMessage ?? selectedSession.id}</h2>
              </div>

              <dl>
                <dt>Updated</dt>
                <dd>{formatDateTime(selectedSession.updatedAt)}</dd>
                <dt>Started</dt>
                <dd>{selectedSession.startTime ? formatDateTime(selectedSession.startTime) : 'Unknown'}</dd>
                <dt>Messages</dt>
                <dd>{selectedSession.messageCount}</dd>
                <dt>Source</dt>
                <dd>Copilot Agent Host</dd>
                <dt>Client</dt>
                <dd>{selectedSession.clientName ?? 'Unknown'}</dd>
                {selectedSession.repository ? <><dt>Repository</dt><dd>{selectedSession.repository}</dd></> : null}
                {selectedSession.branch ? <><dt>Branch</dt><dd>{selectedSession.branch}</dd></> : null}
              </dl>

              {selectedSession.dataCompleteness?.warnings.length ? (
                <div className="completeness-warning">{selectedSession.dataCompleteness.warnings.join(' · ')}</div>
              ) : null}

              <section className="cost-panel" aria-label="AI credit usage">
                <div className="cost-heading">
                  <Coins size={17} aria-hidden="true" />
                  <h3>AI Credits</h3>
                </div>
                <div className="cost-total">
                  {selectedCost.aiCredits === undefined ? 'Not reported' : <>{formatAic(selectedCost.aiCredits)} AIC <span className="kc-price">({aicToKc(selectedCost.aiCredits, rate)} {currency})</span></>}
                </div>
                <div className="cost-meta">
                  {(selectedCost.inputTokens || selectedCost.outputTokens || selectedCost.cachedTokens) ? (
                    <table className="token-table">
                      <tbody>
                        {selectedCost.inputTokens ? <tr><td>Input</td><td>{formatNumber(selectedCost.inputTokens)}</td></tr> : null}
                        {selectedCost.outputTokens ? <tr><td>Output</td><td>{formatNumber(selectedCost.outputTokens)}</td></tr> : null}
                        {selectedCost.cachedTokens ? <tr><td>Cached</td><td>{formatNumber(selectedCost.cachedTokens)}</td></tr> : null}
                      </tbody>
                    </table>
                  ) : null}
                  {selectedCost.models.length ? (
                    <span className="cost-models">
                      {selectedCost.models.map((model, index) => {
                        const modelCost = selectedCost.perModel.find((entry) => entry.model === model);
                        return (
                        <span key={model}>
                          {index > 0 ? ', ' : ''}{model}{modelCost?.reasoningEffort ? ` (${modelCost.reasoningEffort})` : ''}
                        </span>
                        );
                      })}
                    </span>
                  ) : null}
                </div>
              </section>

              <div className="path-stack">
                {selectedSession.sourcePaths.transcript ? <PathLine label="Transcript" value={selectedSession.sourcePaths.transcript} /> : null}
                {selectedSession.sourcePaths.debugLog ? <PathLine label="Debug log" value={selectedSession.sourcePaths.debugLog} /> : null}
                {selectedSession.sourcePaths.events ? <PathLine label="Events" value={selectedSession.sourcePaths.events} /> : null}
                {selectedSession.sourcePaths.workspaceMetadata ? <PathLine label="Workspace" value={selectedSession.sourcePaths.workspaceMetadata} /> : null}
                {selectedSession.sourcePaths.sessionStore ? <PathLine label="Session store" value={selectedSession.sourcePaths.sessionStore} /> : null}
                {selectedSession.sourcePaths.customizations ? <PathLine label="Customizations" value={selectedSession.sourcePaths.customizations} /> : null}
              </div>
            </>
          ) : (
            <StateMessage title="Select a session" detail="Click any session row to view turns and AI credit breakdown." />
          )}
        </aside>
      </section>
      <Footer />
    </main>
  );
}

function SessionSourceIcon({ session, onOpenDetail }: { session: NormalizedSession; onOpenDetail: () => void }) {
  const isCli = session.clientName === 'github/cli';
  const label = `Agent Host · ${session.clientName ?? 'unknown client'}`;
  const icon = isCli ? <Terminal size={17} aria-hidden="true" /> : <PanelsTopLeft size={17} aria-hidden="true" />;

  if (!session.hasDetailedEvents) {
    return <span className="source-icon" title={label} aria-label={label} role="img">{icon}</span>;
  }

  return (
    <button
      type="button"
      className="source-icon source-icon--button"
      onClick={(event) => {
        event.stopPropagation();
        onOpenDetail();
      }}
      title={label}
      aria-label={`Open ${label} session detail`}
    >
      {icon}
    </button>
  );
}

function AppHeader({
  page,
  onNavigate,
  costSummary
}: {
  page: AppPage;
  onNavigate: (page: AppPage) => void;
  costSummary?: ReactNode;
}) {
  return (
    <section className="toolbar" aria-label="App header">
      <div className="header-left">
        <div className="title-block">
          <div className="title-row">
            <h1>
              <a
                className="title-home-link"
                href="/"
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate('sessions');
                }}
              >
                Copilot Debugger
              </a>
            </h1>
          </div>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          <button type="button" className={page === 'sessions' ? 'nav-link nav-link-active' : 'nav-link'} onClick={() => onNavigate('sessions')}>
            Sessions
          </button>
          <button type="button" className={page === 'models' ? 'nav-link nav-link-active' : 'nav-link'} onClick={() => onNavigate('models')}>
            Models
          </button>
          <button type="button" className={page === 'settings' ? 'nav-link nav-link-active' : 'nav-link'} onClick={() => onNavigate('settings')}>
            Settings
          </button>
        </nav>
      </div>

      {costSummary ? <div className="toolbar-actions">{costSummary}</div> : null}
    </section>
  );
}

function SettingsPage() {
  const { rate, currency, setRate, setCurrency } = useSettings();
  const [rateInput, setRateInput] = useState(() => String(rate));
  const [currencyInput, setCurrencyInput] = useState(currency);

  function commitRate() {
    const parsed = Number(rateInput.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) {
      setRate(parsed);
    } else {
      setRateInput(String(rate));
    }
  }

  function commitCurrency() {
    const trimmed = currencyInput.trim();
    if (trimmed) {
      setCurrency(trimmed);
    } else {
      setCurrencyInput(currency);
    }
  }

  return (
    <section className="settings-page" aria-label="Settings">
      <div className="settings-card">
        <div className="settings-heading">
          <SettingsIcon size={18} aria-hidden="true" />
          <h2>Price Conversion Settings</h2>
        </div>
        <p className="settings-hint">The rate indicates how many AIC correspond to 1 unit of the selected currency (e.g. AIC / rate = price in currency).</p>

        <label className="settings-field">
          <span>Currency</span>
          <input
            type="text"
            value={currencyInput}
            onChange={(event) => setCurrencyInput(event.target.value)}
            onBlur={commitCurrency}
          />
        </label>

        <label className="settings-field">
          <span>Rate (AIC per 1 {currencyInput || currency})</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={rateInput}
            onChange={(event) => setRateInput(event.target.value)}
            onBlur={commitRate}
          />
        </label>

        <div className="settings-preview-row">
          <div className="settings-preview">
            Example: 1 AIC = {(1 / rate).toFixed(4)} {currency}
            <br />
            Example: 1 {currency} = {rate.toFixed(4)} AIC
          </div>
          <button
            type="button"
            className="settings-set-btn"
            onClick={() => {
              setCurrency('USD');
              setCurrencyInput('USD');
              setRate(100);
              setRateInput('100');
            }}
          >
            Set USD
          </button>
        </div>
      </div>
    </section>
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

function ToolCallRow({
  tc,
  nested,
  turnLabel,
  showTurnColumn,
  model
}: {
  tc: ToolCallInfo;
  nested?: boolean;
  turnLabel?: string;
  showTurnColumn?: boolean;
  model?: string;
}) {
  const hasSubagent = tc.name === 'runSubagent' && !!tc.subagentTurns && tc.subagentTurns.length > 0;

  return (
    <div className={hasSubagent ? 'activity-subagent-wrap activity-subagent-open' : 'activity-subagent-wrap'}>
      <div className={nested ? 'activity-row activity-row-nested' : 'activity-row'}>
        {showTurnColumn ? <span className="activity-label" aria-hidden={turnLabel ? undefined : true}>{turnLabel}</span> : null}
        {model ? <span className="activity-turn-model">{model}</span> : null}
        <span className="activity-label">tool</span>
        <span className={tc.returnedTools?.length ? 'activity-value activity-value-search' : 'activity-value'}>
          <span className="activity-tool-summary">
            <span className="activity-tool-name">{tc.name}</span>
            {tc.detail ? <span className="activity-detail">{tc.detail}</span> : null}
          </span>
          {tc.returnedTools?.length ? (
            <span className="activity-tool-results" title={tc.returnedTools.join(', ')}>
              returned: {tc.returnedTools.join(', ')}
            </span>
          ) : null}
        </span>
        {hasSubagent && (
          <span className="activity-subagent-chip">{tc.subagentName ?? 'subagent'} · {tc.subagentTurns!.length} turns</span>
        )}
      </div>
      {hasSubagent && (
        <div className="activity-subagent-detail">
          {tc.subagentTurns!.map((st) => (
            <AgentTurnActivity key={st.index} turn={st} showModel nested />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentTurnActivity({
  turn,
  showModel,
  nested
}: {
  turn: AgentTurnInfo;
  showModel?: boolean;
  nested?: boolean;
}) {
  const turnLabel = `turn ${turn.index + 1}`;
  const model = showModel ? turn.model ?? '?' : undefined;

  if (turn.toolCalls.length === 0) {
    return (
      <div className={nested ? 'activity-row activity-row-nested' : 'activity-row'}>
        <span className="activity-label">{turnLabel}</span>
        {model ? <span className="activity-turn-model">{model}</span> : null}
      </div>
    );
  }

  return (
    <div className="activity-turn">
      {turn.toolCalls.map((tc, index) => (
        <ToolCallRow
          key={index}
          tc={tc}
          nested={nested}
          turnLabel={index === 0 ? turnLabel : undefined}
          showTurnColumn
          model={index === 0 ? model : undefined}
        />
      ))}
    </div>
  );
}

function TurnCard({ turn }: { turn: TurnInfo }) {
  const { rate, currency } = useSettings();
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
          {turn.aiCredits !== undefined ? <strong>{formatAic(turn.aiCredits)} AIC <span className="kc-price">({aicToKc(turn.aiCredits, rate)} {currency})</span></strong> : <span className="no-aic">—</span>}
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
          {hasActivity && (
            <button type="button" className="turns-toggle" onClick={() => setShowTurns((v) => !v)}>
              {showTurns ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              {showTurns ? 'Hide turns' : 'Show turns'}
            </button>
          )}
        </div>
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

const OVERVIEW_PREVIEW_COUNT = 5;

function SessionOverviewPanel({ overview }: { overview: SessionOverview }) {
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [expandedToolServers, setExpandedToolServers] = useState<Set<string>>(new Set());
  const visibleSkills = skillsExpanded ? overview.skills : overview.skills.slice(0, OVERVIEW_PREVIEW_COUNT);
  const hiddenSkillsCount = overview.skills.length - OVERVIEW_PREVIEW_COUNT;
  const visibleAgents = agentsExpanded ? overview.agents : overview.agents.slice(0, OVERVIEW_PREVIEW_COUNT);
  const hiddenAgentsCount = overview.agents.length - OVERVIEW_PREVIEW_COUNT;
  const mcpTools = overview.tools.filter((t) => t.isMcp);
  const builtinTools = overview.tools.filter((t) => !t.isMcp);
  const mcpServers = [...new Set(mcpTools.map((t) => t.mcpServer ?? 'unknown'))];
  const getServerBytes = (server: string) =>
    server === '__builtin__'
      ? builtinTools.reduce((s, t) => s + t.sizeBytes, 0)
      : mcpTools.filter((t) => (t.mcpServer ?? 'unknown') === server).reduce((s, t) => s + t.sizeBytes, 0);
  const allServers = [...mcpServers, ...(builtinTools.length > 0 ? ['__builtin__'] : [])].sort(
    (a, b) => getServerBytes(b) - getServerBytes(a) || a.localeCompare(b)
  );
  const visibleServers = toolsExpanded ? allServers : allServers.slice(0, OVERVIEW_PREVIEW_COUNT);
  const hiddenCount = allServers.length - OVERVIEW_PREVIEW_COUNT;
  const toggleToolServer = (server: string) => {
    setExpandedToolServers((current) => {
      const next = new Set(current);
      if (next.has(server)) {
        next.delete(server);
      } else {
        next.add(server);
      }
      return next;
    });
  };

  return (
    <div className="session-overview">
      <div className="overview-grid">
        {overview.skills.length > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Skills ({overview.skills.length})</h3>
            <div className="overview-tools-group">
              {visibleSkills.map((skill) => (
                <div key={skill.name} className="overview-mcp-server" title={skill.description}>
                  <span className="mcp-server-name">{skill.name}</span>
                  {skill.sizeChars !== undefined || skill.sizeBytes !== undefined
                    ? <span className="mcp-tool-count">{formatChars(skill.sizeChars ?? skill.sizeBytes ?? 0)}</span>
                    : null}
                </div>
              ))}
              {!skillsExpanded && hiddenSkillsCount > 0 && (
                <button className="overview-tools-expand" onClick={() => setSkillsExpanded(true)}>
                  + {hiddenSkillsCount} more skills
                </button>
              )}
              {skillsExpanded && overview.skills.length > OVERVIEW_PREVIEW_COUNT && (
                <button className="overview-tools-expand" onClick={() => setSkillsExpanded(false)}>
                  Show less
                </button>
              )}
            </div>
          </div>
        )}

        {overview.skillsAvailability === 'unavailable' && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Skills</h3>
            <p className="overview-availability">The skills catalog is not persisted for this session.</p>
          </div>
        )}

        {overview.agentsAvailability === 'unavailable' && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Agents</h3>
            <p className="overview-availability">The agent catalog attached to the LLM context is not persisted for this session.</p>
          </div>
        )}

        {overview.agents.length > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Agents ({overview.agents.length})</h3>
            <div className="overview-tools-group">
              {visibleAgents.map((agent) => (
                <div key={agent.name} className="overview-mcp-server" title={agent.description}>
                  <span className="mcp-server-name">{agent.name}</span>
                  {agent.sizeChars !== undefined || agent.sizeBytes !== undefined
                    ? <span className="mcp-tool-count">{formatChars(agent.sizeChars ?? agent.sizeBytes ?? 0)}</span>
                    : null}
                </div>
              ))}
              {!agentsExpanded && hiddenAgentsCount > 0 && (
                <button className="overview-tools-expand" onClick={() => setAgentsExpanded(true)}>
                  + {hiddenAgentsCount} more agents
                </button>
              )}
              {agentsExpanded && overview.agents.length > OVERVIEW_PREVIEW_COUNT && (
                <button className="overview-tools-expand" onClick={() => setAgentsExpanded(false)}>
                  Show less
                </button>
              )}
            </div>
          </div>
        )}

        {overview.toolsAvailability === 'unavailable' && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Tools</h3>
            <p className="overview-availability">Tool definitions and the MCP server catalog attached to the LLM request are not persisted for this session.</p>
          </div>
        )}

        {overview.tools.length > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">INITIAL TOOLS ({overview.tools.length})</h3>
            <div className="overview-tools-group">
              {visibleServers.map((server) => {
                if (server === '__builtin__') {
                  const builtinChars = builtinTools.reduce((s, t) => s + t.sizeBytes, 0);
                  const builtinDeferred = builtinTools.filter((t) => t.deferred).length;
                  const expanded = expandedToolServers.has(server);
                  return (
                    <div key="__builtin__" className="overview-mcp-server-wrap">
                      <button
                        className="overview-mcp-server overview-mcp-server--builtin"
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => toggleToolServer(server)}
                      >
                        <span className="mcp-server-title">
                          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                          <span className="mcp-server-name">Built-in</span>
                        </span>
                        <span className="mcp-tool-count">
                          {builtinTools.length} tools{builtinDeferred > 0 ? ` · ${builtinDeferred} deferred` : ''} · {formatChars(builtinChars)}
                        </span>
                      </button>
                      {expanded && (
                        <div className="overview-tool-list">
                          {builtinTools.map((tool) => (
                            <div key={tool.name} className={`overview-tool-item${tool.deferred ? ' overview-tool-item--deferred' : ''}`} title={tool.description}>
                              <span className="overview-tool-title">
                                <span className="overview-tool-name">{tool.name}</span>
                                {tool.deferred && (
                                  <span className="overview-tool-deferred" title="Deferred tool">
                                    <Clock3 size={11} aria-hidden="true" /> deferred
                                  </span>
                                )}
                              </span>
                              <span className="overview-tool-meta">
                                <span className="overview-tool-size">{formatChars(tool.sizeBytes)}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
                const serverTools = mcpTools.filter((t) => (t.mcpServer ?? 'unknown') === server);
                const count = serverTools.length;
                const deferredCount = serverTools.filter((t) => t.deferred).length;
                const serverChars = serverTools.reduce((s, t) => s + t.sizeBytes, 0);
                const expanded = expandedToolServers.has(server);
                return (
                  <div key={server} className="overview-mcp-server-wrap">
                    <button
                      className="overview-mcp-server"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleToolServer(server)}
                    >
                      <span className="mcp-server-title">
                        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        <span className="mcp-server-name">{server}</span>
                      </span>
                      <span className="mcp-tool-count">
                        {count} {count === 1 ? 'tool' : 'tools'}{deferredCount > 0 ? ` · ${deferredCount} deferred` : ''} · {formatChars(serverChars)}
                      </span>
                    </button>
                    {expanded && (
                      <div className="overview-tool-list">
                        {serverTools.map((tool) => (
                          <div key={tool.name} className={`overview-tool-item${tool.deferred ? ' overview-tool-item--deferred' : ''}`} title={tool.description}>
                            <span className="overview-tool-title">
                              <span className="overview-tool-name">{tool.name}</span>
                              {tool.deferred && (
                                <span className="overview-tool-deferred" title="Deferred tool">
                                  <Clock3 size={11} aria-hidden="true" /> deferred
                                </span>
                              )}
                            </span>
                            <span className="overview-tool-meta">
                              <span className="overview-tool-size">{formatChars(tool.sizeBytes)}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {!toolsExpanded && hiddenCount > 0 && (
                <button className="overview-tools-expand" onClick={() => setToolsExpanded(true)}>
                  + {hiddenCount} more servers
                </button>
              )}
              {toolsExpanded && allServers.length > OVERVIEW_PREVIEW_COUNT && (
                <button className="overview-tools-expand" onClick={() => setToolsExpanded(false)}>
                  Show less
                </button>
              )}
            </div>
          </div>
        )}

        {(overview.mcpServers?.length ?? 0) > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">MCP servers ({overview.mcpServers!.length})</h3>
            <div className="overview-tools-group">
              {overview.mcpServers!.map((server) => (
                <div
                  key={server.name}
                  className="overview-mcp-server"
                  title={server.documentedTools.length ? `Documented tools: ${server.documentedTools.join(', ')}` : server.name}
                >
                  <span className="mcp-server-name">{server.title ?? server.name}</span>
                  <span className="mcp-tool-count">
                    {server.documentedTools.length ? `${server.documentedTools.length} documented tools` : formatChars(server.instructionBytes)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {overview.mcpServersAvailability === 'unavailable' && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">MCP servers</h3>
            <p className="overview-availability">No session-scoped MCP initialization data was persisted.</p>
          </div>
        )}
      </div>
      {overview.contextSizes && <InitialPromptBar sizes={overview.contextSizes} content={overview.contextContent} instructions={overview.userInstructions} attachments={overview.attachments} />}
    </div>
  );
}

function InitialPromptBar({ sizes, content, instructions, attachments }: { sizes: ContextSizes; content?: Partial<Record<ContextSectionKey, string>>; instructions: InstructionInfo[]; attachments: AttachmentInfo[] }) {
  const [selectedSegment, setSelectedSegment] = useState<{ key: ContextSectionKey; label: string }>();
  const segments = [
    { key: 'system' as const, chars: sizes.systemPromptChars, label: 'System prompt', className: 'ctx-seg--system' },
    { key: 'instructions' as const, chars: sizes.userInstructionsChars, label: 'User instructions', className: 'ctx-seg--instructions' },
    { key: 'agents' as const, chars: sizes.agentDefinitionsChars, label: 'Agent definitions', className: 'ctx-seg--agents' },
    { key: 'skills' as const, chars: sizes.skillDefinitionsChars, label: 'Skill definitions', className: 'ctx-seg--skills' },
    { key: 'tools' as const, chars: sizes.toolDefinitionsChars, label: 'Tool definitions', className: 'ctx-seg--tools' },
    { key: 'mcp' as const, chars: sizes.mcpDefinitionsChars, label: 'MCP definitions', className: 'ctx-seg--mcp' },
    { key: 'conversation' as const, chars: sizes.conversationChars, label: 'Conversation', className: 'ctx-seg--conversation' },
    { key: 'other' as const, chars: sizes.otherChars, label: 'Other', className: 'ctx-seg--other' }
  ].filter((segment) => segment.chars > 0);
  const total = segments.reduce((sum, segment) => sum + segment.chars, 0);

  const pct = (value: number) => total > 0 ? Math.min(100, (value / total) * 100).toFixed(3) : '0';

  useEffect(() => {
    if (!selectedSegment) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedSegment(undefined);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedSegment]);

  return (
    <div className="ctx-window">
      <div className="ctx-window-header">
        <span className="ctx-window-label">Initial prompt</span>
        {sizes.model && <span className="ctx-window-model">{sizes.model}</span>}
        <span className="ctx-window-usage">{formatChars(total)} raw text</span>
      </div>
      <div className="ctx-bar" role="group" aria-label={`Initial prompt: ${formatChars(total)} raw text`}>
        {segments.map((seg) => (
          <button
            type="button"
            key={seg.key}
            className={`ctx-seg ${seg.className}`}
            style={{ width: `${pct(seg.chars)}%` }}
            title={`${seg.label}: ${formatChars(seg.chars)}`}
            aria-label={`Show ${seg.label}, ${formatChars(seg.chars)}`}
            onClick={() => setSelectedSegment({ key: seg.key, label: seg.label })}
          />
        ))}
      </div>
      <div className="ctx-legend">
        {segments.map((seg) =>
          seg.key === 'instructions' && instructions.length > 0 ? (
            <span key={seg.key} className="ctx-legend-item ctx-legend-item--instructions ctx-legend-item--popover">
              <span className="ctx-legend-dot" />
              <span className="ctx-legend-hint">{seg.label}</span> <span className="ctx-legend-val">{formatChars(seg.chars)}</span>
              <div className="ctx-popover">
                <div className="ctx-popover-title">{seg.label} ({instructions.length})</div>
                {instructions.map((instruction, index) => (
                  <div key={`${instruction.path ?? instruction.name}-${index}`} className="ctx-popover-row">
                    <span className="ctx-popover-name" title={instruction.path ?? instruction.name}>
                      {formatInstructionPath(instruction.path ?? instruction.name)}
                    </span>
                    <span className="ctx-popover-size">{formatChars(instruction.sizeChars)}</span>
                  </div>
                ))}
              </div>
            </span>
          ) : seg.key === 'other' && attachments.length > 0 ? (
            <span key={seg.key} className="ctx-legend-item ctx-legend-item--other ctx-legend-item--popover">
              <span className="ctx-legend-dot" />
              <span className="ctx-legend-hint">{seg.label}</span> <span className="ctx-legend-val">{formatChars(seg.chars)}</span>
              <div className="ctx-popover">
                <div className="ctx-popover-title">{seg.label} ({attachments.length})</div>
                {attachments.map((a, i) => (
                  <div key={i} className="ctx-popover-row">
                    <span className="ctx-popover-name">{a.name}</span>
                    <span className="ctx-popover-size">{formatChars(a.sizeBytes)}</span>
                  </div>
                ))}
              </div>
            </span>
          ) : (
            <span key={seg.key} className={`ctx-legend-item ctx-legend-item--${seg.key}`}>
              <span className="ctx-legend-dot" />
              {seg.label} <span className="ctx-legend-val">{formatChars(seg.chars)}</span>
            </span>
          )
        )}
      </div>
      {selectedSegment && (
        <div className="ctx-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedSegment(undefined)}>
          <section className="ctx-modal" role="dialog" aria-modal="true" aria-labelledby="ctx-modal-title">
            <header className="ctx-modal-header">
              <div>
                <h3 id="ctx-modal-title">{selectedSegment.label}</h3>
                <span>{formatChars(content?.[selectedSegment.key]?.length ?? 0)}</span>
              </div>
              <button type="button" className="ctx-modal-close" title="Close" aria-label="Close context detail" onClick={() => setSelectedSegment(undefined)}>
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <pre className="ctx-modal-content">{content?.[selectedSegment.key] || 'No source text was persisted for this section.'}</pre>
          </section>
        </div>
      )}
    </div>
  );
}

function PathLine({ label, value }: { label: string; value: string }) {
  const vscodePath = value.replace(/\\/g, '/');
  return (
    <a href={`vscode://file/${encodeURI(vscodePath)}`} title={value} className="path-link" aria-label={`Open ${label}`}>
      <ExternalLink size={15} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : text.slice(0, max) + '…';
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

function aicToKc(value: number, rate: number) {
  return (value / rate).toFixed(1);
}
