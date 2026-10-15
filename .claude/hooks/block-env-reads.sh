#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash). Denies shell commands that mention .env files, so secrets
# never enter the conversation through command output. .env.example is allowed (no secrets).
#
# Best-effort guard, not a security boundary: a command can still build the file name dynamically.
# The matching Read deny rules in settings.json cover Claude's own file tools; this covers Bash
# (grep -r, scripts that open the file, etc.), which Read rules do not.
set -u

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Names such as .env, .env.local, .env.production, .env*, --env-file=.env.local.
# Not matched: process.env.X (the dot follows a letter), foo.env, and .env.example.
hits=$(printf '%s' "$cmd" | grep -oP '(?<![A-Za-z0-9_])\.env[A-Za-z0-9_.*-]*' | grep -vxF '.env.example' || true)

if [ -n "$hits" ]; then
  reason="Blocked by project policy: commands must not touch .env files (they hold secrets). Read environment variables from code instead, or ask the owner."
  jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
fi
exit 0
