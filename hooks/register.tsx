// overview: three ideas in one mod.
// - Reflect (after peer-reflect): a band above the prompt after each main turn, built from
//   what the turn actually did (edits without checks, failed calls, failed subagents).
// - Progress (after Savvy Progress): a pane of the session's subagents, tracked passively
//   from spawn, step and completion events, with no tool or prompt added to any request.
// - Heads-up (after You should know): one forked side check over the conversation, run
//   only when asked (or after a long turn when `headsUp` is `auto`), its cost shown.
// - Sessions: each session that runs the mod writes a small status record under its own key
//   in the store every session on the machine shares; the pane lists them, so a controller
//   session sees how its worker sessions are doing.
// Everything but the heads-up check runs locally and costs no tokens.
//
// The subagent tracking (agent.spawn, turn.step, the timer tick, the pane toggle) follows
// savvy-progress, https://github.com/johnnyvizz/claude-kit:
//   MIT License. Copyright (c) 2026 johnnyvizz. Permission is hereby granted, free of charge,
//   to any person obtaining a copy of this software, to deal in it without restriction,
//   provided this notice is kept; the software is provided "as is", without warranty.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRepo } from 'claude-code'

import type {
  Activity,
  AgentRun,
  CostItem,
  LimitReading,
  Note,
  SavingTip,
  SessionRecord,
  TokenSplit,
  Totals,
  TurnFacts,
  WindowUse,
} from '../types'

const PANE = 'overview'
const COMMAND = 'coach'
const KNOWN_KEY = 'known-topics'
const KNOWN_MAX = 30
const AUTO_MIN_TOOLS = 10
const AUTO_GAP_MS = 10 * 60 * 1000
const SESSION_PREFIX = 'session:'
const WRITE_GAP_MS = 1000
const ACTIVITY_MAX = 10
const HEARTBEAT_MS = 60 * 1000
const POLL_MS = 3000
// A working session's card in the pane has its border lit and dimmed in turn, this long each.
const BLINK_MS = 1000
// Live sessions write at least once a heartbeat; older records are shown as stale, then pruned.
const STALE_MS = 3 * 60 * 1000
const PRUNE_MS = 24 * 60 * 60 * 1000
// How often the session's name is looked up again, to follow a rename.
const TITLE_GAP_MS = 30 * 1000
const COST_ITEMS_MAX = 10
// Enough to cover a busy five-hour window, which the limit share sums.
const COSTS_KEPT = 120
const CHILDREN_MAX = 20
// The tools a controller starts or briefs another session with; their input or result names it.
const BRIEF_TOOL = /^(mcp__ccd_session__start_session|SendMessage|mcp__ccd_session_mgmt__send_message|mcp__ccd_session_mgmt__clear_session)$/
const HOST_ID = /local_[0-9a-f][0-9a-f-]{7,}/g
// A context this large is worth a /compact or a fresh session.
const LARGE_CONTEXT = 150_000

const turn = atom({ plugin: 'overview', key: 'turn' } as const, null)
const last = atom({ plugin: 'overview', key: 'last' } as const, null)
const agents = atom({ plugin: 'overview', key: 'agents' } as const, [])
const note = atom({ plugin: 'overview', key: 'note' } as const, null)
const isBandHidden = atom({ plugin: 'overview', key: 'isBandHidden' } as const, false)
const totals = atom({ plugin: 'overview', key: 'totals' } as const, {
  turns: 0,
  checks: 0,
  checkTokensIn: 0,
  checkTokensOut: 0,
})
const now = atom({ plugin: 'overview', key: 'now' } as const, 0)
const sessions = atom({ plugin: 'overview', key: 'sessions' } as const, [])
const active = atom({ plugin: 'overview', key: 'active' } as const, [])
const children = atom({ plugin: 'overview', key: 'children' } as const, [])
const turnCost = atom({ plugin: 'overview', key: 'turnCost' } as const, null)
const costs = atom({ plugin: 'overview', key: 'costs' } as const, [])
const expanded = atom({ plugin: 'overview', key: 'expanded' } as const, [])
const toolUse = atom({ plugin: 'overview', key: 'toolUse' } as const, {})
const savings = atom({ plugin: 'overview', key: 'savings' } as const, null)
const calibration = atom({ plugin: 'overview', key: 'calibration' } as const, { weighted: 0, raw: 0, points: 0 })

// Set again by session.start after every reload.
let selfId = ''
let hostId = ''
// The five-hour meter when the running turn started, to tell how far the turn moved it.
let turnLimitStart: LimitReading | null = null
let statusLine: string | undefined
// The status line last pinned, so an unchanged one is not pinned again.
// What the subagents had spent when the running turn started; theirs counts toward the turn's move.
let turnAgentStart: TokenSplit = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
let folder = ''
let title = ''
let project = ''
let lastTitleReadAt = 0
let lastWriteAt = 0
let isWritePending = false

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const CHECK_COMMAND = /\b(test|tests|vitest|jest|pytest|playwright|verify|tsc|typecheck|lint|eslint|cargo check|go vet)\b/i
const SENSITIVE_PATH = /(^|[\\/])(\.env(\.|$)|.*secret|.*credential|id_rsa)/i

const blankTurn = (startedAt: number): TurnFacts => ({
  startedAt,
  seconds: 0,
  tools: 0,
  edits: [],
  checksRan: false,
  failed: [],
  isAborted: false,
})

const field = (e: object, name: string): string => {
  const v = (e as Record<string, unknown>)[name]
  return typeof v === 'string' ? v : ''
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

// `owner/name` from a remote such as git@github.com:owner/name.git, else the root's folder name.
const projectName = (repo: SessionRepo | null): string => {
  if (!repo) return ''
  const parts = (repo.remote ?? '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : baseName(repo.root)
}

// What a tool call is doing, in a few words: the tool and its main argument.
const activityLabel = (e: object): string => {
  const tool = String((e as { tool?: unknown }).tool)
  const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `${mcp[2]} (${mcp[1]})`
  if (tool === 'Bash' || tool === 'PowerShell') return `${tool}: ${clip(field(e, 'command').replace(/\s+/g, ' '), 60)}`
  if (tool === 'Agent' || tool === 'Task') return `Agent: ${clip(field(e, 'description'), 50)}`
  const path = field(e, 'file_path') || field(e, 'notebook_path')
  if (path) return `${tool} ${baseName(path)}`
  const arg = field(e, 'pattern') || field(e, 'url') || field(e, 'query') || field(e, 'skill')
  return arg ? `${tool} ${clip(arg, 40)}` : tool
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
      : String(Math.round(n))

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const fmtUntil = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** A moment on the local wall clock, hh:mm:ss; `offset` is minutes behind UTC, as Date's getTimezoneOffset gives it. */
export const fmtClock = (ms: number, offset = new Date(ms).getTimezoneOffset()): string =>
  new Date(ms - offset * 60000).toISOString().slice(11, 19)

const noTokens = (): TokenSplit => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const addUsage = (s: TokenSplit, u: Usage): TokenSplit => ({
  input: s.input + (u.input_tokens || 0),
  cacheWrite: s.cacheWrite + (u.cache_creation_input_tokens || 0),
  cacheRead: s.cacheRead + (u.cache_read_input_tokens || 0),
  output: s.output + (u.output_tokens || 0),
})

const addSplit = (a: TokenSplit, b: TokenSplit): TokenSplit => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
})

const tokenSum = (s: TokenSplit): number => s.input + s.cacheWrite + s.cacheRead + s.output

// What the tokens cost relative to each other, in uncached-input tokens, by the API's price ratios:
// a cache write is 1.25 times an input token, a cache read a tenth, an output token five times.
const weight = (s: TokenSplit): number => s.input + 1.25 * s.cacheWrite + 0.1 * s.cacheRead + 5 * s.output

const promptSize = (u: Usage): number =>
  (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

// A turn's label: the prompt's first words, with the app's own tagged blocks taken out.
// A turn that only the app started (a worker's report, a reminder) is named for what started it.
export const snippet = (text: string): string => {
  if (/<side-sessions-event>/.test(text)) return '(report from a worker session)'
  const flat = text
    .replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat && text.trim()) return '(automatic turn)'
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat || '(empty prompt)'
}

const splitLine = (s: TokenSplit): string =>
  `in ${fmtTokens(s.input)} · cache write ${fmtTokens(s.cacheWrite)} · cache read ${fmtTokens(s.cacheRead)} · out ${fmtTokens(s.output)}`

async function readLimit($: EngineInterface): Promise<LimitReading | null> {
  try {
    const u = await $.session.usage()
    const five = u.rateLimits.find(r => r.kind === 'five_hour')
    return five ? { kind: five.kind, percentUsed: five.percentUsed, resetsAt: five.resetsAt, readAt: await $.clock.now() } : null
  } catch {
    return null
  }
}

// Points the meter moved between two readings of the same window; unknown across a reset.
const limitPoints = (from: LimitReading | null, to: LimitReading | null): number | undefined =>
  from && to && from.resetsAt === to.resetsAt ? Math.max(0, Math.round((to.percentUsed - from.percentUsed) * 10) / 10) : undefined

const agentsSpent = (runs: readonly AgentRun[]): TokenSplit =>
  runs.reduce((s, a) => addSplit(s, a.split ?? { ...noTokens(), input: a.tokens }), noTokens())

// Fewer measured points than this and one rounding of the meter swings the estimate too far.
const ESTIMATE_MIN_POINTS = 2

export type LimitEstimate =
  | { isReady: true; points: number; weightedPerPoint: number; rawPerPoint: number; weightedLeft: number; rawLeft: number }
  | { isReady: false; points: number }

/**
 * How many tokens the rest of the five-hour window holds, from what the listed sessions spent per
 * point the meter moved. Sessions running at once each count the whole move, so a point reads
 * smaller than it is and the estimate errs low.
 */
export function estimateLeft(records: readonly SessionRecord[], percentUsed: number): LimitEstimate {
  const c = records.reduce(
    (sum, s) => ({
      weighted: sum.weighted + (s.calibration?.weighted ?? 0),
      raw: sum.raw + (s.calibration?.raw ?? 0),
      points: sum.points + (s.calibration?.points ?? 0),
    }),
    { weighted: 0, raw: 0, points: 0 },
  )
  if (c.points < ESTIMATE_MIN_POINTS) return { isReady: false, points: c.points }
  const left = Math.max(0, 100 - percentUsed)
  const weightedPerPoint = c.weighted / c.points
  const rawPerPoint = c.raw / c.points
  return { isReady: true, points: c.points, weightedPerPoint, rawPerPoint, weightedLeft: weightedPerPoint * left, rawLeft: rawPerPoint * left }
}

/**
 * How much of the five-hour limit a session used in the current window, in percent: its spend
 * there over what a point holds, else the points its turns saw the meter move.
 */
export function limitShare(s: SessionRecord, reading: LimitReading | undefined, estimate: LimitEstimate): number | undefined {
  if (!reading?.resetsAt || s.windowUse?.resetsAt !== reading.resetsAt) return undefined
  return estimate.isReady ? s.windowUse.weighted / estimate.weightedPerPoint : s.windowUse.points
}

const WINDOW_MS = 5 * 60 * 60 * 1000

/** What the items that started inside the five-hour window ending at `resetsAt` spent. */
export function spentInWindow(items: readonly CostItem[], resetsAt: string): WindowUse {
  const start = Date.parse(resetsAt) - WINDOW_MS
  const inside = items.filter(i => i.at >= start)
  return {
    resetsAt,
    weighted: inside.reduce((n, i) => n + weight(i.split), 0),
    points: inside.reduce((n, i) => n + (i.limitPoints ?? 0), 0),
  }
}

const fmtShare = (pct: number): string =>
  pct < 0.1 ? '<0.1%' : pct < 10 ? `${(Math.round(pct * 10) / 10).toFixed(1)}%` : `${Math.round(pct)}%`

/** The newest five-hour reading any listed session took. */
const newestLimit = (records: readonly SessionRecord[]): LimitReading | undefined =>
  records
    .map(s => s.fiveHour)
    .filter((r): r is LimitReading => !!r)
    .sort((a, b) => b.readAt - a.readAt)[0]

/** The newest weekly reading any listed session took. */
const newestWeekly = (records: readonly SessionRecord[]): LimitReading | undefined =>
  records
    .map(s => s.sevenDay)
    .filter((r): r is LimitReading => !!r)
    .sort((a, b) => b.readAt - a.readAt)[0]

export type LimitCard = { title: string; percentUsed: number; lines: string[] }

/**
 * The cards under the prompt: the five-hour window, with the tokens it has left and how long until
 * it resets and at what local time, and the weekly window when the account reports one. The desktop app cuts the line
 * short at its right end, so the words are short and the tokens left comes before the reset.
 */
export function limitCards(records: readonly SessionRecord[], at: number): LimitCard[] {
  const cards: LimitCard[] = []
  const five = newestLimit(records)
  const until = (r: LimitReading) => (r.resetsAt ? Date.parse(r.resetsAt) - at : NaN)
  if (five) {
    const left = until(five)
    const estimate = estimateLeft(records, five.percentUsed)
    cards.push(
      left <= 0
        ? { title: '5h', percentUsed: 0, lines: ['just reset'] }
        : {
            title: '5h',
            percentUsed: five.percentUsed,
            lines: [
              estimate.isReady
                ? `≈${fmtTokens(estimate.weightedLeft)} left`
                : `≈? left (${estimate.points}/${ESTIMATE_MIN_POINTS} points measured)`,
              Number.isFinite(left) ? `resets ${fmtUntil(left)} (${fmtClock(at + left)})` : '',
            ].filter(Boolean),
          },
    )
  }
  const week = newestWeekly(records)
  if (week) {
    const left = until(week)
    cards.push(
      left <= 0
        ? { title: 'Week', percentUsed: 0, lines: ['just reset'] }
        : { title: 'Week', percentUsed: week.percentUsed, lines: Number.isFinite(left) ? [`resets ${fmtUntil(left)}`] : [] },
    )
  }
  return cards
}

// The status line is plain text everywhere, so emphasis comes from Unicode's sans-serif bold and
// italic letters and the combining low line, which every surface draws as ordinary characters.
const shiftLetters = (text: string, upper: number, lower: number, digit?: number): string =>
  [...text]
    .map(ch => {
      const c = ch.codePointAt(0) ?? 0
      if (c >= 65 && c <= 90) return String.fromCodePoint(upper + c - 65)
      if (c >= 97 && c <= 122) return String.fromCodePoint(lower + c - 97)
      if (digit !== undefined && c >= 48 && c <= 57) return String.fromCodePoint(digit + c - 48)
      return ch
    })
    .join('')

export const boldText = (text: string): string => shiftLetters(text, 0x1d5d4, 0x1d5ee, 0x1d7ec)
/** Italic letters; digits stay upright, as Unicode has no italic digits. */
export const italicText = (text: string): string => shiftLetters(text, 0x1d608, 0x1d622)
export const underlineText = (text: string): string => [...text].map(ch => (ch === ' ' ? ch : `${ch}̲`)).join('')

// The reset time is when to come back, in italics; the tokens left is the figure to plan by, underlined.
const styleLine = (line: string): string =>
  line.startsWith('resets ') ? italicText(line) : /^≈\d.* left$/.test(line) ? underlineText(line) : line

/** A session card's border: a working session's blinks cyan, lit and dimmed a second each; a stale one is dim. */
export function cardBorder(s: { isWorking: boolean; isStale: boolean; roleColor: string }, at: number): { color: string; isDim: boolean } {
  if (s.isStale) return { color: 'gray', isDim: true }
  if (!s.isWorking) return { color: s.roleColor, isDim: false }
  const isLit = Math.floor(at / BLINK_MS) % 2 === 0
  return isLit ? { color: 'cyan', isDim: false } : { color: 'gray', isDim: true }
}

/** The line under the prompt in every session: each limit on one line, side by side. */
export function limitLine(records: readonly SessionRecord[], at: number): string | undefined {
  const cards = limitCards(records, at)
  if (cards.length === 0) return undefined
  return cards
    .map(c => [`${boldText(c.title)} ${boldText(`${c.percentUsed}%`)}`, ...c.lines.map(styleLine)].join(' · '))
    .join(' │ ')
}

/** Plain hints from where the tokens went, for an optimization plan. */
export function costTips(items: readonly CostItem[], total: TokenSplit): string[] {
  const tips: string[] = []
  const big = items.filter(i => i.peakContext >= LARGE_CONTEXT)
  if (big.length > 0) {
    tips.push(`${plural(big.length, 'item')} carried ${fmtTokens(LARGE_CONTEXT)}+ of context per request: /compact, or start a fresh session for the next task`)
  }
  const w = weight(total)
  if (w > 0 && (1.25 * total.cacheWrite) / w > 0.4) {
    tips.push('Cache writes are the largest cost: long pauses let the prompt cache lapse, so the context is paid again')
  }
  const agentShare = items.filter(i => i.kind === 'subagent').reduce((n, i) => n + weight(i.split), 0)
  if (w > 0 && agentShare / w > 0.5) tips.push('Subagents cost more than the main loop: give them narrower briefs or a smaller model')
  const checkShare = items.filter(i => i.kind === 'heads-up').reduce((n, i) => n + weight(i.split), 0)
  if (w > 0 && checkShare / w > 0.2) tips.push('Heads-up checks are a large share: run them less often')
  return tips.slice(0, 3)
}

/** What the savings check reads: the context as /context breaks it down, and what the session did. */
export type SavingInput = {
  mcpTools: readonly { serverName: string; tokens: number; isLoaded: boolean }[]
  memoryFiles: readonly { path: string; tokens: number }[]
  toolUse: Readonly<Record<string, number>>
  contextTokens: number
  contextPercent: number
  items: readonly CostItem[]
}

// Below these a suggestion would save too little to be worth the change.
const IDLE_SCHEMA_MIN = 1000
const MEMORY_FILE_MIN = 4000
const LONG_OUTPUT = 1200

/** Ways this session could spend fewer tokens, each from a measured fact, most saving first. */
export function savingTips(s: SavingInput): SavingTip[] {
  const tips: SavingTip[] = []
  const used = new Set(Object.keys(s.toolUse).map(name => /^mcp__(.+?)__/.exec(name)?.[1] ?? ''))
  // The app's own servers (`ccd_…`) drive the app itself and are never worth turning off.
  const idle = new Map<string, number>()
  for (const t of s.mcpTools) {
    if (!t.isLoaded || t.tokens <= 0 || t.serverName.startsWith('ccd_') || used.has(t.serverName)) continue
    idle.set(t.serverName, (idle.get(t.serverName) ?? 0) + t.tokens)
  }
  const idleTokens = [...idle.values()].reduce((n, v) => n + v, 0)
  if (idleTokens >= IDLE_SCHEMA_MIN) {
    const names = [...idle.keys()].join(', ')
    tips.push({
      id: 'idle-mcp',
      text: `Unused tools: ${names} put ${fmtTokens(idleTokens)} of tool schemas into every request, and none of their tools ran this session. Turn them off for this session.`,
      apply: `Turn off these MCP servers for this session, since none of their tools ran: ${names}. If you cannot turn one off yourself, tell me where I can.`,
    })
  }
  if (s.contextTokens >= LARGE_CONTEXT || s.contextPercent >= 60) {
    tips.push({
      id: 'context',
      text: `Large context: ${fmtTokens(s.contextTokens)} (${s.contextPercent}% of the window) is read again by every request. Compact it now, or start a fresh session for the next task.`,
      apply: '/compact',
    })
  }
  const turns = s.items.filter(i => i.kind === 'turn')
  const requests = turns.reduce((n, i) => n + i.requests, 0)
  const output = turns.reduce((n, i) => n + i.split.output, 0)
  if (requests >= 3 && output / requests >= LONG_OUTPUT) {
    tips.push({
      id: 'long-answers',
      text: `Long replies: ${fmtTokens(output / requests)} output tokens per request on average, and an output token costs five input tokens. Ask for shorter answers.`,
      apply: 'For the rest of this session keep replies short: the result first, then only what I need to act on, with no recap of what you did.',
    })
  }
  const all = s.items.reduce((n, i) => n + weight(i.split), 0)
  const agentShare = s.items.filter(i => i.kind === 'subagent').reduce((n, i) => n + weight(i.split), 0)
  if (all > 0 && agentShare / all > 0.4) {
    tips.push({
      id: 'subagents',
      text: `Subagents: ${Math.round((agentShare / all) * 100)}% of this session's cost. Narrower briefs and a smaller model for searches cost less.`,
      apply: 'For the rest of this session, give subagents narrow briefs, and run search or read-only subagents on Haiku.',
    })
  }
  const memory = [...s.memoryFiles].sort((a, b) => b.tokens - a.tokens)[0]
  if (memory && memory.tokens >= MEMORY_FILE_MIN) {
    tips.push({
      id: 'memory',
      text: `Instructions file: ${baseName(memory.path)} is ${fmtTokens(memory.tokens)} in every request. A shorter version saves that each time.`,
      apply: `Suggest a shorter version of ${memory.path} that keeps every rule it sets. Show me the change and do not write it until I agree.`,
    })
  }
  const checkShare = s.items.filter(i => i.kind === 'heads-up').reduce((n, i) => n + weight(i.split), 0)
  if (all > 0 && checkShare / all > 0.2) {
    tips.push({ id: 'heads-up', text: 'Heads-up checks: a large share of the cost. Run them only when a turn did a lot.' })
  }
  return tips
}

// Reads the context breakdown locally (`summary` sends no request) and stores the suggestions.
async function checkSavings($: EngineInterface): Promise<void> {
  await update($, savings, () => ({ status: 'checking' as const }))
  let input: SavingInput = { mcpTools: [], memoryFiles: [], toolUse: {}, contextTokens: 0, contextPercent: 0, items: [] }
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    const current = await read($, turnCost)
    const runs = await read($, agents)
    input = {
      mcpTools: b?.mcpTools ?? [],
      memoryFiles: b?.memoryFiles ?? [],
      toolUse: await read($, toolUse),
      contextTokens: u.context.tokens ?? 0,
      contextPercent: u.context.percent ?? 0,
      items: [
        ...(await read($, costs)),
        ...(current ? [current] : []),
        ...runs.map(
          (a): CostItem => ({
            kind: 'subagent',
            label: a.description,
            at: a.startedAt,
            split: a.split ?? { ...noTokens(), input: a.tokens },
            requests: a.steps,
            peakContext: 0,
          }),
        ),
      ],
    }
  } catch {
    // Without a breakdown the check still reads what the session did.
  }
  await update($, savings, () => ({ status: 'ready' as const, tips: savingTips(input) }))
}

/** The reflection lines for a finished turn: evidence first, then the questions it raises. */
export function reflect(t: TurnFacts, runs: readonly AgentRun[]): string[] {
  const lines: string[] = []
  if (t.isAborted) lines.push('Turn was interrupted: check what was left half done')
  if (t.edits.length > 0 && !t.checksRan) {
    lines.push(`Edited ${plural(t.edits.length, 'file')}, no tests or checks ran`)
  }
  if (t.failed.length > 0) {
    lines.push(`${plural(t.failed.length, 'tool call')} failed (${t.failed.slice(0, 2).join(', ')})`)
  }
  const failedAgents = runs.filter(a => a.status === 'failed' && a.startedAt >= t.startedAt)
  if (failedAgents.length > 0) lines.push(`${plural(failedAgents.length, 'subagent')} failed`)
  const sensitive = t.edits.filter(p => SENSITIVE_PATH.test(p))
  if (sensitive.length > 0) lines.push(`Touched a sensitive file: ${baseName(sensitive[0] ?? '')}`)
  if (t.edits.length > 0) lines.push('Edge cases and unrelated changes checked?')
  if (lines.length === 0) {
    lines.push(`Nothing to flag: ${plural(t.tools, 'tool call')} in ${fmtTime(t.seconds * 1000)}`)
  }
  return lines.slice(0, 3)
}

const HEADS_UP_PROMPT = (known: readonly string[]) =>
  [
    'Side check, not part of the task. Do not use any tool and do not continue the work.',
    'Reread the conversation and name the ONE thing the user should know but might have missed:',
    'a tradeoff chosen without saying so, an assumption that may be wrong, a result that may be off,',
    'or a failed step that was glossed over.',
    'Reply with one plain sentence of at most 30 words, with no preamble.',
    'If nothing is worth the user\'s attention, reply with exactly: NONE',
    known.length > 0 ? `Do not repeat any of these, which the user already knows:\n- ${known.join('\n- ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

let isChecking = false
let lastAutoAt = 0

async function runHeadsUp($: EngineInterface): Promise<Note> {
  if (isChecking) return (await read($, note)) ?? { status: 'checking' }
  isChecking = true
  try {
    await update($, note, () => ({ status: 'checking' }))
    await update($, isBandHidden, () => false)
    const known = ((await $.store.get(KNOWN_KEY)) as string[] | undefined) ?? []
    const r = await $.model.fork({ prompt: HEADS_UP_PROMPT(known) })
    let result: Note
    if (r.isAnswered) {
      const tokensIn = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
      const tokensOut = r.usage.output_tokens
      await update($, totals, t => ({
        ...t,
        checks: t.checks + 1,
        checkTokensIn: t.checkTokensIn + tokensIn,
        checkTokensOut: t.checkTokensOut + tokensOut,
      }))
      const at = await $.clock.now()
      const check: CostItem = {
        kind: 'heads-up',
        label: 'heads-up check',
        at,
        split: addUsage(noTokens(), r.usage),
        requests: 1,
        peakContext: promptSize(r.usage),
      }
      await update($, costs, list => [...list, check].slice(-COSTS_KEPT))
      const text = (r.text.trim().split('\n')[0] ?? '').trim()
      result = /^NONE\.?$/i.test(text) || text === ''
        ? { status: 'quiet', tokensIn, tokensOut }
        : { status: 'shown', text: text.slice(0, 300), tokensIn, tokensOut, shownAt: at }
    } else {
      const reason =
        r.reason === 'nothing-to-fork'
          ? 'nothing to check yet: wait for a turn to finish'
          : r.reason === 'api-error'
            ? `the request failed (${r.error})`
            : r.reason === 'empty-reply'
              ? 'the check came back empty'
              : 'the check was cut short'
      result = { status: 'unavailable', reason }
    }
    await update($, note, () => result)
    await writeSelf($, true)
    return result
  } catch {
    const result: Note = { status: 'unavailable', reason: 'the check hit an error' }
    await update($, note, () => result)
    return result
  } finally {
    isChecking = false
  }
}

async function markKnown($: EngineInterface, text: string): Promise<void> {
  const known = ((await $.store.get(KNOWN_KEY)) as string[] | undefined) ?? []
  await $.store.set(KNOWN_KEY, [...known.filter(k => k !== text), text].slice(-KNOWN_MAX))
  await update($, note, () => null)
}

async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await refreshSessions($)
  await $.ui.open({ id: PANE, title: 'Overview' })
  return true
}

// Writes this session's record. `force` skips the throttle (turn start and end, heartbeat);
// a throttled call leaves one write pending, so the record always ends on the latest state.
async function writeSelf($: EngineInterface, force: boolean): Promise<void> {
  if (!selfId) return
  const at = await $.clock.now()
  if (!force && at - lastWriteAt < WRITE_GAP_MS) {
    if (!isWritePending) {
      isWritePending = true
      $.clock.after(WRITE_GAP_MS, () => {
        isWritePending = false
        void writeSelf($, true)
      })
    }
    return
  }
  lastWriteAt = at
  const live = await read($, turn)
  const done = await read($, last)
  const runs = await read($, agents)
  const inFlight = await read($, active)
  const shown = live ?? done
  const subagentsNow = runs.filter(a => a.status === 'running')
  const current = await read($, turnCost)
  const agentItems = runs.map(
    (a): CostItem => ({
      kind: 'subagent',
      label: `${a.type}: ${a.description}`,
      at: a.startedAt,
      split: a.split ?? { ...noTokens(), input: a.tokens },
      requests: a.steps,
      peakContext: 0,
    }),
  )
  const items = [...(await read($, costs)), ...(current ? [current] : []), ...agentItems]
  const spent = items.reduce((s, i) => addSplit(s, i.split), noTokens())
  const usage = await $.session.usage().catch(() => null)
  const five = usage?.rateLimits.find(r => r.kind === 'five_hour')
  const week = usage?.rateLimits.find(r => r.kind === 'seven_day')
  const record: SessionRecord = {
    id: selfId,
    title,
    project,
    folder,
    isWorking: live !== null,
    tools: shown?.tools ?? 0,
    edits: shown?.edits.length ?? 0,
    failed: shown?.failed.length ?? 0,
    subagentsRunning: subagentsNow.length,
    turnStartedAt: live?.startedAt ?? null,
    running: inFlight,
    subagents: subagentsNow.slice(-ACTIVITY_MAX).map(a => ({
      description: a.description,
      type: a.type,
      startedAt: a.startedAt,
      running: a.running ?? [],
    })),
    reflect: done ? reflect(done, runs).join(' · ') : null,
    hostId,
    children: await read($, children),
    tokens: spent,
    costUsd: usage?.cost?.usd,
    costs: [...items].sort((a, b) => weight(b.split) - weight(a.split)).slice(0, COST_ITEMS_MAX),
    fiveHour: five ? { kind: five.kind, percentUsed: five.percentUsed, resetsAt: five.resetsAt, readAt: at } : null,
    sevenDay: week ? { kind: week.kind, percentUsed: week.percentUsed, resetsAt: week.resetsAt, readAt: at } : null,
    calibration: await read($, calibration),
    windowUse: five?.resetsAt ? spentInWindow(items, five.resetsAt) : undefined,
    updatedAt: at,
  }
  await $.store.set(SESSION_PREFIX + selfId, record)
}

// Changes the in-flight list of the main loop, or of the subagent `agentId` names.
async function trackActivity(
  $: EngineInterface,
  agentId: string | undefined,
  change: (list: Activity[]) => Activity[],
): Promise<void> {
  if (agentId) {
    await update($, agents, list =>
      list.map((a): AgentRun => (a.agentId === agentId ? { ...a, running: change(a.running ?? []) } : a)),
    )
  } else {
    await update($, active, change)
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await writeSelf($, false)
}

// The app keeps one small file for each running session under `<config>/sessions/`, with the
// session's id and the name it shows. The engine passes the name to no event a mod may handle.
async function readTitle($: EngineInterface, force: boolean): Promise<void> {
  if (!selfId) return
  const at = await $.clock.now()
  if (!force && at - lastTitleReadAt < TITLE_GAP_MS) return
  lastTitleReadAt = at
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
    const dir = `${config}/sessions`
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      let info: { sessionId?: unknown; name?: unknown; hostSessionId?: unknown }
      try {
        info = JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`))) as typeof info
      } catch {
        continue // Another session's file, gone or mid-write.
      }
      if (info.sessionId !== selfId) continue
      const name = typeof info.name === 'string' && info.name ? info.name : title
      const host = typeof info.hostSessionId === 'string' ? info.hostSessionId : hostId
      if (name !== title || host !== hostId) {
        title = name
        hostId = host
        await writeSelf($, true)
      }
      return
    }
  } catch {
    // No sessions folder: the session keeps showing its folder name.
  }
}

// Reads every session's record into `sessions`, deleting records a day old.
async function refreshSessions($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const found: SessionRecord[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(SESSION_PREFIX)) continue
    const record = (await $.store.get(key)) as SessionRecord | undefined
    if (!record || typeof record.updatedAt !== 'number' || at - record.updatedAt > PRUNE_MS) {
      await $.store.delete(key)
      continue
    }
    found.push(record)
  }
  found.sort((a, b) => b.updatedAt - a.updatedAt)
  await update($, now, () => at)
  await update($, sessions, prev => (JSON.stringify(prev) === JSON.stringify(found) ? prev : found))
  const line = limitLine(found, at)
  if (line !== statusLine) {
    statusLine = line
    $.ui.status(line)
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A check cut off by a reload left its note at "checking"; nothing is running now.
    await update($, note, prev => (prev?.status === 'checking' ? null : prev))
    await $.command.register({
      name: COMMAND,
      description: 'Overview: toggle the pane; "/coach heads-up" runs one side check (uses tokens)',
    })
    // Ticks elapsed times while a subagent runs, and the blinking cards while the pane shows a
    // working session; quiet otherwise.
    $.clock.every(BLINK_MS, () => {
      void (async () => {
        const list = await read($, agents)
        const inFlight = await read($, active)
        if (inFlight.length === 0 && !list.some(a => a.status === 'running')) {
          if (!(await read($, sessions)).some(s => s.isWorking)) return
          if (!(await $.ui.panes()).some(p => p.id === PANE)) return
        }
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    selfId = await $.session.id()
    folder = baseName(await $.session.cwd())
    project = projectName(await $.session.repo())
    await readTitle($, true)
    await writeSelf($, true)
    await refreshSessions($)
    $.clock.every(HEARTBEAT_MS, () => {
      void (async () => {
        await readTitle($, false)
        await writeSelf($, true)
        // Keeps the status line on the newest reading of any session, the account's limit being one.
        await refreshSessions($)
      })()
    })
    // Other sessions' records are read only while the pane is open to show them.
    $.clock.every(POLL_MS, () => {
      void (async () => {
        if ((await $.ui.panes()).some(p => p.id === PANE)) await refreshSessions($)
      })()
    })
    return started
  })

  // A new session has no reading until its first reply; the line shows the moment one arrives.
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    if (e.changed.includes('rateLimits')) {
      await writeSelf($, true)
      await refreshSessions($)
    }
    return measured
  })

  on('session.end', async ($, e, next) => {
    // After /clear or /resume the session goes on, and session.start does not fire again.
    if (selfId && e.reason !== 'clear' && e.reason !== 'resume') await $.store.delete(SESSION_PREFIX + selfId)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'heads-up' || arg === 'headsup') {
      const r = await runHeadsUp($)
      if (r.status === 'shown') return { text: `Heads up: ${r.text}` }
      if (r.status === 'quiet') return { text: 'Heads up: nothing worth flagging.' }
      if (r.status === 'unavailable') return { text: `Heads up unavailable: ${r.reason}` }
      return { text: 'A heads-up check is already running.' }
    }
    if (arg === 'forget') {
      await $.store.delete(KNOWN_KEY)
      return { text: 'Overview forgot the topics you marked as known.' }
    }
    if (arg === 'show') {
      await update($, isBandHidden, () => false)
      return { text: 'Reflection band shown.' }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Overview pane opened.' : 'Overview pane closed.' }
  }).catch(() => ({ text: 'Overview hit an error; run claude --debug for the reason.' }))

  on('prompt.submit', async ($, e, next) => {
    const at = await $.clock.now()
    const wasWorking = (await read($, turn)) !== null
    const pending = await read($, turnCost)
    if (!wasWorking || !pending) {
      // A turn that never reported its end still spent what it spent.
      if (pending && pending.requests > 0) await update($, costs, list => [...list, pending].slice(-COSTS_KEPT))
      await update($, turnCost, () => ({ kind: 'turn', label: snippet(e.text), at, split: noTokens(), requests: 0, peakContext: 0 }))
      turnLimitStart = await readLimit($)
      turnAgentStart = agentsSpent(await read($, agents))
    }
    await update($, turn, () => blankTurn(at))
    await readTitle($, false)
    await writeSelf($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const started = await $.clock.now()
    const call: Activity = { id: e.tool_use_id ?? `${String(e.tool)}-${started}`, label: activityLabel(e), startedAt: started }
    await trackActivity($, e.agentId, list => [...list, call].slice(-ACTIVITY_MAX))
    const toolName = String(e.tool)
    await update($, toolUse, counts => ({ ...counts, [toolName]: (counts[toolName] ?? 0) + 1 }))
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      await trackActivity($, e.agentId, list => list.filter(a => a.id !== call.id))
    }
    // A session this one starts or briefs is its worker: the call names it by its `local_…` id.
    if (BRIEF_TOOL.test(String(e.tool)) && ran.deny === undefined && ran.isError !== true) {
      const named = `${JSON.stringify(e)} ${ran.text ?? ''}`.match(HOST_ID) ?? []
      const found = [...new Set(named)].filter(id => id !== hostId)
      if (found.length > 0) {
        await update($, children, list => [...list.filter(id => !found.includes(id)), ...found].slice(-CHILDREN_MAX))
        await writeSelf($, true)
      }
    }
    const current = await read($, turn)
    if (!current) return ran
    const tool = String(e.tool)
    const path = EDIT_TOOLS.has(tool) ? field(e, 'file_path') || field(e, 'notebook_path') : ''
    const command = tool === 'Bash' ? field(e, 'command') : ''
    const hasFailed = ran.deny === undefined && ran.isError === true
    await update($, turn, t =>
      t
        ? {
            ...t,
            tools: t.tools + 1,
            edits: path && !t.edits.includes(path) ? [...t.edits, path] : t.edits,
            checksRan: t.checksRan || (command !== '' && CHECK_COMMAND.test(command)),
            failed: hasFailed ? [...t.failed, command ? `Bash ${command.slice(0, 30)}` : tool].slice(-10) : t.failed,
          }
        : t,
    )
    await writeSelf($, false)
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const at = await $.clock.now()
    await update($, agents, list => {
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        tokens: 0,
        steps: 0,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-100)
    })
    await update($, now, () => at)
    await writeSelf($, false)
    return started
  }).catch(($, e, next) => next(e))

  // Each model request: the main loop's adds to the running turn's cost, a subagent's to its run.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!usage) return result
    if (!agentId) {
      if (isChecking) return result // The heads-up fork counts its own cost.
      const at = await $.clock.now()
      await update($, turnCost, c => {
        const base: CostItem = c ?? { kind: 'turn', label: '(turn without a prompt)', at, split: noTokens(), requests: 0, peakContext: 0 }
        return {
          ...base,
          split: addUsage(base.split, usage),
          requests: base.requests + 1,
          peakContext: Math.max(base.peakContext, promptSize(usage)),
        }
      })
      await writeSelf($, false)
      return result
    }
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model: usage.model || a.model,
              split: addUsage(a.split ?? noTokens(), usage),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const at = await $.clock.now()
    if (e.agentId) {
      await update($, agents, list =>
        list.map((a): AgentRun =>
          a.agentId !== e.agentId
            ? a
            : {
                ...a,
                status: e.reason === 'answer' ? 'done' : 'failed',
                endedAt: at,
                running: [],
                split: a.steps === 0 && e.usage ? addUsage(noTokens(), e.usage) : a.split,
                tokens:
                  a.steps === 0 && e.usage
                    ? e.usage.input_tokens +
                      e.usage.output_tokens +
                      e.usage.cache_read_input_tokens +
                      e.usage.cache_creation_input_tokens
                    : a.tokens,
              },
        ),
      )
      await update($, now, () => at)
      await writeSelf($, false)
      return done
    }

    const current = await read($, turn)
    if (!current) return done
    const finished: TurnFacts = {
      ...current,
      seconds: Math.round((at - current.startedAt) / 1000),
      isAborted: e.isAborted,
    }
    const spent = await read($, turnCost)
    if (spent) {
      const end = await readLimit($)
      const points = limitPoints(turnLimitStart, end)
      await update($, costs, list => [...list, points === undefined ? spent : { ...spent, limitPoints: points }].slice(-COSTS_KEPT))
      const agentsNow = agentsSpent(await read($, agents))
      const byAgents: TokenSplit = {
        input: agentsNow.input - turnAgentStart.input,
        cacheWrite: agentsNow.cacheWrite - turnAgentStart.cacheWrite,
        cacheRead: agentsNow.cacheRead - turnAgentStart.cacheRead,
        output: agentsNow.output - turnAgentStart.output,
      }
      const used = addSplit(spent.split, byAgents)
      if (points !== undefined) {
        await update($, calibration, c => ({
          weighted: c.weighted + weight(used),
          raw: c.raw + tokenSum(used),
          points: c.points + points,
        }))
      }
      await update($, turnCost, () => null)
      turnLimitStart = null
    }
    await update($, last, () => finished)
    await update($, turn, () => null)
    await update($, active, () => [])
    await update($, isBandHidden, () => false)
    await update($, totals, t => ({ ...t, turns: t.turns + 1 }))
    await writeSelf($, true)
    await readTitle($, false)
    await refreshSessions($)

    // Auto mode: a long turn earns one check, started off the turn so the fork finds it settled.
    if (options.headsUp === 'auto' && !finished.isAborted && finished.tools >= AUTO_MIN_TOOLS && at - lastAutoAt >= AUTO_GAP_MS) {
      lastAutoAt = at
      $.clock.after(3000, () => {
        void runHeadsUp($)
      })
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (await read($, isBandHidden)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const live = await read($, turn)
    const done = await read($, last)
    const n = await read($, note)
    const runs = await read($, agents)
    const running = runs.filter(a => a.status === 'running').length
    const inFlight = await read($, active)

    const rows = []
    if (e.props.isWorking && live) {
      const at = Math.max(await read($, now), live.startedAt, ...inFlight.map(a => a.startedAt))
      rows.push(
        <Text dimColor>
          ● working {fmtTime(at - live.startedAt)} · {plural(live.tools, 'tool call')}
          {live.edits.length > 0 ? ` · ${plural(live.edits.length, 'file')} edited` : ''}
          {running > 0 ? ` · ${plural(running, 'subagent')} running` : ''}
          {live.failed.length > 0 ? ` · ${live.failed.length} failed` : ''}
        </Text>,
      )
      for (const call of inFlight.slice(-2)) {
        rows.push(
          <Text dimColor>
            {'  '}▸ {call.label} · {fmtTime(at - call.startedAt)}
          </Text>,
        )
      }
    } else if (done) {
      rows.push(
        <Text>
          <Text color="cyan">✦ Reflect</Text> · {reflect(done, runs).join(' · ')}
        </Text>,
      )
    }

    // A heads-up from before the latest prompt is about an earlier turn: blue and labelled so.
    const latestStart = (live ?? done)?.startedAt
    const isOld = n?.status === 'shown' && n.shownAt !== undefined && latestStart !== undefined && latestStart > n.shownAt
    const closeNote = (
      <Button key="close-note" label="✕" hotkey="0" plain onPress={() => update($, note, () => null)} />
    )
    if (n?.status === 'checking') {
      rows.push(<Text dimColor>✦ Heads up · checking the conversation…</Text>)
    } else if (n?.status === 'shown') {
      rows.push(
        <Box gap={1}>
          <Text>
            <Text color={isOld ? 'blue' : 'yellow'}>{isOld ? '✦ Earlier heads-up' : '✦ Heads up'}</Text> · {n.text}{' '}
            <Text dimColor>({fmtTokens(n.tokensIn)} in, {fmtTokens(n.tokensOut)} out)</Text>
          </Text>
          {closeNote}
        </Box>,
      )
    } else if (n?.status === 'quiet') {
      rows.push(
        <Box gap={1}>
          <Text dimColor>
            ✦ Heads up · nothing worth flagging ({fmtTokens(n.tokensIn)} in, {fmtTokens(n.tokensOut)} out)
          </Text>
          {closeNote}
        </Box>,
      )
    } else if (n?.status === 'unavailable') {
      rows.push(
        <Box gap={1}>
          <Text dimColor>✦ Heads up · {n.reason}</Text>
          {closeNote}
        </Box>,
      )
    }

    if (rows.length === 0) return next(e)

    const shown = n?.status === 'shown' ? n : null
    const paneButton = (
      <Button key="pane" label={running > 0 ? `Overview · ${running}` : 'Overview'} plain onPress={() => togglePane($)} />
    )
    const buttons = shown
      ? [
          <Button
            key="ask"
            label="Ask Claude"
            hotkey="1"
            plain
            onPress={async () => {
              await $.prompt.fill({ text: `About this heads-up: "${shown.text}" ` })
              await update($, note, () => null)
            }}
          />,
          <Button key="known" label="Knew this" hotkey="2" plain onPress={() => markKnown($, shown.text)} />,
          paneButton,
        ]
      : [
          <Button
            key="heads-up"
            label="Heads-up (uses tokens)"
            plain
            onPress={() => {
              void runHeadsUp($)
            }}
          />,
          paneButton,
          <Button
            key="hide"
            label="Hide"
            plain
            onPress={async () => {
              await update($, isBandHidden, () => true)
              await update($, note, prev => (prev?.status === 'checking' ? prev : null))
            }}
          />,
        ]

    return (
      <Box flexDirection="column">
        {rows}
        {/* While Claude works, only the pane toggle is useful: the other buttons act on a settled turn. */}
        <Box gap={2}>{e.props.isWorking ? paneButton : buttons}</Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const t: Totals = await read($, totals)
    const done = await read($, last)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)
    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const saving = await read($, savings)

    // A framed part of the pane with a coloured title, and a smaller frame for one part of it.
    const section = (title: string, color: string, body: (JSX.Element | false | null | undefined)[]) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Text bold color={color}>
          {title}
        </Text>
        {body}
      </Box>
    )
    const part = (title: string, body: (JSX.Element | false | null | undefined)[]) => (
      <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
        <Text bold>{title}</Text>
        {body}
      </Box>
    )
    // Token counts stand out wherever they are drawn.
    const tokens = (n: number) => (
      <Text bold color="yellow">
        {fmtTokens(n)}
      </Text>
    )
    const splitRow = (s: TokenSplit) => (
      <Text>
        input {tokens(s.input)} · cache write {tokens(s.cacheWrite)} · cache read {tokens(s.cacheRead)} · output{' '}
        {tokens(s.output)}
      </Text>
    )

    // One dim row for each tool call in flight, with how long it has run.
    const callRows = (calls: readonly Activity[], indent: string) =>
      calls.map(call => (
        <Text dimColor>
          {indent}▸ {call.label} · {fmtTime(at - call.startedAt)}
        </Text>
      ))

    const row = (a: AgentRun) => (
      <Box flexDirection="column">
        <Text>
          <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : 'cyan'}>
            {a.status === 'running' ? '●' : a.status === 'done' ? '✓' : '✗'}
          </Text>{' '}
          <Text bold>{a.description || a.type}</Text>
        </Text>
        <Text dimColor>
          {'  '}
          {a.type} · {a.model || '—'} · <Text bold color="yellow">{fmtTokens(a.tokens)}</Text> tokens ·{' '}
          {plural(a.steps, 'step')} · {fmtTime((a.endedAt ?? at) - a.startedAt)}
        </Text>
        {a.status === 'running' && callRows(a.running ?? [], '  ')}
      </Box>
    )

    const records = await read($, sessions)
    const open = await read($, expanded)
    // The project, then the working folder when it is a worktree or subfolder with a name of its own.
    const where = (s: SessionRecord): string => {
      const repoName = (s.project ?? '').split('/').pop() ?? ''
      const place = s.folder && s.folder !== repoName ? s.folder : ''
      return [s.project, place].filter(Boolean).join(' · ')
    }

    // A worker is a session whose app id another session lists as its child; the newest such
    // session is its controller. The app records no such link, so it comes from the briefing calls.
    const byHost = new Map(records.filter(s => s.hostId).map(s => [s.hostId ?? '', s]))
    const parentOf = new Map<string, SessionRecord>()
    for (const s of [...records].sort((a, b) => a.updatedAt - b.updatedAt)) {
      for (const id of s.children ?? []) {
        const child = byHost.get(id)
        if (child && child.id !== s.id) parentOf.set(child.id, s)
      }
    }
    const workersOf = (s: SessionRecord) => records.filter(r => parentOf.get(r.id)?.id === s.id)
    const machineWeight = records.reduce((n, s) => n + (s.tokens ? weight(s.tokens) : 0), 0)
    const fiveHour = newestLimit(records)
    const estimate = estimateLeft(records, fiveHour?.percentUsed ?? 0)
    const pct = fiveHour?.percentUsed ?? 0
    const meterColor = pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'green'

    const exploreBox = (s: SessionRecord) => {
      const total = s.tokens ?? noTokens()
      const w = weight(total)
      const hints = costTips(s.costs ?? [], total)
      return section('Where the tokens went', 'cyan', [
        part('All tokens', [
          <Text>
            {tokens(tokenSum(total))} tokens{s.costUsd !== undefined ? ` · $${s.costUsd.toFixed(2)} at API prices` : ''}
          </Text>,
          splitRow(total),
        ]),
        part(
          'Costliest items',
          (s.costs ?? []).length === 0
            ? [<Text dimColor>Nothing counted yet.</Text>]
            : (s.costs ?? []).map(item => {
                const share = w > 0 ? Math.round((weight(item.split) / w) * 100) : 0
                const icon = item.kind === 'turn' ? '›' : item.kind === 'subagent' ? '↳' : '✦'
                return (
                  <Box flexDirection="column">
                    <Text>
                      {icon} <Text bold>{item.label}</Text>
                    </Text>
                    <Text>
                      {'  '}
                      {tokens(tokenSum(item.split))} · ≈{share}% of this session · {plural(item.requests, 'request')}
                      {item.peakContext > 0 ? ` · context up to ${fmtTokens(item.peakContext)}` : ''}
                      {item.limitPoints !== undefined ? ` · 5h meter +${item.limitPoints}` : ''}
                    </Text>
                    <Text dimColor>
                      {'  '}
                      {splitLine(item.split)}
                    </Text>
                  </Box>
                )
              }),
        ),
        hints.length > 0 && part('Hints', hints.map(tip => <Text color="yellow">→ {tip}</Text>)),
        <Text dimColor>Shares weigh tokens by API price: a cache read is a tenth of an input token, an output token five.</Text>,
      ])
    }

    const savingsBox = () =>
      section('Ways to save tokens', 'green', [
        saving?.status === 'checking' && <Text dimColor>Checking this session…</Text>,
        saving?.status === 'ready' && saving.tips.length === 0 && <Text>Nothing obvious to save right now.</Text>,
        ...(saving?.status === 'ready'
          ? saving.tips.map(tip => (
              <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
                <Text>{tip.text}</Text>
                {tip.apply && (
                  <Button
                    key={`apply-${tip.id}`}
                    label="Ask Claude to apply"
                    plain
                    onPress={() => $.prompt.fill({ text: tip.apply ?? '' })}
                  />
                )}
              </Box>
            ))
          : []),
        <Text dimColor>
          Worked out here from this session's context and tool use: no tokens used. Applying puts the request in your prompt
          box; nothing is sent until you send it.
        </Text>,
        <Button key="savings-close" label="Close" plain onPress={() => update($, savings, () => null)} />,
      ])

    const sessionCard = (s: SessionRecord, depth: number, seen: Set<string>): JSX.Element => {
      seen.add(s.id)
      const workers = workersOf(s).filter(w => !seen.has(w.id))
      const unseen = (s.children ?? []).filter(id => !byHost.has(id)).length
      const age = at - s.updatedAt
      const isStale = age > STALE_MS
      const isSelf = s.id === selfId
      const state = isStale
        ? `no update for ${fmtTime(age)}`
        : s.isWorking
          ? `working ${s.turnStartedAt ? fmtTime(at - s.turnStartedAt) : ''}`.trim()
          : 'idle'
      const counts = [
        plural(s.tools, 'tool call'),
        s.edits > 0 ? `${plural(s.edits, 'file')} edited` : '',
        s.failed > 0 ? `${s.failed} failed` : '',
        s.subagentsRunning > 0 ? `${plural(s.subagentsRunning, 'subagent')} running` : '',
      ].filter(Boolean)
      const isController = workers.length > 0 || unseen > 0
      const roleColor = isController ? 'magenta' : depth > 0 ? 'blue' : 'gray'
      const isOpen = open.includes(s.id)
      const share = limitShare(s, fiveHour, estimate)
      const border = cardBorder({ isWorking: s.isWorking, isStale, roleColor }, at)
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={border.color}
          borderDimColor={border.isDim}
          paddingX={1}
        >
          <Text dimColor={isStale}>
            {depth > 0 ? '└ ' : ''}
            <Text color={isStale ? undefined : s.isWorking ? 'cyan' : 'green'}>{s.isWorking && !isStale ? '●' : '○'}</Text>{' '}
            {isController ? (
              <Text color="magenta">[controller · {plural(workers.length + unseen, 'worker')}] </Text>
            ) : depth > 0 ? (
              <Text color="blue">[worker] </Text>
            ) : null}
            <Text bold color={isStale || roleColor === 'gray' ? undefined : roleColor}>
              {s.title || s.folder || s.id.slice(0, 8)}
            </Text>
            {isSelf ? ' (this session)' : ''} · {state}
          </Text>
          <Text dimColor>
            {[where(s), counts.join(' · ')].filter(Boolean).join('  ·  ')}
          </Text>
          {!isStale && callRows(s.running ?? [], '')}
          {!isStale &&
            (s.subagents ?? []).map(sub => (
              <Box flexDirection="column">
                <Text dimColor>
                  ↳ {sub.type}: {sub.description} · {fmtTime(at - sub.startedAt)}
                </Text>
                {callRows(sub.running, '  ')}
              </Box>
            ))}
          {s.reflect && !s.isWorking && <Text dimColor>{s.reflect}</Text>}
          {s.tokens && (
            <Box gap={1}>
              <Text>
                tokens {tokens(tokenSum(s.tokens))}
                {machineWeight > 0 ? ` · ${Math.round((weight(s.tokens) / machineWeight) * 100)}%` : ''}
                {fiveHour ? (
                  <Text>
                    {' '}
                    (<Text bold color={meterColor}>{share !== undefined ? fmtShare(share) : '—'}</Text>)
                  </Text>
                ) : (
                  ''
                )}
                {s.costUsd !== undefined ? ` · $${s.costUsd.toFixed(2)}` : ''}
              </Text>
              <Button
                key={`cost-${s.id}`}
                label={isOpen ? 'Close' : 'Explore'}
                plain
                onPress={() => update($, expanded, l => (l.includes(s.id) ? l.filter(id => id !== s.id) : [...l, s.id]))}
              />
              {isSelf && (
                <Button
                  key="save-tokens"
                  label={saving ? 'Check again' : 'Save tokens'}
                  plain
                  onPress={() => checkSavings($)}
                />
              )}
            </Box>
          )}
          {s.tokens && isOpen && exploreBox(s)}
          {isSelf && saving && savingsBox()}
          {unseen > 0 && (
            <Text dimColor>+ {plural(unseen, 'worker')} with no status (ended, or not running the mod)</Text>
          )}
          {(depth < 3 ? workers : []).map(w => sessionCard(w, depth + 1, seen))}
        </Box>
      )
    }

    // Controllers and unlinked sessions are roots, this session first; a loop of links falls back to roots.
    const seen = new Set<string>()
    const cards: JSX.Element[] = []
    const roots = [...records.filter(s => s.id === selfId), ...records.filter(s => s.id !== selfId)].filter(
      s => !parentOf.has(s.id),
    )
    for (const s of roots.slice(0, 12)) cards.push(sessionCard(s, 0, seen))
    for (const s of records) if (!seen.has(s.id) && cards.length < 16) cards.push(sessionCard(s, 0, seen))


    return (
      <Box flexDirection="column" gap={1}>
        {section('Sessions on this machine', 'magenta', [
          records.length === 0 && <Text dimColor>No session has written its status yet.</Text>,
          records.length > 0 && (
            <Text dimColor>
              tokens · N% of the listed sessions' use (N% of the 5h limit); — until that session runs the newest mod
            </Text>
          ),
          ...cards,
        ])}
        {section('Subagents', 'cyan', [
          list.length === 0 && <Text dimColor>No subagents in this session yet.</Text>,
          ...running.map(row),
          ...finished.slice(0, 15).map(row),
        ])}
        {section('Last turn', 'green', done ? reflect(done, list).map(line => <Text>· {line}</Text>) : [<Text dimColor>No finished turn yet.</Text>])}
        {section('Session', 'gray', [
          <Text dimColor>
            {plural(t.turns, 'turn')} · {plural(t.checks, 'heads-up check')} costing {fmtTokens(t.checkTokensIn)} in,{' '}
            {fmtTokens(t.checkTokensOut)} out
          </Text>,
          <Text dimColor>Everything else here runs locally and uses no tokens.</Text>,
          <Button key="pane-heads-up" label="Heads-up (uses tokens)" plain onPress={() => void runHeadsUp($)} />,
        ])}
      </Box>
    )
  })
}
