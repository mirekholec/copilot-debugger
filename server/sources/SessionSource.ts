export interface SourceFileInfo {
  transcript?: string;
  debugLog?: string;
  events?: string;
  workspaceMetadata?: string;
  sessionStore?: string;
  customizations?: string;
}

export type SessionSourceKind = 'copilot-agent-host';

export interface SessionDataCompleteness {
  hasEvents: boolean;
  hasWorkspaceMetadata: boolean;
  hasUsageData: boolean;
  warnings: string[];
}

export interface ModelCostInfo {
  model: string;
  reasoningEffort?: string;
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
  workspaceKey?: string;
  workspaceName?: string;
  sourcePaths: SourceFileInfo;
  sourceKind: SessionSourceKind;
  clientName?: string;
  repository?: string;
  branch?: string;
  hostType?: string;
  schemaVersion?: number;
  dataCompleteness?: SessionDataCompleteness;
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
  deferred?: boolean;
  returnedTools?: string[];
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
  reasoningEffort?: string;
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
  sizeBytes?: number;
  sizeChars?: number;
}

export interface AgentInfo {
  name: string;
  description: string;
  path?: string;
  sizeBytes?: number;
  sizeChars?: number;
}

export interface AttachmentInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

export interface InstructionInfo {
  name: string;
  path?: string;
  sizeChars: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  isMcp: boolean;
  deferred?: boolean;
  mcpServer?: string;
  sizeBytes: number;
}

export interface McpServerInfo {
  name: string;
  title?: string;
  instructionBytes: number;
  instructions?: string;
  documentedTools: string[];
}

export type ContextSectionKey = 'system' | 'instructions' | 'agents' | 'skills' | 'tools' | 'mcp' | 'conversation' | 'other';

export type InitialContextSectionKey = 'agents' | 'skills' | 'tools' | 'instructions' | 'other';

export interface InitialContextSection {
  key: InitialContextSectionKey;
  label: string;
  chars: number;
  content: string;
}

export interface InitialContextMessage {
  id: string;
  type: 'system' | 'user';
  label: string;
  chars: number;
  content: string;
  sections?: InitialContextSection[];
}

export interface ContextSizes {
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

export interface ContextWindowSnapshot {
  currentTokens?: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
  model?: string;
  capturedAt?: string;
  /** `usage` is a real model request; `event` and `compaction` are local estimates. */
  source?: 'event' | 'usage' | 'compaction';
}

export interface CurrentContextEntry {
  kind: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'attachments' | 'summary';
  timestamp: string;
  toolName?: string;
  /** UTF-16 offsets of the payload within the detail's content. */
  start: number;
  end: number;
}

export interface CurrentContextDetail {
  key: 'tools' | 'system' | 'agents' | 'skills' | 'instructions' | 'conversation';
  label: string;
  content: string;
  entries?: CurrentContextEntry[];
}

export interface ContextCompaction {
  startedAt?: string;
  completedAt: string;
  trigger?: string;
  messagesRemoved?: number;
  /** The context window right before the compaction. */
  before?: ContextWindowSnapshot;
  beforeDetails?: CurrentContextDetail[];
}

export interface SessionOverview {
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

export interface SessionSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  listSessions(): SessionSourceSnapshot;
  getSession(id: string): NormalizedSession | undefined;
  getSessionTurns(id: string): Promise<TurnInfo[]>;
  getSessionOverview(id: string): Promise<SessionOverview | undefined>;
}
