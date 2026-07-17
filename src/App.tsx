import { Bug, Calendar, ChevronDown, ChevronRight, Clock3, Coins, ExternalLink, Filter, RefreshCw, Search, Settings as SettingsIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface SourceFileInfo {
  transcript?: string;
  debugLog?: string;
}

interface ModelCostInfo {
  model: string;
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

interface ToolAggregateRow {
  name: string;
  description?: string;
  isMcp: boolean;
  mcpServer?: string;
  deferredCount: number;
  connectedSessionCount: number;
  usedSessionCount: number;
  usedTurnCount: number;
  callCount: number;
  inputChars: number;
  outputChars: number;
  sizeBytes: number;
}

interface ToolsAggregateResponse {
  rows: ToolAggregateRow[];
  sessionCount: number;
}

interface NormalizedSession {
  id: string;
  workspaceStorageId: string;
  workspaceName?: string;
  sourcePaths: SourceFileInfo;
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
  inputChars: number;
  outputChars: number;
  subagentName?: string;
  subagentTurns?: AgentTurnInfo[];
}

// One individual agent LLM call inside a round. Models can differ between turns
// within the same round (e.g. a subagent call runs on a different model).
interface AgentTurnInfo {
  index: number;
  model?: string;
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
  sizeBytes: number;
}

interface AgentInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

interface AttachmentInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

interface ToolInfo {
  name: string;
  description: string;
  isMcp: boolean;
  deferred?: boolean;
  mcpServer?: string;
  sizeBytes: number;
}

interface ContextSizes {
  systemPromptTotalBytes: number;
  systemPromptSkillsBytes: number;
  systemPromptAgentsBytes: number;
  systemPromptAttachmentsBytes: number;
  toolsBytes: number;
  userPromptBytes: number;
  maxContextTokens?: number;
  model?: string;
}

interface SessionOverview {
  skills: SkillInfo[];
  agents: AgentInfo[];
  attachments: AttachmentInfo[];
  tools: ToolInfo[];
  contextSizes?: ContextSizes;
}

type LoadState = 'loading' | 'ready' | 'error';

const SESSION_ROUTE_PREFIX = '/sessions/';

type AppPage = 'sessions' | 'tools' | 'models' | 'settings';

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
  if (window.location.pathname.startsWith('/tools')) return 'tools';
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
  return `${formatted} kC`;
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
  const [toolRows, setToolRows] = useState<ToolAggregateRow[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string>();
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
    window.history.pushState(null, '', target === 'tools' ? '/tools' : target === 'models' ? '/models' : target === 'settings' ? '/settings' : '/');
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
        ? [session.id, session.workspaceStorageId, session.workspaceName, session.firstUserMessage, session.producer]
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

  const toolsPageSessions = useMemo(() => {
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

  const toolsPageSessionIds = useMemo(() => toolsPageSessions.map((session) => session.id).join(','), [toolsPageSessions]);

  useEffect(() => {
    if (page !== 'tools' || !hasConnectedRef.current) return;
    const controller = new AbortController();
    const loadTools = async () => {
      setToolsLoading(true);
      setToolsError(undefined);
      try {
        if (!toolsPageSessionIds) {
          setToolRows([]);
          return;
        }
        const params = new URLSearchParams();
        params.set('sessionIds', toolsPageSessionIds);
        const response = await fetch(`/api/tools${params.size ? `?${params}` : ''}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const payload = (await response.json()) as ToolsAggregateResponse;
        setToolRows(payload.rows);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setToolsError(caught instanceof Error ? caught.message : String(caught));
        setToolRows([]);
      } finally {
        if (!controller.signal.aborted) setToolsLoading(false);
      }
    };
    void loadTools();
    return () => controller.abort();
  }, [page, dateFrom, dateTo, workspaceFilter, apiConnecting]);

  const toolHighlights = useMemo(() => {
    if (toolRows.length === 0) return undefined;
    return {
      mostConnected: [...toolRows].sort((a, b) => b.connectedSessionCount - a.connectedSessionCount || a.name.localeCompare(b.name))[0],
      mostCalled: [...toolRows].sort((a, b) => b.callCount - a.callCount || a.name.localeCompare(b.name))[0],
      mostUnused: [...toolRows].sort((a, b) => (b.connectedSessionCount - b.usedSessionCount) - (a.connectedSessionCount - a.usedSessionCount) || a.name.localeCompare(b.name))[0],
      largestContext: [...toolRows].sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name))[0]
    };
  }, [toolRows]);

  const toolTotals = useMemo(
    () =>
      toolRows.reduce(
        (acc, row) => ({
          callCount: acc.callCount + row.callCount,
          usedTurnCount: acc.usedTurnCount + row.usedTurnCount,
          attachedSessionCount: acc.attachedSessionCount + row.connectedSessionCount,
          usedSessionCount: acc.usedSessionCount + row.usedSessionCount
        }),
        { callCount: 0, usedTurnCount: 0, attachedSessionCount: 0, usedSessionCount: 0 }
      ),
    [toolRows]
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
              <ToolTokenAnalysis turns={turns} />
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

  if (page === 'tools') {
    return (
      <main className="app-shell">
        <AppHeader page={page} onNavigate={navigateToPage} />

        {toolHighlights ? (
          <section className="model-highlights" aria-label="Tool usage highlights">
            <div className="model-highlight-card">
              <span className="model-highlight-label">Most Connected</span>
              <strong className="model-highlight-value">{toolHighlights.mostConnected.name}</strong>
              <span className="model-highlight-meta">{formatNumber(toolHighlights.mostConnected.connectedSessionCount)} sessions</span>
            </div>
            <div className="model-highlight-card">
              <span className="model-highlight-label">Most Called</span>
              <strong className="model-highlight-value">{toolHighlights.mostCalled.name}</strong>
              <span className="model-highlight-meta">{formatNumber(toolHighlights.mostCalled.callCount)} calls · {formatNumber(toolHighlights.mostCalled.usedTurnCount)} turns</span>
            </div>
            <div className="model-highlight-card">
              <span className="model-highlight-label">Unused Connections</span>
              <strong className="model-highlight-value">{toolHighlights.mostUnused.name}</strong>
              <span className="model-highlight-meta">{formatNumber(Math.max(0, toolHighlights.mostUnused.connectedSessionCount - toolHighlights.mostUnused.usedSessionCount))} sessions</span>
            </div>
            <div className="model-highlight-card">
              <span className="model-highlight-label">Largest Context</span>
              <strong className="model-highlight-value">{toolHighlights.largestContext.name}</strong>
              <span className="model-highlight-meta">{formatChars(toolHighlights.largestContext.sizeBytes)}</span>
            </div>
          </section>
        ) : null}

        <section className="filters" aria-label="Tool filters">
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

          <div className="meta-strip" aria-label="Filtered tools summary">
            <span className="meta-count">
              <strong>{toolRows.length}</strong>
              <span>tools</span>
            </span>
            <span className="meta-divider" />
            <span className="meta-count">
              <strong>{toolsPageSessions.length}</strong>
              <span>sessions</span>
            </span>
          </div>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}
        {toolsError ? <div className="error-banner">{toolsError}</div> : null}

        <section className="models-table tools-table" role="region" aria-label="Tool usage list">
          {toolsLoading ? <StateMessage title="Loading tools" detail="Parsing tool contexts and turn usage." /> : null}
          {!toolsLoading && toolRows.length === 0 ? (
            <StateMessage title="No tool data found" detail="No sessions with debug tool context match current filters." />
          ) : null}
          {!toolsLoading && toolRows.length > 0 ? (
            <div className="models-table-grid">
              <div className="models-row tools-row tools-row--head">
                <span>Tool</span>
                <span>Server</span>
                <span>Attached</span>
                <span>Used</span>
                <span>% Used</span>
                <span>Turns</span>
                <span>Calls</span>
              </div>
              {toolRows.map((row) => {
                const usagePercent = row.connectedSessionCount > 0 ? (row.usedSessionCount / row.connectedSessionCount) * 100 : 0;
                const isUnused = usagePercent === 0;
                return (
                  <div key={row.name} className={isUnused ? 'models-row tools-row tools-row--unused' : 'models-row tools-row'} title={row.description}>
                    <span className="models-row-name">{row.name}{row.deferredCount > 0 ? <span className="tools-deferred-chip">deferred</span> : null}</span>
                    <span className="tools-row-server">{row.mcpServer ?? (row.isMcp ? 'unknown' : 'Built-in')}</span>
                    <span>{formatNumber(row.connectedSessionCount)}</span>
                    <span>{formatNumber(row.usedSessionCount)}</span>
                    <span className={isUnused ? 'tools-row-unused' : undefined}>{formatPercent(usagePercent)}</span>
                    <span>{formatNumber(row.usedTurnCount)}</span>
                    <span className="models-row-aic">{formatNumber(row.callCount)}</span>
                  </div>
                );
              })}
              <div className="models-row tools-row models-row--total">
                <span className="models-row-name">Total</span>
                <span />
                <span>{formatNumber(toolTotals.attachedSessionCount)}</span>
                <span>{formatNumber(toolTotals.usedSessionCount)}</span>
                <span>{formatPercent(toolTotals.attachedSessionCount > 0 ? (toolTotals.usedSessionCount / toolTotals.attachedSessionCount) * 100 : 0)}</span>
                <span>{formatNumber(toolTotals.usedTurnCount)}</span>
                <span>{formatNumber(toolTotals.callCount)}</span>
              </div>
            </div>
          ) : null}
        </section>
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
            <button
              key={session.id}
              type="button"
              className={`session-row ${selectedSession?.id === session.id ? 'selected' : ''} ${(session.cost.aiCredits ?? 0) <= 1 ? 'dim' : ''}`}
              onClick={() => setSelectedId(session.id)}
            >
              <span className="summary-cell">
                <strong>{truncate(session.firstUserMessage ?? 'Untitled session', 60)}</strong>
                <small>{session.workspaceName ?? session.workspaceStorageId}</small>
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
              <span className="badge-cell">
                {session.hasDebugLog ? (
                  <button
                    type="button"
                    className="debug-badge-btn"
                    onClick={(e) => { e.stopPropagation(); void openDetail(session.id); }}
                    title="Open debug detail"
                  >
                    <Bug size={15} aria-hidden="true" />
                    Debug
                  </button>
                ) : 'Transcript'}
              </span>
            </button>
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
              </dl>

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
                  {selectedCost.models.length ? <span className="cost-models">{selectedCost.models.join(', ')}</span> : null}
                </div>
              </section>

              <div className="path-stack">
                {selectedSession.sourcePaths.transcript ? <PathLine label="Transcript" value={selectedSession.sourcePaths.transcript} /> : null}
                {selectedSession.sourcePaths.debugLog ? <PathLine label="Debug log" value={selectedSession.sourcePaths.debugLog} /> : null}
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
          <button type="button" className={page === 'tools' ? 'nav-link nav-link-active' : 'nav-link'} onClick={() => onNavigate('tools')}>
            Tools
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

function ToolCallRow({ tc, nested }: { tc: ToolCallInfo; nested?: boolean }) {
  const hasSubagent = tc.name === 'runSubagent' && !!tc.subagentTurns && tc.subagentTurns.length > 0;

  return (
    <div className={hasSubagent ? 'activity-subagent-wrap activity-subagent-open' : 'activity-subagent-wrap'}>
      <div className={nested ? 'activity-row activity-row-nested' : 'activity-row'}>
        <span className="activity-label">tool</span>
        <span className="activity-value">
          <span className="activity-tool-name">{tc.name}</span>
          {tc.detail ? <span className="activity-detail">{tc.detail}</span> : null}
        </span>
        {hasSubagent && (
          <span className="activity-subagent-chip">{tc.subagentName ?? 'subagent'} · {tc.subagentTurns!.length} turns</span>
        )}
      </div>
      {hasSubagent && (
        <div className="activity-subagent-detail">
          {tc.subagentTurns!.map((st) => (
            <div key={st.index} className="activity-turn">
              <div className="activity-row activity-row-nested">
                <span className="activity-label">turn {st.index + 1}</span>
                <span className="activity-value">
                  <span className="activity-tool-name">{st.model ?? '?'}</span>
                </span>
              </div>
              {st.toolCalls.map((stc, i) => (
                <ToolCallRow key={i} tc={stc} nested />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TurnCard({ turn }: { turn: TurnInfo }) {
  const { rate, currency } = useSettings();
  const [showTurns, setShowTurns] = useState(false);
  const hasActivity = turn.toolCalls.length > 0 || turn.turns.length > 0;

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
          {turn.inputTokens > 0 ? <span>{formatNumber(turn.inputTokens)} in</span> : null}
          {turn.outputTokens > 0 ? <span>{formatNumber(turn.outputTokens)} out</span> : null}
          {turn.cachedTokens > 0 ? <span>{formatNumber(turn.cachedTokens)} cached</span> : null}
          {turn.llmRequestCount > 0 ? <span>{turn.llmRequestCount} turns</span> : null}
          {turn.models.map((m) => <span key={m} className="model-chip">{m}</span>)}
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
              <div key={t.index} className="activity-turn">
                <div className="activity-row activity-turn-row">
                  <span className="activity-label">turn {t.index + 1}</span>
                  <span className="activity-value">
                    <span className="activity-tool-name">{t.model ?? '?'}</span>
                  </span>
                </div>
                {t.toolCalls.map((tc, i) => (
                  <ToolCallRow key={i} tc={tc} nested />
                ))}
              </div>
            ))
          ) : (
            turn.toolCalls.map((tc, i) => <ToolCallRow key={i} tc={tc} />)
          )}
        </div>
      )}
    </div>
  );
}

function ToolTokenAnalysis({ turns }: { turns: TurnInfo[] }) {
  const rows = useMemo(() => {
    const map = new Map<string, { name: string; calls: number; input: number; output: number }>();
    for (const turn of turns) {
      for (const tool of turn.toolCalls) {
        const current = map.get(tool.name) ?? { name: tool.name, calls: 0, input: 0, output: 0 };
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
          <h3>Tool Usage</h3>
          <p>Size of tool call and result payloads in the debug log.</p>
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
            <span className="tool-token-name">{row.name}</span>
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
                  <span className="mcp-tool-count">{formatChars(skill.sizeBytes)}</span>
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

        {overview.agents.length > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Agents ({overview.agents.length})</h3>
            <div className="overview-tools-group">
              {visibleAgents.map((agent) => (
                <div key={agent.name} className="overview-mcp-server" title={agent.description}>
                  <span className="mcp-server-name">{agent.name}</span>
                  <span className="mcp-tool-count">{formatChars(agent.sizeBytes)}</span>
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

        {overview.tools.length > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Tools ({overview.tools.length})</h3>
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
      </div>
      {overview.contextSizes && <ContextWindowBar sizes={overview.contextSizes} attachments={overview.attachments} />}
    </div>
  );
}

function ContextWindowBar({ sizes, attachments }: { sizes: ContextSizes; attachments: AttachmentInfo[] }) {
  const skillsChars = sizes.systemPromptSkillsBytes;
  const agentsChars = sizes.systemPromptAgentsBytes;
  const attachmentsChars = sizes.systemPromptAttachmentsBytes;
  const otherChars = Math.max(0, sizes.systemPromptTotalBytes - skillsChars - agentsChars - attachmentsChars);
  const toolsChars = sizes.toolsBytes;
  const userChars = sizes.userPromptBytes;
  const totalChars = sizes.systemPromptTotalBytes + toolsChars + userChars;

  const segments = [
    { key: 'other', chars: otherChars, label: 'System', className: 'ctx-seg--other' },
    { key: 'skills', chars: skillsChars, label: 'Skills', className: 'ctx-seg--skills' },
    { key: 'agents', chars: agentsChars, label: 'Agents', className: 'ctx-seg--agents' },
    { key: 'attachments', chars: attachmentsChars, label: 'Instructions', className: 'ctx-seg--attachments' },
    { key: 'tools', chars: toolsChars, label: 'Tools', className: 'ctx-seg--tools' },
    { key: 'user', chars: userChars, label: 'User prompt', className: 'ctx-seg--user' },
  ].filter((s) => s.chars > 0);

  const pct = (chars: number) => totalChars > 0 ? Math.min(100, (chars / totalChars) * 100).toFixed(3) : '0';

  return (
    <div className="ctx-window">
      <div className="ctx-window-header">
        <span className="ctx-window-label">Context window</span>
        {sizes.model && <span className="ctx-window-model">{sizes.model}</span>}
        <span className="ctx-window-usage">{formatChars(totalChars)} total</span>
      </div>
      <div className="ctx-bar" role="img" aria-label={`Context window: ${formatChars(totalChars)}`}>
        {segments.map((seg) => (
          <div
            key={seg.key}
            className={`ctx-seg ${seg.className}`}
            style={{ width: `${pct(seg.chars)}%` }}
            title={`${seg.label}: ${formatChars(seg.chars)}`}
          />
        ))}
      </div>
      <div className="ctx-legend">
        {segments.map((seg) =>
          seg.key === 'attachments' ? (
            <span key={seg.key} className="ctx-legend-item ctx-legend-item--attachments ctx-legend-item--popover">
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

function formatPercent(value: number) {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)}%`;
}

function formatAic(value: number) {
  return value.toFixed(2);
}

function aicToKc(value: number, rate: number) {
  return (value / rate).toFixed(1);
}
