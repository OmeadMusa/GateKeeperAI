# Gatekeeper AI

A lightweight git hook that intercepts pushes, reviews them for repo integrity issues using Claude, and gives you a plain-language summary before anything lands.

**This is not a code quality tool.** Its sole purpose is to protect your repo from agentic coding mistakes: broken integrations, destructive changes, disconnected code, and pattern mismatches.

---

## Install

Run once inside any repo where you're using Claude Code (or any agentic coding tool):

```bash
npx gatekeeper-ai init
```

This will:
- Prompt for your Anthropic API key (stored in `.env`, never committed)
- Write a `pre-push` git hook
- Create a `GATEKEEPER.md` template for project-specific rules

---

## How it works

```
You push code
  → pre-push hook fires
    → Gatekeeper builds a repo context snapshot
      → Calls Claude API with context + diff
        → Renders a traffic light review in your terminal
          → You pick: Approve / Fix / Override
```

### Green — no issues
```
✅ Gatekeeper: No issues found — pushing
```
Push proceeds automatically.

### Yellow — warnings only
```
🟡 Gatekeeper Review — 1 issue found

  ⚠️  A new function called processPayment() was created but nothing calls it

What would you like to do?
  [A] Fix this first (copies fix prompt to clipboard, cancels push)
  [B] Push anyway
  [C] See full details
```

### Red — critical issues
```
🔴 Gatekeeper Review — CRITICAL issue found

  🚨 auth.js was modified even though it wasn't part of your request

What would you like to do?
  [A] Fix this first (copies fix prompt to clipboard, cancels push)  ← default
  [B] Push anyway (override)
  [C] See full details
```

Red status requires explicit confirmation to override.

---

## What Gatekeeper reviews for

In priority order:

1. **Destructive changes** — file deletions, function removals, or data overwrites that weren't part of your request
2. **Interface breakage** — function signature changes, renamed exports, or modified shared utilities that would break dependent files
3. **Disconnected code** — new files or functions that nothing calls or imports
4. **Logic duplication** — recreating logic that already exists elsewhere in the repo
5. **Pattern mismatch** — code that significantly deviates from the patterns visible in the rest of the codebase

---

## Project-specific rules

Edit `GATEKEEPER.md` in your repo root to add custom rules:

```markdown
## Protected Files
Never modify these files without explicit user instruction:
- src/auth/auth.js
- config/production.json

## Rules
- All API calls must go through /services
- Never hardcode API keys or secrets
- All new components must have a corresponding test file
```

---

## Giving Gatekeeper context

Gatekeeper reviews are more accurate when it knows what you asked for. Set `GATEKEEPER_REQUEST` before pushing:

```bash
GATEKEEPER_REQUEST="Add a payment form to the checkout page" git push
```

---

## Stats

```bash
npx gatekeeper-ai stats
```

```
Gatekeeper Stats for this repo
   Total reviews:      47
   Clean commits:      31  (66%)
   Issues flagged:     16
   User overrides:      3
   Issues prevented:   13
```

---

## Activity log

Every review is appended to `.gatekeeper/log.json` (gitignored). Format:

```json
{
  "timestamp": "2025-02-24T10:30:00Z",
  "status": "yellow",
  "issues_count": 1,
  "user_action": "fix",
  "summary": "One issue found: disconnected function."
}
```

---

## Cost

Gatekeeper uses your own Anthropic API key. No cost to the product.

- Model: `claude-sonnet-4-6`
- Max tokens: 1024 per review
- Estimated cost: ~$0.001–0.003 per review depending on repo size

---

## Uninstall

```bash
rm .git/hooks/pre-push
```

Remove `.env` entry and `.gatekeeper/` if you want a clean uninstall.
