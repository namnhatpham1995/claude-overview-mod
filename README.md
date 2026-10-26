# overview: a Claude Code mod

Overview shows what your Claude Code sessions are doing and what they cost, without spending tokens
to do it:

- **Limits line** under the prompt: the five-hour and weekly usage limits, with an estimate of the
  tokens left and when the five-hour window resets.
- **Band** above the prompt: live progress while Claude works, and a short reflection on each
  finished turn.
- **Overview pane**: every session on this machine that runs the mod (controllers with their
  workers), the subagents of this session, and where the tokens went.
- **Heads-up**: an on-demand side check that names the one thing you may have missed. This is the
  only feature that uses tokens.

## Install

The mod is a plugin folder: `.claude-plugin/plugin.json` is the manifest and `hooks/register.tsx`
the code.

- **Terminal (CLI):** clone the repository and start Claude Code with the folder:

  ```bash
  git clone https://github.com/namnhatpham1995/claude-overview-mod.git
  claude --plugin-dir ./claude-overview-mod
  ```

- **Desktop app:** ask Claude in a Code session to install the mod from the cloned folder (the
  app keeps mods it is developing under `~/.claude/dev-mods/`).

Install it in **every** session you want listed in the pane: a session appears there only once it
runs the mod itself.

## What you see

### The limits line (under the prompt)

```
5h 42% · ≈1.2M left · resets 2h 05m (16:30) │ Week 18% · resets 3d 04h
```

- **5h** and **Week** are the account's usage meters, the newest reading any session took.
- **≈… left** estimates the tokens left in the five-hour window. It is learned from how far the
  meter moved during your turns, so it shows `≈? left (0/2 points measured)` until the meter has
  moved two points. When several sessions run at once, each counts the whole move, so the estimate
  errs low.
- **resets** is how long until the five-hour window resets, with the local clock time.

### The band (above the prompt)

While Claude works:

```
● working 1m 20s · 14 tool calls · 3 files edited · 1 subagent running
  ▸ Bash: pnpm test · 12s
```

It shows the running time, tool calls, edited files, running subagents, failed calls, and up to two
tool calls in flight. The only button while working is **Overview** (with the number of running
subagents).

Between turns, work left running in the background still counts as the session's work:

```
● working in the background · 1 task
  ◦ Bash: pnpm test · 2m 10s
```

Background shells, monitors and workflows are added when the call that starts them returns, and at
each stop the engine's own list of work still in flight replaces them, so a finished task does not
linger. Background subagents count too.

After a turn, the **✦ Reflect** line gives up to three findings from what the turn did:

- the turn was interrupted;
- files were edited but no test, lint or typecheck command ran;
- tool calls or subagents failed;
- a sensitive file was touched (`.env`, `*secret*`, `*credential*`, `id_rsa`);
- after any edit: "Edge cases and unrelated changes checked?";
- otherwise "Nothing to flag".

Buttons after a turn: **Heads-up (uses tokens)**, **Overview** (opens or closes the pane) and
**Hide** (hides the band until the next turn ends; `/coach show` brings it back).

### Heads-up checks

A heads-up check sends one extra request: a fork of the conversation that rereads it and names the
one thing you should know but may have missed (a silent tradeoff, a doubtful assumption, a result
that may be off, a failed step glossed over), in one sentence, or nothing.

- Start one with the **Heads-up** button in the band or the pane, or `/coach heads-up`.
- The result shows in yellow with its cost (tokens in and out). A heads-up from an earlier turn is
  shown in blue as **Earlier heads-up**.
- **Ask Claude** (hotkey 1) puts the heads-up into your prompt box, so you can ask about it.
  **Knew this** (hotkey 2) remembers the topic so later checks do not repeat it (the last 30
  topics are kept). **✕** (hotkey 0) closes it.

### The Overview pane

Open it with the **Overview** button or `/coach`. It has three sections.

**Sessions on this machine**: one card per session running the mod, with a blank row between
unrelated sessions. Working sessions come first (a controller counts as working while one of its
workers does), then the others by when they last worked, newest first; sessions that never spent
a token come last.

- A **controller** (magenta) is a session that started or briefed other sessions; its **workers**
  (blue) are nested under it. The link comes from the calls that start, message or clear a
  session, since the app does not record it.
- A working session's border blinks cyan. A session whose turn has ended but whose background
  tasks or subagents still run reads **working in the background**, with each task listed. A
  session with no update for 3 minutes is shown dim as stale; records older than a day are deleted.
- Each card shows the project and folder, tool calls, edits, failures, the calls in flight, a
  **Subagents** box with the session's subagents (this session's finished ones too), the last
  reflection, what another session's last turn asked you (**? asks**), and the tokens: `tokens 2.4M · 35% (4.1%) · $3.20` is the
  session's tokens, its share of all listed sessions' use, its share of the five-hour limit, and
  its cost at API prices.
- **Explore** opens **Where the tokens went**: all tokens split into input, cache write, cache
  read and output; the ten costliest turns, subagents and checks, with requests, peak context and
  how far each moved the five-hour meter; and hints.
- **Save tokens** (this session only) opens **Ways to save tokens**: MCP servers whose tools
  never ran, a large context, long replies, costly subagents, a large instructions file, frequent
  heads-up checks. **Ask Claude to apply** puts the request into your prompt box; nothing is sent
  until you send it. The check itself uses no tokens.

This session's **Subagents** box, inside its card, lists its running subagents and up to 15
finished ones, with type, model, tokens, steps and time.

**Last turn**: the reflection of the last finished turn, then up to three questions Claude asked
you in it (**? Claude asks**): the next-step box's question and the sentences of its last answer
that end in a question mark. They are read from the answer's text, so they cost no tokens.

**Session**: turns so far, heads-up checks and what they cost, and a Heads-up button.

## Commands

| Command | What it does |
|---|---|
| `/coach` | Opens or closes the Overview pane |
| `/coach heads-up` | Runs one heads-up check (uses tokens) |
| `/coach show` | Shows the band again after **Hide** |
| `/coach forget` | Forgets the topics marked **Knew this** |

## Setting

**Heads-up checks** (`headsUp`, in the mod's settings in `/config`):

- `manual` (default): a check runs only when you ask for one, so no tokens are used otherwise.
- `auto`: also after a turn with 10 or more tool calls, at most once every 10 minutes.

## Cost and privacy

- Everything except the heads-up check runs locally and sends no request.
- Each session writes a small status record to the mod's store, which all sessions on this
  machine share: its name, project and folder, counts, token use, the labels of tool calls in
  flight (for a shell command, its first 60 characters) and its last reflection. Nothing leaves
  the machine.
- To show the session's name, the mod reads the app's session files in `~/.claude/sessions/`.
- Token shares weigh tokens by API price: a cache write counts 1.25 input tokens, a cache read a
  tenth of one, an output token five.

## Development

- `hooks/register.tsx` registers the hooks; `types/index.d.ts` holds the mod's own types.
- `hooks/register.test.tsx` holds the tests, written with the `claude-code/testing` harness.
- `.claude-plugin/types/` holds the Claude Code type definitions the app generates; it is not
  committed.

The subagent tracking follows [savvy-progress](https://github.com/johnnyvizz/claude-kit) (MIT,
copyright 2026 johnnyvizz).

## License

[MIT](LICENSE).
