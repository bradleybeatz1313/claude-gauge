# claude-gauge

A Claude Code statusline that shows **which model you're using** and a live
**usage percentage bar** — how much of the context window is used, how much is
left, and your session cost.

```
⚡ Opus 4.8  |  █████░░░░░░░░░░ 34% used · 66% left (68k/200k)  |  $1.23
```

The bar is green under 60%, yellow to 85%, red above.

## Install globally (from GitHub)

```sh
npm install -g github:bradleybeatz1313/claude-gauge
claude-gauge install
```

Or run it without installing:

```sh
npx github:bradleybeatz1313/claude-gauge install
```

Then restart Claude Code (or start a new session). `install` writes a
`statusLine` entry into `~/.claude/settings.json` (a `.claude-gauge.bak`
backup is saved first).

### From a local clone

```sh
git clone https://github.com/bradleybeatz1313/claude-gauge
cd claude-gauge
node bin/claude-gauge.js install
```

## Commands

| Command | What it does |
|---|---|
| `claude-gauge install` | Copy to `~/.claude/` and wire into `settings.json` |
| `claude-gauge uninstall` | Remove the statusline entry and stable script |
| `claude-gauge doctor` | Diagnose exactly what Claude Code will render |
| `claude-gauge test` | Preview the bar with sample data |

## Universal by design

`install` doesn't point Claude Code at your clone folder or an npx cache dir
(both can move or get wiped). It **copies the script to a stable home**,
`~/.claude/claude-gauge.js`, and writes a cross-shell command:

```
node "<home>/.claude/claude-gauge.js"
```

Bare `node` resolves via PATH in cmd.exe, PowerShell, and POSIX shells;
forward slashes are safe everywhere and dodge Windows' nested-quote footgun.
So it renders the same whether Claude Code invokes the statusline through
cmd.exe, PowerShell, sh, bash, or zsh — on Windows, macOS, or Linux.

## Not seeing the bar?

Run `claude-gauge doctor` — it prints the settings path, whether the command
target exists, the transcript it found, and a live sample render. Note the
statusline appears in the **Claude Code terminal CLI** at the bottom of the
window and only after a **full restart** (close every session and reopen).

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
