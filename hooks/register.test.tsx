import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { ModelForkResult } from 'claude-code'

import { boldText, byRank, cardBorder, estimateLeft, fmtClock, italicText, limitCards, limitLine, limitShare, questionsIn, savingTips, snippet, spentInWindow, underlineText } from './register'

const BAND = {
  plugin: 'overview',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const PANE = {
  plugin: 'overview',
  component: 'Pane',
  requestId: 'overview',
  props: {
    title: 'Overview',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TURN_END = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

let whileSlow = async () => {}
// The five-hour meter the next API response reports, in percent.
let limitPercent: number | undefined = 10
// What the last "Ask Claude to apply" put in the prompt box.
let filled = ''
// The live context, and the breakdown /context would show for it.
let context: Record<string, number> = { tokens: 0, window: 200_000, percent: 0 }
let breakdown: unknown
// The status line the mod last pinned.
let statusText: string | undefined
let weeklyPercent: number | undefined

const SELF_HOST = 'local_5e1f0000-0000-0000-0000-000000000000'
const WORKER_HOST = 'local_aaaa1111-0000-0000-0000-000000000000'
const ENDED_HOST = 'local_bbbb2222-0000-0000-0000-000000000000'

// Four hours after the stub clock starts, so everything a test spends falls in this window.
// The status line's styled letters read back as the plain text they stand for.
const plain = (t: string | undefined) => t?.normalize('NFKD').replace(/̲/g, '')

const STUB_RESET = new Date(1_000_000 + 4 * 60 * 60 * 1000).toISOString()

// The engine beneath the plugin: each hook stands for what core would answer.
function engine(on: Parameters<TestBody>[1], fork?: () => ModelForkResult, seed: Record<string, unknown> = {}) {
  let clock = 1_000_000
  const store = new Map<string, unknown>(Object.entries(seed))
  on('clock.now', () => ({ value: (clock += 1000) }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.repo', () => ({
    value: { root: 'D:\\Code\\sample-webapp', remote: 'https://github.com/acme/sample-webapp.git', internal: false, name: null },
  }))
  on('session.id', () => ({ value: 'self-1' }))
  on('session.cwd', () => ({ value: 'D:\\Code\\sample-webapp' }))
  // The desktop's file for each running session: a broken one, another session's, then this one's.
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/T' : undefined }))
  on('fs.list', (_, e) => ({
    value:
      String(e.path).replaceAll('\\', '/') === 'C:/Users/T/.claude/sessions'
        ? ['10.json', '11.json', '12.json', '12.abc.key'].map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
        : [],
  }))
  on('fs.read', (_, e) => {
    const files: Record<string, string> = {
      'C:/Users/T/.claude/sessions/10.json': '{"sessionId":',
      'C:/Users/T/.claude/sessions/11.json': JSON.stringify({ sessionId: 'w9', name: 'Someone else' }),
      'C:/Users/T/.claude/sessions/12.json': JSON.stringify({
        sessionId: 'self-1',
        name: 'Claude mod installation',
        hostSessionId: SELF_HOST,
      }),
    }
    const text = files[String((e as { path?: unknown }).path).replaceAll('\\', '/')]
    return text === undefined ? { deny: 'missing' } : { value: text }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  // Core draws nothing in the band when no plugin does.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.register', () => ({ value: { command: 'coach' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', async (_, e) => {
    const command = String((e as { command?: string }).command)
    // A command with "slow" in it runs the test's check while the call is still in flight.
    if (command.includes('slow')) await whileSlow()
    if (e.tool === 'mcp__ccd_session__start_session') {
      return { result: {}, text: `Started session "Check the tree" (session_id: ${WORKER_HOST}, name: check-tree)` }
    }
    // A background launch answers at once with the task's id.
    if ((e as { run_in_background?: boolean }).run_in_background) {
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }
    }
    if (e.tool === 'Monitor') return { result: { taskId: 'm1', timeoutMs: 300_000 } }
    return (e.tool === 'Bash' || e.tool === 'PowerShell') && command.includes('false') ? { result: {}, isError: true } : { result: {} }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('classic.Stop', () => ({}))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('ui.status', (_, e) => {
    statusText = e.text
    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    filled = String((e as { text?: unknown }).text)
    return { isFilled: true }
  })
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      context: { ...context, ...((e as { breakdown?: unknown }).breakdown ? { breakdown } : {}) },
      rateLimits: [
        ...(limitPercent === undefined ? [] : [{ kind: 'five_hour', percentUsed: limitPercent, resetsAt: STUB_RESET }]),
        ...(weeklyPercent === undefined ? [] : [{ kind: 'seven_day', percentUsed: weeklyPercent, resetsAt: STUB_RESET }]),
      ],
      cost: { usd: 1.5 },
    } as never,
  }))
  if (fork) on('model.fork', () => ({ value: fork() }))
  return store
}

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }

test('a main turn that edits without checks fills the band, on desktop and terminal', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'fix it' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.turn.complete(TURN_END)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = await ui.find({ type: 'Text', text: /Reflect/ })
    expect(line?.text).toContain('Edited 1 file, no tests or checks ran')
    expect(line?.text).toContain('1 tool call failed (Bash false)')
    expect(await ui.find({ type: 'Button', text: /Heads-up/ })).toBeDefined()
    await ui.unmount()
  }
})

test('while Claude works the band keeps the Overview button and drops the others', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'look around' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /working/ }))?.text).toContain('1 tool call')
  expect(await ui.find({ type: 'Button', text: /Overview/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Heads-up/ })).toBeUndefined()
  await ui.unmount()
})

test('running the tests clears the no-checks warning', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'fix it' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  await $.turn.complete(TURN_END)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /Reflect/ })
  expect(line?.text).not.toContain('no tests or checks ran')
  expect(line?.text).toContain('Edge cases')
  await ui.unmount()
})

test('PowerShell checks clear the no-checks warning, and a failed PowerShell call is named', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'fix it' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'PowerShell', command: 'npx tsc --noEmit' } as never)
  await $.tool.call({ tool: 'PowerShell', command: 'Get-Item false' } as never)
  await $.turn.complete(TURN_END)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /Reflect/ })
  expect(line?.text).not.toContain('no tests or checks ran')
  expect(line?.text).toContain('1 tool call failed (PowerShell Get-Item false)')
  await ui.unmount()
})

test("a subagent's turn end leaves the band alone and marks its pane row done", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'look around' } as never)
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'find the config',
    description: 'Find config',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)
  await $.turn.complete({ ...TURN_END, agentId: 'a1' })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /Reflect/ })).toBeUndefined()
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = await pane.find({ type: 'Text', text: /Find config/ })
  expect(row?.text).toContain('✓')
  expect((await pane.find({ type: 'Text', text: /Explore ·/ }))?.text).toContain('claude-haiku-5-5')
  await pane.unmount()
})

test('a heads-up reply shows with its cost, and NONE shows nothing to flag', async ($, on) => {
  let reply = 'The migration was never run against a real database.'
  engine(on, () => ({ isAnswered: true, text: reply, usage }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'go' } as never)
  await $.turn.complete(TURN_END)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'heads-up' })
  const shown = await ui.find({ type: 'Text', text: /Heads up/ })
  expect(shown?.text).toContain('never run against a real database')
  expect(shown?.text).toContain('4.1k in, 20 out')
  await ui.press({ key: 'close-note' })
  expect(await ui.find({ type: 'Text', text: /Heads up/ })).toBeUndefined()

  reply = 'NONE'
  await ui.press({ key: 'heads-up' })
  expect((await ui.find({ type: 'Text', text: /Heads up/ }))?.text).toContain('nothing worth flagging')
  await ui.unmount()
})

test('a fork with nothing to read says so instead of failing', async ($, on) => {
  engine(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const result = await $.command.run({ command: 'coach', args: 'heads-up' } as never)
  expect((result as { text?: string }).text).toContain('nothing to check yet')
})

const record = (id: string, folder: string, updatedAt: number, isWorking = false) => ({
  id,
  title: '',
  project: 'acme/sample-webapp',
  folder,
  isWorking,
  tools: 4,
  edits: 1,
  failed: 0,
  subagentsRunning: 0,
  reflect: 'Edited 1 file, no tests or checks ran',
  updatedAt,
})

test('the pane lists this session and other sessions with their state', async ($, on) => {
  engine(on, undefined, { 'session:w1': record('w1', 'fix-login-form', 1_000_000, true) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete(TURN_END)
  await $.command.run({ command: 'coach', args: '' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const self = await pane.find({ type: 'Text', text: /\(this session\)/ })
  expect(self?.text).toContain('Claude mod installation')
  expect(self?.text).toContain('idle')
  expect((await pane.find({ type: 'Text', text: /1 tool call/ }))?.text).toBe('acme/sample-webapp  ·  1 tool call')
  const worker = await pane.find({ type: 'Text', text: /fix-login-form/ })
  expect(worker?.text).toContain('working')
  const counts = await pane.find({ type: 'Text', text: /4 tool calls/ })
  expect(counts?.text).toContain('1 file edited')
  await pane.unmount()
})

test('a session silent for minutes shows as stale, and a day-old record is removed', async ($, on) => {
  const store = engine(on, undefined, {
    'session:old': record('old', 'chore-gone', 1_000_000 - 10 * 60 * 1000, true),
    'session:ancient': record('ancient', 'feat-ancient', 1_000_000 - 2 * 24 * 60 * 60 * 1000),
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const stale = await pane.find({ type: 'Text', text: /chore-gone/ })
  expect(stale?.text).toContain('no update for')
  expect(stale?.text).not.toContain('working')
  expect(await pane.find({ type: 'Text', text: /feat-ancient/ })).toBeUndefined()
  expect(store.has('session:ancient')).toBe(false)
  await pane.unmount()
})

test("a row names the session as the app does, then its project and worktree folder", async ($, on) => {
  engine(on, undefined, {
    'session:w2': { ...record('w2', 'fix-login-form', 1_000_000), title: 'Fix the login form' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'coach', args: '' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /\(this session\)/ }))?.text).toContain('Claude mod installation')
  // The main checkout's folder is the repository's own name, so only the project shows.
  expect((await pane.find({ type: 'Text', text: /^acme\/sample-webapp  ·  0 tool calls$/ }))?.text).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /Fix the login form/ }))?.text).toContain('idle')
  expect((await pane.find({ type: 'Text', text: /acme\/sample-webapp · fix-login-form/ }))?.text).toBeDefined()
  await pane.unmount()
})

test('a tool call is in the session record while it runs, and the band drops it once it returns', async ($, on) => {
  const store = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'go' } as never)
  const working = { ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'desktop' } as const
  let seen: unknown
  // A drawing cannot be mounted while the call is in flight; the record is what other sessions read.
  whileSlow = async () => {
    seen = (store.get('session:self-1') as { running?: { label: string }[] }).running?.map(a => a.label)
  }
  await $.tool.call({ tool: 'Bash', command: 'pnpm test --slow' })
  expect(seen).toEqual(['Bash: pnpm test --slow'])

  const ui = await $.ui.mount(working)
  expect(await ui.find({ type: 'Text', text: /▸/ })).toBeUndefined()
  await ui.unmount()
})

test("another session's row shows its running tool and subagent with how long each has run", async ($, on) => {
  engine(on, undefined, {
    'session:w3': {
      ...record('w3', 'feat-search', 1_000_000, true),
      title: 'Search page',
      turnStartedAt: 1_000_000 - 125_000,
      running: [{ id: 't1', label: 'Bash: pnpm verify', startedAt: 1_000_000 - 65_000 }],
      subagents: [
        {
          description: 'Find config',
          type: 'Explore',
          startedAt: 1_000_000 - 30_000,
          running: [{ id: 't2', label: 'Grep loadConfig', startedAt: 1_000_000 - 5_000 }],
        },
      ],
    },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'coach', args: '' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The stub clock moves on a second per read, so times are checked by their gaps, which it leaves alone:
  // the turn began 125 s before the record, the call 65 s, the subagent 30 s.
  const seconds = (text: string | undefined, pattern: RegExp) => {
    const m = pattern.exec(text ?? '')
    return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN
  }
  // One drawing holds all three, so its times share one clock reading.
  const card = (await pane.find({ type: 'Box', text: /Search page/ }))?.text ?? ''
  expect(card).toContain('▸ Bash: pnpm verify · ')
  expect(card).toContain('↳ Explore: Find config · ')
  const turnTime = seconds(card, /working (?:(\d+)m )?(\d+)s/)
  expect(turnTime - seconds(card, /pnpm verify · (?:(\d+)m )?(\d+)s/)).toBe(60)
  expect(turnTime - seconds(card, /Find config · (?:(\d+)m )?(\d+)s/)).toBe(95)
  expect((await pane.find({ type: 'Text', text: /loadConfig/ }))?.text).toContain('▸ Grep loadConfig')
  await pane.unmount()
})

test("a working session's card border blinks a second lit, a second dim; idle and stale cards hold still", async ($, on) => {
  const working = { isWorking: true, isStale: false, roleColor: 'magenta' }
  expect(cardBorder(working, 4_000)).toEqual({ color: 'cyan', isDim: false })
  expect(cardBorder(working, 5_000)).toEqual({ color: 'gray', isDim: true })
  expect(cardBorder(working, 6_999)).toEqual({ color: 'cyan', isDim: false })
  for (const at of [4_000, 5_000]) {
    expect(cardBorder({ ...working, isWorking: false }, at)).toEqual({ color: 'magenta', isDim: false })
    expect(cardBorder({ ...working, isStale: true }, at)).toEqual({ color: 'gray', isDim: true })
  }
  // The pane draws a working session's card with that border.
  engine(on, undefined, { 'session:w4': { ...record('w4', 'feat-blink', 1_000_000, true), title: 'Blink check' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'coach', args: '' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The innermost framed box holding the title is the card; the ones around it are the pane's sections.
  const card = (await pane.findAll({ type: 'Box', text: /Blink check/ })).filter(b => b.props.borderStyle).at(-1)
  expect(['cyan', 'gray']).toContain(card?.props.borderColor)
  expect(card?.props.borderDimColor).toBe(card?.props.borderColor === 'gray')
  await pane.unmount()
})

test('working sessions come first, then those that spent tokens by their latest work, empty ones last', () => {
  const working = { isWorking: true, lastWorkedAt: 100, hasTokens: false }
  const recent = { isWorking: false, lastWorkedAt: 900, hasTokens: true }
  const older = { isWorking: false, lastWorkedAt: 500, hasTokens: true }
  const empty = { isWorking: false, lastWorkedAt: 950, hasTokens: false }
  expect([empty, older, recent, working].sort(byRank)).toEqual([working, recent, older, empty])
})

test('the pane orders cards by work, a working worker lifts its controller, and unrelated cards are spaced apart', async ($, on) => {
  const spent = { input: 10, cacheWrite: 0, cacheRead: 0, output: 5 }
  engine(on, undefined, {
    'session:old': { ...record('old', 'f', 1_000_000), title: 'Older idle', tokens: spent, lastWorkedAt: 500_000 },
    'session:new': { ...record('new', 'f', 1_000_000), title: 'Recent idle', tokens: spent, lastWorkedAt: 900_000 },
    'session:none': { ...record('none', 'f', 1_000_000), title: 'Never spent', lastWorkedAt: 990_000 },
    'session:boss': {
      ...record('boss', 'f', 1_000_000),
      title: 'Idle controller',
      tokens: spent,
      lastWorkedAt: 100_000,
      children: [WORKER_HOST],
    },
    'session:busy': { ...record('busy', 'f', 1_000_000, true), title: 'Busy worker', hostId: WORKER_HOST, tokens: spent },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'coach', args: '' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const titles = (await pane.findAll({ type: 'Text', text: /Idle controller|Busy worker|Recent idle|Older idle|Never spent/ }))
    .map(t => /Idle controller|Busy worker|Recent idle|Older idle|Never spent/.exec(t.text ?? '')?.[0])
    .filter((t, i, all) => t && all.indexOf(t) === i)
  expect(titles).toEqual(['Idle controller', 'Busy worker', 'Recent idle', 'Older idle', 'Never spent'])
  // The cards sit in one column with a blank row between them; a worker stays inside its controller's card.
  const column = (await pane.findAll({ type: 'Box', text: /Older idle/ })).find(b => b.props.gap === 1 && !b.props.borderStyle && /Recent idle/.test(b.text ?? ''))
  expect(column).toBeDefined()
  await pane.unmount()
})

test("this session's subagents are listed inside its own card, not in a box of their own", async ($, on) => {
  engine(on, undefined, { 'session:w5': { ...record('w5', 'f', 1_000_000), title: 'Other session' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'look around' } as never)
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'find the config',
    description: 'Find config',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)
  await $.command.run({ command: 'coach', args: '' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const framed = async (text: RegExp) => (await pane.findAll({ type: 'Box', text })).filter(b => b.props.borderStyle).at(-1)
  expect((await framed(/\(this session\)/))?.text).toContain('Find config')
  expect((await framed(/Other session/))?.text).not.toContain('Find config')
  // The only frame titled Subagents is the one in the card.
  expect((await framed(/Subagents/))?.text).not.toContain('(this session)')
  expect((await framed(/Subagents/))?.text).toContain('Find config')
  await pane.unmount()
})

test("an answer's questions are its sentences ending in a question mark, outside code, without markdown", () => {
  const answer = [
    'I fixed the parser. Tests pass.',
    '```ts',
    'const ok = a ?? b // why?',
    '```',
    '- **Should I also migrate the old rows?** They are unused.',
    'Which branch do you want it on? I can push either.',
    'Ok?',
  ].join('\n')
  expect(questionsIn(answer)).toEqual(['Should I also migrate the old rows?', 'Which branch do you want it on?'])
  expect(questionsIn('All done, nothing pending.')).toEqual([])
})

test("Last turn shows what Claude asked, and another session's card shows what it waits on", async ($, on) => {
  const store = engine(on, undefined, {
    'session:w6': { ...record('w6', 'f', 1_000_000), title: 'Waiting worker', turnStartedAt: null, questions: ['Merge PR 12 now?'] },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'fix it' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Fixed.', ask: 'Push the fix?' } as never)
  await $.turn.complete({ ...TURN_END, answer: 'Fixed the bug. Should I also add a test for the empty case?' })
  expect((store.get('session:self-1') as { questions?: string[] }).questions).toEqual([
    'Push the fix?',
    'Should I also add a test for the empty case?',
  ])
  await $.command.run({ command: 'coach', args: '' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const lastTurn = (await pane.findAll({ type: 'Box', text: /Last turn/ })).filter(b => b.props.borderStyle).at(-1)
  expect(lastTurn?.text).toContain('Claude asks · Push the fix?')
  expect(lastTurn?.text).toContain('Claude asks · Should I also add a test for the empty case?')
  expect((await pane.find({ type: 'Text', text: /asks · Merge PR 12 now\?/ }))?.text).toBe('? asks · Merge PR 12 now?')
  await pane.unmount()
})

type Saved = { isWorking: boolean; turnStartedAt?: number | null; background?: { id: string; label: string }[] }

test('a background command keeps the session working after its turn, until a stop no longer lists it', async ($, on) => {
  const store = engine(on)
  const saved = () => store.get('session:self-1') as Saved
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'run the suite' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test', run_in_background: true } as never)
  await $.turn.complete(TURN_END)
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'pnpm test', command: 'pnpm test' }],
  } as never)

  expect(saved().isWorking).toBe(true)
  expect(saved().turnStartedAt).toBeNull()
  expect(saved().background?.map(t => t.label)).toEqual(['Bash: pnpm test'])
  await $.command.run({ command: 'coach', args: '' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /\(this session\)/ }))?.text).toContain('working in the background')
  expect((await pane.find({ type: 'Text', text: /1 tool call/ }))?.text).toContain('1 background task')
  expect((await pane.find({ type: 'Text', text: /◦ Bash: pnpm test/ }))?.text).toContain('(background)')
  await pane.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /working in the background/ }))?.text).toContain('1 task')
    expect(await band.find({ type: 'Text', text: /◦ Bash: pnpm test/ })).toBeDefined()
    await band.unmount()
  }

  // The task's notification starts a turn, and its stop lists nothing left in flight.
  await $.prompt.submit({ text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' } as never)
  await $.turn.complete(TURN_END)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  expect(saved().isWorking).toBe(false)
  expect(saved().background).toEqual([])
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /\(this session\)/ }))?.text).toContain('idle')
  await after.unmount()
})

test('a task leaves the list when its end notification arrives, even if no stop hook ran', async ($, on) => {
  const store = engine(on)
  const saved = () => store.get('session:self-1') as Saved
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'run two jobs' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test', run_in_background: true } as never)
  await $.tool.call({ tool: 'Monitor', description: 'watch CI', timeout_ms: 300_000, command: 'gh run watch' } as never)
  await $.turn.complete(TURN_END)
  expect(saved().background?.map(t => t.id).sort()).toEqual(['b1', 'm1'])
  expect(saved().isWorking).toBe(true)

  const notify = (text: string, agentId?: string) =>
    $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
      door: 'prompt',
      origin: { kind: 'task-notification' },
      uuid: `u-${text.length}`,
      ...(agentId ? { agentId } : {}),
    } as never)
  // A monitor's event names its task but reports no end, and a subagent's row is not the session's.
  await notify('<task-notification><task-id>m1</task-id><event>build 3 passed</event></task-notification>')
  await notify('<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', 'a1')
  expect(saved().background?.map(t => t.id).sort()).toEqual(['b1', 'm1'])

  await notify(
    '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>',
  )
  expect(saved().background?.map(t => t.id)).toEqual(['m1'])
  await notify('<task-notification><task-id>m1</task-id><status>killed</status></task-notification>')
  expect(saved().background).toEqual([])
  expect(saved().isWorking).toBe(false)
})

test("a stop's list names tasks the session never launched, leaves subagents out, and TaskStop ends a monitor", async ($, on) => {
  const store = engine(on)
  const saved = () => store.get('session:self-1') as Saved
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'watch CI' } as never)
  await $.tool.call({ tool: 'Monitor', description: 'watch CI', timeout_ms: 300_000, command: 'gh run watch' } as never)
  expect(saved().background?.map(t => t.label)).toEqual(['Monitor: watch CI'])
  await $.turn.complete(TURN_END)
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'm1', type: 'monitor', status: 'running', description: 'watch CI' },
      { id: 'w1', type: 'workflow', status: 'running', description: 'Review changes', name: 'review-changes' },
      { id: 'a9', type: 'subagent', status: 'running', description: 'Find config', agent_type: 'Explore' },
    ],
  } as never)
  expect(saved().background?.map(t => t.label)).toEqual(['Monitor: watch CI', 'Workflow: review-changes'])

  await $.prompt.submit({ text: 'stop watching' } as never)
  await $.tool.call({ tool: 'TaskStop', task_id: 'm1' } as never)
  expect(saved().background?.map(t => t.id)).toEqual(['w1'])
  expect(saved().isWorking).toBe(true)
})

test('a background subagent still running after the main turn keeps the session working', async ($, on) => {
  const store = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'look around' } as never)
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'find the config',
    description: 'Find config',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as never)
  await $.turn.complete(TURN_END)
  expect((store.get('session:self-1') as Saved).isWorking).toBe(true)
  await $.turn.complete({ ...TURN_END, agentId: 'a1' })
  expect((store.get('session:self-1') as Saved).isWorking).toBe(false)
})

const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as const
// One main-loop request: 53k of prompt, mostly read from the cache.
const stepUsage = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000, output_tokens: 500 }

async function step($: Parameters<TestBody>[0]) {
  for await (const _ of $.turn.step(STEP as never)) {
    // Drained: only the result's usage matters here.
  }
}

test("a turn's tokens are counted by kind, with the five-hour meter's move, and the pane breaks them down", async ($, on) => {
  const store = engine(on)
  on('turn.step', async function* () {
    return { ...STEP, answer: '', toolUses: [], usage: { ...stepUsage, model: 'claude-opus-5-5' } } as never
  })
  limitPercent = 10
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'refactor the parser' } as never)
  await step($)
  await step($)
  limitPercent = 12
  await $.turn.complete(TURN_END)

  const saved = store.get('session:self-1') as {
    tokens: Record<string, number>
    costs: { label: string; requests: number; peakContext: number; limitPoints?: number }[]
    fiveHour: { percentUsed: number }
    costUsd: number
  }
  expect(saved.tokens).toEqual({ input: 2000, cacheWrite: 4000, cacheRead: 100000, output: 1000 })
  expect(saved.costs[0]).toMatchObject({ label: 'refactor the parser', requests: 2, peakContext: 53000, limitPoints: 2 })
  expect(saved.fiveHour.percentUsed).toBe(12)
  expect(saved.costUsd).toBe(1.5)

  await $.command.run({ command: 'coach', args: '' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The limit lives under the prompt now, not in the pane.
  expect(await pane.find({ type: 'Text', text: /5-hour limit/ })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: /^tokens 107k/ }))?.text).toContain('$1.50')
  expect(await pane.find({ type: 'Text', text: /refactor the parser/ })).toBeUndefined()
  await pane.press({ key: 'cost-self-1' })
  expect(await pane.find({ type: 'Text', text: /^› refactor the parser$/ })).toBeDefined()
  const item = await pane.find({ type: 'Text', text: /of this session/ })
  expect(item?.text).toContain('107k')
  expect(item?.text).toContain('≈100% of this session')
  expect(item?.text).toContain('2 requests')
  expect(item?.text).toContain('context up to 53k')
  expect(item?.text).toContain('5h meter +2')
  expect((await pane.find({ type: 'Text', text: /^input / }))?.text).toBe('input 2.0k · cache write 4.0k · cache read 100k · output 1.0k')
  await pane.unmount()
})

test('a session this one started shows under it as a worker, and a briefed one without a status is counted', async ($, on) => {
  engine(on, undefined, {
    'session:w5': { ...record('w5', 'sample-webapp', 1_000_000), title: 'Check the tree', hostId: WORKER_HOST },
    'session:w6': { ...record('w6', 'feat-other', 1_000_000), title: 'Unrelated session' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'start a worker' } as never)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'Check the tree', prompt: 'look' } as never)
  await $.tool.call({ tool: 'SendMessage', to: ENDED_HOST, message: 'next task' } as never)
  await $.turn.complete(TURN_END)
  await $.command.run({ command: 'coach', args: '' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /\(this session\)/ }))?.text).toContain('[controller · 2 workers]')
  const worker = await pane.find({ type: 'Text', text: /Check the tree/ })
  expect(worker?.text).toMatch(/^└ ○ \[worker\] Check the tree/)
  expect((await pane.find({ type: 'Text', text: /with no status/ }))?.text).toContain('+ 1 worker with no status')
  const other = await pane.find({ type: 'Text', text: /Unrelated session/ })
  expect(other?.text).not.toContain('[worker]')
  expect(other?.text).not.toMatch(/^\s/)
  await pane.unmount()
})

test('a heads-up from before the latest prompt turns blue as an earlier one, and its ✕ removes it while Claude works', async ($, on) => {
  engine(on, () => ({ isAnswered: true, text: 'The migration was never run.', usage }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'go' } as never)
  await $.turn.complete(TURN_END)
  await $.command.run({ command: 'coach', args: 'heads-up' } as never)

  const fresh = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await fresh.find({ type: 'Text', text: /^✦ Heads up$/ }))?.props.color).toBe('yellow')
  await fresh.unmount()

  await $.prompt.submit({ text: 'next task' } as never)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^✦ Earlier heads-up$/ }))?.props.color).toBe('blue')
  await ui.press({ key: 'close-note' })
  expect(await ui.find({ type: 'Text', text: /heads-up|Heads up/ })).toBeUndefined()
  await ui.unmount()
})

const tipInput = {
  mcpTools: [],
  memoryFiles: [],
  toolUse: {},
  contextTokens: 20_000,
  contextPercent: 10,
  items: [],
}

test('savings: idle MCP servers are named with their schema cost, used and app servers are left alone', () => {
  const tips = savingTips({
    ...tipInput,
    mcpTools: [
      { serverName: 'railway', tokens: 1200, isLoaded: true },
      { serverName: 'railway', tokens: 800, isLoaded: true },
      { serverName: 'context7', tokens: 3000, isLoaded: true },
      { serverName: 'ccd_session', tokens: 5000, isLoaded: true },
      { serverName: 'figma', tokens: 9000, isLoaded: false },
    ],
    toolUse: { 'mcp__context7__query-docs': 2, Bash: 4 },
  })
  expect(tips.map(t => t.id)).toEqual(['idle-mcp'])
  expect(tips[0]?.text).toContain('railway put 2.0k of tool schemas')
  expect(tips[0]?.apply).toContain('Turn off these MCP servers for this session, since none of their tools ran: railway.')
})

test('savings: a large context, long replies and costly subagents each get their own suggestion', () => {
  const turn = (output: number, requests: number) => ({
    kind: 'turn' as const,
    label: 't',
    at: 0,
    split: { input: 100, cacheWrite: 0, cacheRead: 1000, output },
    requests,
    peakContext: 0,
  })
  const agent = { ...turn(0, 1), kind: 'subagent' as const, split: { input: 90_000, cacheWrite: 0, cacheRead: 0, output: 0 } }
  const tips = savingTips({ ...tipInput, contextTokens: 160_000, contextPercent: 80, items: [turn(4000, 2), turn(2000, 2), agent] })
  expect(tips.map(t => t.id)).toEqual(['context', 'long-answers', 'subagents'])
  expect(tips[0]?.apply).toBe('/compact')
  expect(tips[1]?.text).toContain('1.5k output tokens per request')
  // Nothing measured above the thresholds: no suggestion at all.
  expect(savingTips({ ...tipInput, items: [turn(300, 5)] })).toEqual([])
})

test('Save tokens lists suggestions in the pane, and Ask Claude to apply fills the prompt box', async ($, on) => {
  engine(on)
  context = { tokens: 170_000, window: 200_000, percent: 85 }
  breakdown = { mcpTools: [{ name: 'deploy', serverName: 'railway', tokens: 4000, isLoaded: true }], memoryFiles: [] }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'go' } as never)
  await $.turn.complete(TURN_END)
  await $.command.run({ command: 'coach', args: '' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /Ways to save tokens/ })).toBeUndefined()
  await pane.press({ key: 'save-tokens' })
  expect((await pane.find({ type: 'Text', text: /^Unused tools/ }))?.text).toContain('railway put 4.0k')
  expect((await pane.find({ type: 'Text', text: /^Large context/ }))?.text).toContain('170k (85% of the window)')
  await pane.press({ key: 'apply-context' })
  expect(filled).toBe('/compact')
  await pane.press({ key: 'savings-close' })
  expect(await pane.find({ type: 'Text', text: /Ways to save tokens/ })).toBeUndefined()
  await pane.unmount()
  context = { tokens: 0, window: 200_000, percent: 0 }
  breakdown = undefined
})

test("a turn's label drops the app's tagged blocks, and a worker's report is named as one", () => {
  expect(snippet('<system-reminder>The session "x" finished.</system-reminder> make the pane bigger')).toBe('make the pane bigger')
  expect(snippet('<system-reminder>a</system-reminder>\n<side-sessions-event>None working</side-sessions-event>')).toBe(
    '(report from a worker session)',
  )
  expect(snippet('<system-reminder>only a reminder</system-reminder>')).toBe('(automatic turn)')
  expect(snippet('use <b> tags in html')).toBe('use <b> tags in html')
})

const withCalibration = (id: string, weighted: number, raw: number, points: number) => ({
  ...record(id, id, 1_000_000),
  calibration: { weighted, raw, points },
})

test('tokens left: what all listed sessions spent per point, times the points left', () => {
  const both = [withCalibration('a', 500_000, 4_000_000, 2), withCalibration('b', 250_000, 2_000_000, 1)]
  expect(estimateLeft(both, 10)).toEqual({
    isReady: true,
    points: 3,
    weightedPerPoint: 250_000,
    rawPerPoint: 2_000_000,
    weightedLeft: 22_500_000,
    rawLeft: 180_000_000,
  })
  // One point is one rounding of the meter: too little to estimate from.
  expect(estimateLeft([withCalibration('a', 250_000, 2_000_000, 1)], 10)).toEqual({ isReady: false, points: 1 })
})

test('the limit cards show the newest reading, when it resets and the estimate, and say when the window reset', () => {
  const at = Date.parse('2026-10-26T12:00:00Z')
  const reading = (percentUsed: number, readAt: number, resetsAt = '2026-10-26T15:28:00Z') => ({
    fiveHour: { kind: 'five_hour', percentUsed, resetsAt, readAt },
  })
  const older = { ...withCalibration('a', 500_000, 4_000_000, 2), ...reading(8, at - 60_000) }
  const newer = { ...withCalibration('b', 250_000, 2_000_000, 1), ...reading(10, at - 1000) }
  // 750,000 over 3 points, times the 90 left.
  // The reset's clock time is local, so only its minutes and seconds are fixed whatever the zone.
  const [card] = limitCards([older, newer], at)
  expect(card).toMatchObject({ title: '5h', percentUsed: 10 })
  expect(card?.lines[0]).toBe('≈22.5M left')
  expect(card?.lines[1]).toMatch(/^resets 3h 28m \(\d\d:28:00\)$/)
  const unmeasured = limitCards([{ ...record('c', 'c', at), ...reading(10, at - 1000) }], at)[0]?.lines
  expect(unmeasured?.[0]).toBe('≈? left (0/2 points measured)')
  expect(unmeasured?.[1]).toMatch(/^resets 3h 28m \(\d\d:28:00\)$/)
  expect(limitCards([{ ...newer, ...reading(10, at - 1000, '2026-10-26T11:00:00Z') }], at)[0]?.lines).toEqual([
    'just reset',
  ])
  // No reading, no card; a weekly reading adds its own.
  expect(limitCards([record('d', 'd', at)], at)).toEqual([])
  const weekly = { ...record('e', 'e', at), sevenDay: { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-29T12:00:00Z', readAt: at } }
  expect(limitCards([weekly], at)).toEqual([{ title: 'Week', percentUsed: 41, lines: ['resets 72h 00m'] }])
})

test("a turn that moves the meter calibrates the estimate, and every session's status line shows it", async ($, on) => {
  const store = engine(on)
  on('turn.step', async function* () {
    return { ...STEP, answer: '', toolUses: [], usage: { ...stepUsage, model: 'claude-opus-5-5' } } as never
  })
  statusText = undefined
  limitPercent = 10
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'big refactor' } as never)
  await step($)
  await step($)
  limitPercent = 13
  await $.turn.complete(TURN_END)

  // Two requests of 1000 input, 2000 cache write, 50000 cache read, 500 output: 22,000 weighted, 107,000 as counted.
  expect((store.get('session:self-1') as { calibration: unknown }).calibration).toEqual({ weighted: 22_000, raw: 107_000, points: 3 })
  // 22,000 over 3 points, times the 87 left.
  // 22,000 over 3 points, times the 87 left, on the line under the prompt.
  expect(plain(statusText)).toMatch(/^5h 13% · ≈638k left · resets .+$/)
  // The session's whole spend in this window over what a point holds: 3 of the limit's 100 points.
  await $.command.run({ command: 'coach', args: '' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^tokens 107k/ }))?.text).toContain('tokens 107k · 100% (3.0%)')
  await pane.unmount()
  limitPercent = 10
})

test("a session's share of the 5h limit counts only the current window", () => {
  const reading = { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-26T15:20:00Z', readAt: 0 }
  const ready = { isReady: true as const, points: 4, weightedPerPoint: 200_000, rawPerPoint: 0, weightedLeft: 0, rawLeft: 0 }
  const s = { ...record('a', 'a', 0), windowUse: { resetsAt: '2026-10-26T15:20:00Z', weighted: 500_000, points: 1 } }
  expect(limitShare(s, reading, ready)).toBe(2.5)
  // Before a point can be priced, the points its turns saw move stand in.
  expect(limitShare(s, reading, { isReady: false, points: 1 })).toBe(1)
  // Spend from a window that has since reset is no share of this one.
  expect(limitShare({ ...s, windowUse: { ...s.windowUse, resetsAt: '2026-10-26T10:20:00Z' } }, reading, ready)).toBeUndefined()
  expect(limitShare(s, undefined, ready)).toBeUndefined()
})

test('the window share sums only what started inside the five hours before the reset', () => {
  const resetsAt = '2026-10-26T15:00:00Z'
  const item = (at: string, input: number, limitPoints?: number) => ({
    kind: 'turn' as const,
    label: 'x',
    at: Date.parse(at),
    split: { input, cacheWrite: 0, cacheRead: 0, output: 0 },
    requests: 1,
    peakContext: 0,
    limitPoints,
  })
  // 09:59 belongs to the window before; 10:00 is this one's first minute.
  const items = [item('2026-10-26T09:59:00Z', 900), item('2026-10-26T10:00:00Z', 100, 1), item('2026-10-26T14:00:00Z', 50)]
  expect(spentInWindow(items, resetsAt)).toEqual({ resetsAt, weighted: 150, points: 1 })
})

test("a session that never wrote its window share shows a dash in place of the 5h number", async ($, on) => {
  engine(on, undefined, { 'session:w9': { ...record('w9', 'feat-older', 1_000_000), title: 'Older mod session', tokens: { input: 10, cacheWrite: 0, cacheRead: 0, output: 0 } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' } as never)
  await $.command.run({ command: 'coach', args: '' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^tokens 10 · \d+% \(—\)/ }))?.text).toBeDefined()
  await pane.unmount()
})

test('the line under the prompt puts the weekly limit beside the 5-hour one when the account has it', async ($, on) => {
  engine(on)
  weeklyPercent = 85
  statusText = undefined
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' } as never)
  expect(plain(statusText)).toMatch(/^5h 10% · ≈\? left \(.+\) · resets .+ │ Week 85% · resets .+$/)
  weeklyPercent = undefined
})

test('the line under the prompt shows the first limit reading at once, before the turn ends and without the pane', async ($, on) => {
  engine(on)
  statusText = undefined
  limitPercent = undefined
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(statusText).toBeUndefined()
  limitPercent = 17
  const reading = [{ kind: 'five_hour', percentUsed: 17, resetsAt: STUB_RESET }]
  await $.session.measure({ context, rateLimits: reading, changed: ['rateLimits'] } as never)
  expect(plain(statusText)).toMatch(/^5h 17% · ≈\? left \(0\/2 points measured\) · resets .+$/)
  limitPercent = 10
})

test('the limit line is empty without a reading, so nothing is pinned', () => {
  expect(limitLine([record('d', 'd', 0)], 0)).toBeUndefined()
})

test('the limit line is bold for the names and percents, italic for the reset and underlined for tokens left', async ($, on) => {
  expect(boldText('Weekly 85%')).toBe('𝗪𝗲𝗲𝗸𝗹𝘆 𝟴𝟱%')
  expect(italicText('resets in 2h')).toBe('𝘳𝘦𝘴𝘦𝘵𝘴 𝘪𝘯 2𝘩')
  expect(underlineText('≈5M left')).toBe('≈̲5̲M̲ l̲e̲f̲t̲')
  const at = Date.parse('2026-10-26T12:00:00Z')
  const r = {
    ...withCalibration('a', 750_000, 6_000_000, 3),
    fiveHour: { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-26T15:28:00Z', readAt: at },
  }
  expect(limitLine([r], at)).toBe(
    `${boldText('5h')} ${boldText('10%')} · ${underlineText('≈22.5M left')} · ${italicText(`resets 3h 28m (${fmtClock(Date.parse('2026-10-26T15:28:00Z'))})`)}`,
  )
})

test('the reset clock time is the local wall clock, hours, minutes and seconds', () => {
  const reset = Date.parse('2026-10-26T15:12:00Z')
  // Berlin in winter is one hour ahead of UTC: getTimezoneOffset gives -60.
  expect(fmtClock(reset, -60)).toBe('16:12:00')
  expect(fmtClock(reset, 0)).toBe('15:12:00')
  // Ho Chi Minh City, seven hours ahead, is already past midnight.
  expect(fmtClock(Date.parse('2026-10-26T18:05:09Z'), -420)).toBe('01:05:09')
  expect(fmtClock(reset, 300)).toBe('10:12:00')
})
