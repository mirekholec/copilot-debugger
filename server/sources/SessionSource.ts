export interface SourceFileInfo {
  transcript?: string;
  debugLog?: string;
}

export interface ModelCostInfo {
  model: string;
  aiCredits?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  requestCount?: number;
}

export interface SessionCostInfo {
  aiCredits?: number;
  aiCreditUnit?: 'AIC';
  aiCreditSource?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  requestCount?: number;
  models: string[];
  perModel: ModelCostInfo[];
}

export interface NormalizedSession {
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
  cost: SessionCostInfo;
}

export interface SessionSourceSnapshot {
  sessions: NormalizedSession[];
  lastRefreshAt?: string;
  error?: string;
}

export interface ToolCallInfo {
  name: string;
  detail?: string;
  inputChars: number;
  outputChars: number;
  // Present when name === 'runSubagent': the nested agent turns executed inside the
  // subagent's own log file (it can run its own LLM requests and tool calls, often
  // on a different model than the parent turn).
  subagentName?: string;
  subagentTurns?: AgentTurnInfo[];
}

// One individual agent LLM call inside a round. A single round (one user message,
// numbered #1, #2... in the UI) can contain several turns, and each turn can use a
// different model - e.g. when the agent hands off work to a subagent running on a
// different model.
export interface AgentTurnInfo {
  index: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  aiCredits?: number;
  timestamp: string;
  toolCalls: ToolCallInfo[];
}

export interface TurnInfo {
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

export interface SkillInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

export interface AgentInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

export interface AttachmentInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  isMcp: boolean;
  deferred?: boolean;
  mcpServer?: string;
  sizeBytes: number;
}

export interface ContextSizes {
  systemPromptTotalBytes: number;
  systemPromptSkillsBytes: number;
  systemPromptAgentsBytes: number;
  systemPromptAttachmentsBytes: number;
  toolsBytes: number;
  userPromptBytes: number;
  maxContextTokens?: number;
  model?: string;
}

export interface SessionOverview {
  skills: SkillInfo[];
  agents: AgentInfo[];
  attachments: AttachmentInfo[];
  tools: ToolInfo[];
  contextSizes?: ContextSizes;
}

export interface SessionSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  listSessions(): SessionSourceSnapshot;
  getSession(id: string): NormalizedSession | undefined;
  getSessionTurns(id: string): Promise<TurnInfo[]>;
  getSessionOverview(id: string): Promise<SessionOverview | undefined>;
}
