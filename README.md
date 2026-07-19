# claude-gauge

A Claude Code statusline that shows **which model you're using** and a live
**usage percentage bar** — how much of the context window is used, how much is
left, and your session cost.

```
⚡ Opus 4.8  |  █████░░░░░░░░░░ 34% used · 66% left (68k/200k)  |  $1.23
```

The bar is green under 60%, yellow to 85%, red above.

## Install

From this folder (no npm publish needed):

```sh
node bin/claude-gauge.js install
```

Or install the CLI globally first:

```sh
npm install -g .
claude-gauge install
```

Then restart Claude Code (or start a new session). `install` writes a
`statusLine` entry into `~/.claude/settings.json` (a `.claude-gauge.bak`
backup is saved first). If published to npm, `npx claude-gauge install` works
too.

## Commands

| Command | What it does |
|---|---|
| `claude-gauge install` | Wire into `~/.claude/settings.json` |
| `claude-gauge uninstall` | Remove the statusline entry |
| `claude-gauge test` | Preview the bar with sample data |

## How it works

Claude Code pipes a JSON payload to the statusline command on every refresh.
claude-gauge reads the model name from it, then gets token usage either from
the payload (newer Claude Code versions) or by tailing the last 256 KB of the
session transcript and reading the most recent assistant `usage` block
(input + cache-read + cache-creation tokens).

Context limit defaults to 200k (1M for `[1m]` models). Override with the
`CLAUDE_GAUGE_LIMIT` env var.

Zero dependencies; Node 16+.

## Notes

- The install command records the absolute path to this script — if you move
  this folder, run `install` again.
- "Usage left" here means context-window headroom for the current session,
  which is what a statusline can measure reliably. Plan rate limits (5-hour /
  weekly) aren't exposed to statusline commands; use `/usage` inside Claude
  Code for those.
