/** What happened between a prompt and the main loop's answer. */
export type TurnFacts = {
  startedAt: number
  seconds: number
  tools: number
  /** Files an Edit, Write or NotebookEdit call touched, each once. */
  edits: string[]
  /** True once a Bash command that looks like tests or checks ran. */
  checksRan: boolean
  /** Short labels of the tool calls that came back as errors. */
  failed: string[]
  isAborted: boolean
}

export type AgentStatus = 'running' | 'done' | 'failed'

/** A tool call that has started and not yet returned (waiting for permission counts). */
export type Activity = {
  id: string
  /** The tool with its main argument, such as `Bash: pnpm test` or `Edit register.tsx`. */
  label: string
  startedAt: number
}

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  tokens: number
  /** The tokens split by kind; absent on runs recorded before this field. */
  split?: TokenSplit
  steps: number
  /** Its tool calls in flight; absent on runs recorded before this field. */
  running?: Activity[]
}

/** The heads-up note: one side check over the conversation. */
export type Note =
  | { status: 'checking' }
  | { status: 'shown'; text: string; tokensIn: number; tokensOut: number; shownAt?: number }
  | { status: 'quiet'; tokensIn: number; tokensOut: number }
  | { status: 'unavailable'; reason: string }

export type Totals = {
  turns: number
  checks: number
  checkTokensIn: number
  checkTokensOut: number
}

/** Token counts of one or more model requests, by how the API bills them. */
export type TokenSplit = {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

/** One thing that cost tokens: a main-loop turn, a subagent or a heads-up check. */
export type CostItem = {
  kind: 'turn' | 'subagent' | 'heads-up'
  /** The prompt's first words, the subagent's description, or "heads-up check". */
  label: string
  at: number
  split: TokenSplit
  /** Model requests it made. */
  requests: number
  /** The largest prompt one of its requests sent: the context it carried. */
  peakContext: number
  /** Points the five-hour meter moved while it ran; other sessions running then count too. */
  limitPoints?: number
}

/** A rate-limit window as the last API response reported it; account-wide, not per session. */
export type LimitReading = { kind: string; percentUsed: number; resetsAt?: string; readAt: number }

/** Tokens spent over turns whose start and end both read the same five-hour window. */
export type Calibration = {
  /** Weighted by API price, in uncached-input tokens. */
  weighted: number
  /** As counted, cache reads included. */
  raw: number
  /** Points the meter moved over those turns. */
  points: number
}

/** A session's spend within one five-hour window, its turns', subagents' included. */
export type WindowUse = {
  /** When the window ends, as the meter reports it; empty before a reading. */
  resetsAt: string
  /** Weighted by API price, in uncached-input tokens. */
  weighted: number
  /** Points the meter moved over its turns; others running at once count too. */
  points: number
}

/** One way to spend fewer tokens, with the request that asks Claude to act on it, when it can. */
export type SavingTip = {
  id: string
  text: string
  /** The prompt the "Ask Claude to apply" button puts in the prompt box. */
  apply?: string
}

/** One session's status, written by that session into the store every session shares. */
export type SessionRecord = {
  id: string
  /** The session's name as the app shows it; empty until the engine reports one. */
  title: string
  /** The repository as `owner/name` from its remote, else its root folder's name; empty outside one. */
  project: string
  /** The last folder name of the session's working directory (a worktree's `<type>-<slug>`). */
  folder: string
  isWorking: boolean
  /** Of the running turn when working, else of the last finished one. */
  tools: number
  edits: number
  failed: number
  subagentsRunning: number
  /** When the running turn started; null when idle. Absent on older records. */
  turnStartedAt?: number | null
  /** The main loop's tool calls in flight. */
  running?: Activity[]
  /** The subagents still running, each with its tool calls in flight. */
  subagents?: { description: string; type: string; startedAt: number; running: Activity[] }[]
  /** The last finished turn's reflect lines, joined. */
  reflect: string | null
  /** The desktop app's id for the session (`local_…`); empty outside the app. */
  hostId?: string
  /** The `local_…` ids of the sessions this one started or sent work to: its workers. */
  children?: string[]
  /** Every token this session's main loop, subagents and checks used, by kind. */
  tokens?: TokenSplit
  /** What /cost totals for the session, in US dollars at API prices. */
  costUsd?: number
  /** The costliest recent items, most expensive first, at most COST_ITEMS_MAX. */
  costs?: CostItem[]
  /** The five-hour window as this session last saw it. */
  fiveHour?: LimitReading | null
  /** The weekly window as this session last saw it; absent where the account has none. */
  sevenDay?: LimitReading | null
  /** What this session's turns spent while the meter moved, to tell how much a point holds. */
  calibration?: Calibration
  /** What this session spent in the five-hour window that `resetsAt` ends. */
  windowUse?: WindowUse
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'overview': {
      /** Every session record in the store, this session's included, newest first. */
      sessions: SessionRecord[]
      /** The main loop's tool calls in flight. */
      active: Activity[]
      turn: TurnFacts | null
      last: TurnFacts | null
      agents: AgentRun[]
      note: Note | null
      isBandHidden: boolean
      totals: Totals
      now: number
      /** The `local_…` ids of the sessions this one started or briefed. */
      children: string[]
      /** The running turn's cost so far, moved into `costs` when it ends. */
      turnCost: CostItem | null
      /** Finished turns and heads-up checks, newest last, at most 30. */
      costs: CostItem[]
      /** Session ids whose token detail is open in the pane. */
      expanded: string[]
      calibration: Calibration
      /** How often each tool was called this session, subagents included. */
      toolUse: Record<string, number>
      /** The token-saving suggestions, once asked for; null until then. */
      savings: { status: 'checking' } | { status: 'ready'; tips: SavingTip[] } | null
    }
  }
}
