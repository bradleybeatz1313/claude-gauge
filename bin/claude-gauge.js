#!/usr/bin/env node
/**
 * claude-gauge — universal Claude Code statusline with a usage percentage bar.
 *
 * Shows: active model + a bar of context-window usage (used / left) + cost.
 *
 * Universal install: on `install` the script copies itself to a STABLE home
 * (~/.claude/claude-gauge.js) so the statusline never depends on an ephemeral
 * npx cache dir or the folder you cloned into. The statusline command uses a
 * cross-shell form ( node "<forward-slash-path>" ) that works whether Claude
 * Code invokes it through cmd.exe, PowerShell, sh, bash, or zsh.
 *
 * Modes:
 *   claude-gauge            (JSON on stdin)  -> render statusline
 *   claude-gauge install    -> copy to ~/.claude and wire into settings.json
 *   claude-gauge uninstall  -> remove from settings.json
 *   claude-gauge doctor     -> diagnose: what Claude Code will actually render
 *   claude-gauge test       -> render with sample data
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const ESC = '\x1b[';
const RESET = ESC + '0m';
const DIM = ESC + '2m';
const BOLD = ESC + '1m';
const GREEN = ESC + '32m';
const YELLOW = ESC + '33m';
const RED = ESC + '31m';
const CYAN = ESC + '36m';

// ---------------------------------------------------------------------------
// Context-window limits
// ---------------------------------------------------------------------------
const DEFAULT_LIMIT = 200000;

function contextLimitFor(modelId) {
  const envLimit = parseInt(process.env.CLAUDE_GAUGE_LIMIT || '', 10);
  if (!isNaN(envLimit) && envLimit > 0) return envLimit;
  if (!modelId) return DEFAULT_LIMIT;
  const id = String(modelId).toLowerCase();
  if (id.includes('[1m]') || id.includes('-1m')) return 1000000;
  return DEFAULT_LIMIT;
}

// ---------------------------------------------------------------------------
// Token usage: payload first, else tail the session transcript (JSONL).
// ---------------------------------------------------------------------------
function usedTokensFromPayload(data) {
  const cw = data.context_window || data.context || null;
  if (cw && typeof cw === 'object') {
    const used =
      cw.used_tokens != null ? cw.used_tokens :
      cw.input_tokens != null ? cw.input_tokens :
      cw.tokens_used != null ? cw.tokens_used : null;
    if (used != null && isFinite(used)) {
      const size = cw.context_window_size || cw.size || cw.limit || null;
      return { used: Number(used), limit: size ? Number(size) : null, src: 'payload' };
    }
  }
  return null;
}

function usedTokensFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    const TAIL = 524288; // last 512 KB
    const start = Math.max(0, stat.size - TAIL);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch (e) { continue; }
      if (entry.isSidechain === true) continue; // subagent traffic
      const usage = entry.message && entry.message.usage;
      if (usage && usage.input_tokens != null) {
        const used =
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0);
        if (used > 0) return { used: used, limit: null, src: 'transcript' };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function bar(pct, width) {
  width = width || 15;
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const color = clamped >= 85 ? RED : clamped >= 60 ? YELLOW : GREEN;
  return color + '█'.repeat(filled) + DIM + '░'.repeat(width - filled) + RESET;
}

function renderStatusline(data) {
  const modelName =
    (data.model && (data.model.display_name || data.model.id)) || 'Claude';
  const modelId = data.model && data.model.id;

  const usage =
    usedTokensFromPayload(data) ||
    usedTokensFromTranscript(data.transcript_path);

  const parts = [];
  parts.push(CYAN + BOLD + '⚡ ' + modelName + RESET);

  if (usage) {
    const limit = usage.limit || contextLimitFor(modelId);
    const pctUsed = Math.min(999, (usage.used / limit) * 100);
    const pctLeft = Math.max(0, 100 - pctUsed);
    const usedK = (usage.used / 1000).toFixed(1).replace(/\.0$/, '');
    const limitK = Math.round(limit / 1000);
    parts.push(
      bar(pctUsed) +
        ' ' + BOLD + pctUsed.toFixed(0) + '%' + RESET +
        DIM + ' used · ' + RESET + pctLeft.toFixed(0) + '% left' +
        DIM + ' (' + usedK + 'k/' + limitK + 'k)' + RESET
    );
  } else {
    parts.push(DIM + '[context: n/a]' + RESET);
  }

  const cost = data.cost && data.cost.total_cost_usd;
  if (cost != null && isFinite(cost) && cost > 0) {
    parts.push(DIM + '$' + Number(cost).toFixed(2) + RESET);
  }

  return parts.join(DIM + '  |  ' + RESET);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function claudeDir() {
  return path.join(os.homedir(), '.claude');
}
function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}
function stableScriptPath() {
  return path.join(claudeDir(), 'claude-gauge.js');
}
function toForwardSlash(p) {
  return p.replace(/\\/g, '/');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on invalid JSON — we bail rather than clobber
}

// Universal command form:
//   node "<forward-slash absolute path>"
// - bare `node`: resolves via PATH in cmd.exe, PowerShell, and POSIX shells
//   (Claude Code's own hooks rely on bare `node`, proving it resolves).
// - forward slashes: accepted by Node on Windows and safe/unescaped in sh.
// - single quoted token starting with a letter avoids cmd.exe's
//   strip-outer-quotes footgun that bites "C:\Program Files\node.exe" forms.
function statuslineCommand() {
  return 'node "' + toForwardSlash(stableScriptPath()) + '"';
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------
function installSelf() {
  const dir = claudeDir();
  fs.mkdirSync(dir, { recursive: true });

  // 1. Copy THIS file to the stable home (decouples from npx cache / clone dir)
  const dest = stableScriptPath();
  fs.copyFileSync(__filename, dest);

  // 2. Wire into settings.json (with backup)
  const file = settingsPath();
  let settings;
  try {
    settings = readSettings(file);
  } catch (e) {
    console.error('Could not parse ' + file + ' — fix its JSON first. (' + e.message + ')');
    process.exit(1);
  }
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, file + '.claude-gauge.bak');
  }
  settings.statusLine = { type: 'command', command: statuslineCommand(), padding: 0 };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

  console.log('✓ claude-gauge installed (universal).');
  console.log('  script:   ' + dest);
  console.log('  settings: ' + file + '  (backup: ' + path.basename(file) + '.claude-gauge.bak)');
  console.log('  command:  ' + settings.statusLine.command);
  console.log('');
  console.log('Now fully RESTART Claude Code (close all sessions/windows and reopen).');
  console.log('Then run  claude-gauge doctor  if the bar does not appear.');
}

function uninstallSelf() {
  const file = settingsPath();
  let settings;
  try {
    settings = readSettings(file);
  } catch (e) {
    console.error('Could not parse ' + file + ': ' + e.message);
    process.exit(1);
  }
  if (settings.statusLine) {
    delete settings.statusLine;
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    console.log('✓ statusLine removed from ' + file);
  } else {
    console.log('No statusLine configured — nothing to remove.');
  }
  try { fs.unlinkSync(stableScriptPath()); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// doctor — show exactly what Claude Code will render, and why
// ---------------------------------------------------------------------------
function findLatestTranscript() {
  try {
    const projects = path.join(claudeDir(), 'projects');
    if (!fs.existsSync(projects)) return null;
    let best = null, bestMtime = 0;
    const walk = function (d) {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else if (name.endsWith('.jsonl') && st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs; best = full;
        }
      }
    };
    walk(projects);
    return best;
  } catch (e) { return null; }
}

function doctor() {
  const file = settingsPath();
  console.log('claude-gauge doctor');
  console.log('===================');
  console.log('home:            ' + os.homedir());
  console.log('settings.json:   ' + (fs.existsSync(file) ? file : '(missing)'));

  let settings = {};
  try { settings = readSettings(file); }
  catch (e) { console.log('settings PARSE ERROR: ' + e.message); }

  const sl = settings.statusLine;
  console.log('statusLine set:  ' + (sl ? 'yes' : 'NO  <-- run: claude-gauge install'));
  if (sl) console.log('  command:       ' + sl.command);

  const stable = stableScriptPath();
  console.log('stable script:   ' + (fs.existsSync(stable) ? stable + '  (ok)' : stable + '  MISSING <-- run install'));

  // Does the command point at something that exists?
  if (sl && sl.command) {
    const m = sl.command.match(/"([^"]+\.js)"/) || sl.command.match(/(\S+\.js)/);
    const target = m && m[1];
    if (target) {
      const native = target.replace(/\//g, path.sep);
      console.log('command target:  ' + (fs.existsSync(native) ? 'exists (ok)' : 'DOES NOT EXIST <-- run install to fix'));
    }
  }

  const t = findLatestTranscript();
  console.log('latest transcript: ' + (t || '(none found yet)'));

  console.log('');
  console.log('--- sample render (what the bar looks like) ---');
  const sample = {
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    transcript_path: t,
    cost: { total_cost_usd: 0.5 }
  };
  process.stdout.write(renderStatusline(sample) + '\n');
  console.log('-----------------------------------------------');
  console.log('If you see a bar above, the tool works. If it is missing in Claude');
  console.log('Code itself: the statusline shows in the Claude Code TERMINAL CLI at');
  console.log('the bottom of the window, and only after a FULL restart. Some IDE/');
  console.log('web clients render it differently.');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
function main() {
  const cmd = process.argv[2];

  if (cmd === 'install') return installSelf();
  if (cmd === 'uninstall') return uninstallSelf();
  if (cmd === 'doctor') return doctor();

  if (cmd === 'test') {
    const sample = {
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      transcript_path: null,
      context_window: { used_tokens: 68000, context_window_size: 200000 },
      cost: { total_cost_usd: 1.23 }
    };
    process.stdout.write(renderStatusline(sample) + '\n');
    return;
  }

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log('claude-gauge — Claude Code statusline with a usage percentage bar');
    console.log('');
    console.log('  claude-gauge install     copy to ~/.claude and wire into settings.json');
    console.log('  claude-gauge uninstall   remove it');
    console.log('  claude-gauge doctor      diagnose what Claude Code will render');
    console.log('  claude-gauge test        preview with sample data');
    console.log('');
    console.log('With no arguments it reads the statusline JSON from stdin.');
    return;
  }

  // Statusline mode: read JSON payload from stdin.
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) { input += chunk; });
  process.stdin.on('end', function () {
    let data = {};
    try { data = JSON.parse(input); } catch (e) { /* best-effort */ }
    try {
      process.stdout.write(renderStatusline(data));
    } catch (e) {
      process.stdout.write('⚡ Claude');
    }
  });
}

main();
