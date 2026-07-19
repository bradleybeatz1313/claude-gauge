#!/usr/bin/env node
/**
 * claude-gauge — Claude Code statusline with a live usage percentage bar.
 *
 * Modes:
 *   claude-gauge            (no args, JSON on stdin)  -> render statusline
 *   claude-gauge install    -> wire into ~/.claude/settings.json
 *   claude-gauge uninstall  -> remove from ~/.claude/settings.json
 *   claude-gauge test       -> render with sample data (no Claude Code needed)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// ANSI helpers (statusline output supports ANSI colors)
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
// Context-window limits by model id
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
// Token usage: prefer fields in the statusline payload, else tail the
// session transcript (JSONL) and read the most recent assistant usage block.
// ---------------------------------------------------------------------------
function usedTokensFromPayload(data) {
  // Newer Claude Code versions may include context info directly.
  const cw = data.context_window || data.context || null;
  if (cw && typeof cw === 'object') {
    const used =
      cw.used_tokens != null ? cw.used_tokens :
      cw.input_tokens != null ? cw.input_tokens :
      cw.tokens_used != null ? cw.tokens_used : null;
    if (used != null && isFinite(used)) {
      const size = cw.context_window_size || cw.size || cw.limit || null;
      return { used: Number(used), limit: size ? Number(size) : null };
    }
  }
  return null;
}

function usedTokensFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    const TAIL = 262144; // read at most the last 256 KB
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
        if (used > 0) return { used, limit: null };
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

  const transcriptPath = data.transcript_path;
  const payloadUsage = usedTokensFromPayload(data);
  const transcriptUsage = payloadUsage ? null : usedTokensFromTranscript(transcriptPath);
  const usage = payloadUsage || transcriptUsage;

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
// install / uninstall — edit ~/.claude/settings.json
// ---------------------------------------------------------------------------
function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on invalid JSON — we bail rather than clobber
}

function statuslineCommand() {
  // Absolute node + absolute script: works for local clones and global
  // installs alike, and avoids per-refresh `npx` startup cost.
  return '"' + process.execPath + '" "' + __filename + '"';
}

function installSelf() {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  settings.statusLine = { type: 'command', command: statuslineCommand() };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log('✓ claude-gauge installed as your Claude Code statusline.');
  console.log('  settings: ' + file + ' (backup: ' + file + '.claude-gauge.bak)');
  console.log('  command:  ' + settings.statusLine.command);
  console.log('Restart Claude Code (or start a new session) to see the gauge.');
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
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
function main() {
  const cmd = process.argv[2];

  if (cmd === 'install') return installSelf();
  if (cmd === 'uninstall') return uninstallSelf();

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
    console.log('  claude-gauge install     add to ~/.claude/settings.json');
    console.log('  claude-gauge uninstall   remove from ~/.claude/settings.json');
    console.log('  claude-gauge test        preview with sample data');
    console.log('');
    console.log('With no arguments it reads the Claude Code statusline JSON from stdin.');
    return;
  }

  // Statusline mode: read JSON payload from stdin.
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) { input += chunk; });
  process.stdin.on('end', function () {
    let data = {};
    try { data = JSON.parse(input); } catch (e) { /* render best-effort */ }
    try {
      process.stdout.write(renderStatusline(data));
    } catch (e) {
      process.stdout.write('⚡ Claude');
    }
  });
}

main();
