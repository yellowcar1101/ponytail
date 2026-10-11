#!/usr/bin/env node
// ponytail — Claude Code SubagentStart hook
//
// SessionStart context is parent-thread only and never reaches subagents, so
// without this every Task-spawned agent runs ponytail-unaware (issue #252).
// When ponytail mode is active, inject the same ruleset into each subagent.
//
// Scoping (opt-in, issue #506): set PONYTAIL_SUBAGENT_MATCHER to a regex and
// the ruleset is injected only into subagents whose agent_type matches. The
// regex is unanchored and case-insensitive — "explore|general" matches either,
// "^general$" is exact. Unset means inject into every subagent, as before.

const { getPonytailInstructions } = require('./ponytail-instructions');
const { isCodex, readMode, writeHookOutput } = require('./ponytail-runtime');
const vm = require('vm');

function inject(mode) {
  try {
    writeHookOutput('SubagentStart', mode, getPonytailInstructions(mode));
  } catch (e) {
    // Silent fail — a stdout error at hook exit must not surface as a hook failure.
  }
}

// A bad regex must never crash the hook; treat it as "no matcher" and inject.
let matcherRe = null;
try {
  if (process.env.PONYTAIL_SUBAGENT_MATCHER) {
    matcherRe = new RegExp(process.env.PONYTAIL_SUBAGENT_MATCHER, 'i');
  }
} catch (e) {
  matcherRe = null;
}

// Other hosts keep the synchronous path when no matcher is configured. Codex
// needs stdin to identify the parent session when two chats share a project.
if (!isCodex && !matcherRe) {
  const mode = readMode();
  if (mode && mode !== 'off') inject(mode);
  process.exit(0);
}

// Read session_id as well as agent_type for Codex subagents.
let input = '';
let done = false;

function finish() {
  if (done) return;
  done = true;

  let agentType = '';
  let sessionId = '';
  try {
    // Strip UTF-8 BOM some shells prepend when piping (breaks JSON.parse)
    const data = JSON.parse(input.replace(/^\uFEFF/, ''));
    agentType = String(data.agent_type || '').trim();
    sessionId = data.session_id;
  } catch (e) {
    // Unparseable payload — use the legacy shared mode.
  }
  const mode = readMode(sessionId);
  if (!mode || mode === 'off') return;
  if (!matcherRe) { inject(mode); return; }
  // .test() is synchronous, so a backtracking-heavy matcher like (a+)+$ would
  // block the event loop and the fallback timer below could never fire (#658).
  // Run it under a vm timeout; a timeout fails open like every other doubt.
  let matches = true;
  try {
    if (agentType) {
      matches = vm.runInNewContext('re.test(s)', { re: matcherRe, s: agentType }, { timeout: 100 });
    }
  } catch (e) {
    matches = true;
  }
  if (!matches) {
    process.exit(0);
  }
  inject(mode);
}

process.stdin.on('data', chunk => { input += chunk; });
// Exit on 'end' (not just finish()) so the ref'd fallback timer below can't
// add its full 1000ms to the normal fast path.
process.stdin.on('end', () => { finish(); process.exit(0); });
// Never block the session (#443): recover on stdin error or a short fallback.
// The fallback stays ref'd: on Windows a stuck ref'd stdin keeps the loop
// alive and an unref'd timer is never scheduled (#790). Without a matcher,
// stop after 250ms; a matcher keeps the previous 1s limit.
process.stdin.on('error', () => { finish(); process.exit(0); });
setTimeout(() => { finish(); process.exit(0); }, matcherRe ? 1000 : 250);
