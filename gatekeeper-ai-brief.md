# Gatekeeper AI — Product Brief
## Build Brief for Claude Code

---

## What We're Building

A lightweight CLI tool that sits between Claude Code (or any agentic coding tool) and a git repository. Its job is to intercept commits, review them for repo integrity issues, and give the user a plain-language summary before anything gets merged. The user stays in control — they approve, fix, or override.

This is not a code quality or bug-detection tool. Its sole purpose is to protect the repo from agentic coding mistakes: broken integrations, destructive changes, disconnected code, and pattern mismatches.

---

## Core User Flow

```
User talks to Claude Code
  → Claude Code writes and attempts to commit code
    → Pre-push git hook fires (Gatekeeper intercepts)
      → Gatekeeper builds repo context snapshot
        → Gatekeeper calls Anthropic API with context + diff
          → Returns structured review result
            → Terminal renders traffic light summary
              → User picks: Approve / Fix / Override
```

---

## Architecture

### Components

**1. Git Hook (`pre-push`)**
- Fires automatically on every push attempt
- Captures the diff of staged changes
- Calls the Gatekeeper service
- Blocks or allows the push based on user's terminal input

**2. Repo Context Builder**
- Generates a lightweight snapshot of the repo for each review
- Includes:
  - Full file tree (names and paths only)
  - Full content of files the diff directly modifies
  - Function/class signatures (not full content) of files that import modified files
  - Contents of `GATEKEEPER.md` if present (project-specific rules)
- Does NOT include: full content of unrelated files, node_modules, build artifacts, binary files

**3. Gatekeeper Service**
- A standalone Node.js module (clean function, no side effects)
- Takes: diff, repo context snapshot, original user request (if available)
- Calls Anthropic API using the user's own API key
- Returns: structured JSON review result
- Designed to be easily wrapped as an MCP server later

**4. Terminal UI**
- Renders in the terminal using Claude Code's existing MCQ hook pattern
- Shows traffic light status + plain-language issue list
- Presents three options as a multiple choice prompt
- Writes to an activity log after every review

**5. Installer**
- Single NPX command: `npx gatekeeper-ai init`
- Writes git hook to `.git/hooks/pre-push`
- Creates `GATEKEEPER.md` template in repo root
- Prompts for Anthropic API key, stores in local `.env`
- Adds `.env` to `.gitignore` automatically

---

## The Gatekeeper System Prompt

The gatekeeper should be initialised with this system prompt:

```
You are a repository integrity reviewer. Your job is to protect a codebase from 
agentic coding mistakes — not to judge code quality, fix bugs, or suggest improvements.

You will receive:
- A git diff of proposed changes
- A snapshot of the repository structure
- The user's original request (if available)

Review the diff ONLY for these five issues, in priority order:

1. DESTRUCTIVE CHANGES
   Does the diff delete, overwrite, or rename anything that wasn't mentioned 
   in the user's original request? Flag any file deletions, function removals, 
   or data overwrites that seem unintentional.

2. INTERFACE BREAKAGE  
   Does the diff change a function signature, rename an export, or modify a 
   shared utility in a way that would break other files that depend on it? 
   Check the provided import graph.

3. DISCONNECTED CODE
   Is new code being added that nothing calls, imports, or connects to? 
   New files or functions with no entry point are a common agentic failure mode.

4. LOGIC DUPLICATION
   Does this recreate logic that clearly already exists elsewhere in the repo? 
   Check function names and patterns in the file tree.

5. PATTERN MISMATCH
   Does the code significantly deviate from the patterns visible in the rest 
   of the codebase? (e.g. switching paradigms, using different error handling 
   approaches, inconsistent naming conventions)

Also respect any rules in GATEKEEPER.md if provided.

Return ONLY valid JSON in this exact schema — no explanation, no markdown:

{
  "status": "green" | "yellow" | "red",
  "issues": [
    {
      "severity": "warning" | "critical",
      "category": "destructive" | "interface_breakage" | "disconnected" | "duplication" | "pattern_mismatch",
      "plain_english": "One sentence description a non-developer can understand",
      "fix_prompt": "Specific instruction to send back to Claude Code to fix this issue"
    }
  ],
  "summary": "One sentence plain-english summary of the overall review"
}

Status rules:
- green: no issues found
- yellow: issues found but none are critical
- red: one or more critical issues found

If no issues are found, return an empty issues array.
```

---

## Output Schema

```json
{
  "status": "yellow",
  "issues": [
    {
      "severity": "critical",
      "category": "destructive",
      "plain_english": "auth.js was modified even though it wasn't part of your request",
      "fix_prompt": "You modified auth.js but the user only asked you to update the dashboard. Revert any changes to auth.js and achieve the goal without touching authentication files."
    },
    {
      "severity": "warning", 
      "category": "disconnected",
      "plain_english": "A new function called processPayment() was created but nothing in the codebase calls it",
      "fix_prompt": "You created processPayment() in payments.js but it is never imported or called anywhere. Either connect it to the relevant part of the app or remove it."
    }
  ],
  "summary": "One critical issue found: auth.js was modified unexpectedly."
}
```

---

## Terminal UI Behaviour

### Green (no issues)
```
✅ Gatekeeper: No issues found — committing
```
Commit proceeds automatically, entry written to log.

### Yellow (warnings only)
```
🟡 Gatekeeper Review — 1 issue found

  ⚠️  A new function called processPayment() was created but nothing calls it

What would you like to do?
  [A] Fix this first (copies fix prompt to clipboard, cancels commit)
  [B] Commit anyway
  [C] See full details
```

### Red (critical issues)
```
🔴 Gatekeeper Review — CRITICAL issue found

  🚨 auth.js was modified even though it wasn't part of your request

What would you like to do?
  [A] Fix this first (copies fix prompt to clipboard, cancels commit)  ← default
  [B] Commit anyway (override)
  [C] See full details
```

For red status, option B should require confirmation: "Are you sure you want to override a critical issue? (y/N)"

---

## Activity Log

Every review appended to `.gatekeeper/log.json` in the repo root (add to `.gitignore`).

```json
{
  "timestamp": "2025-02-24T10:30:00Z",
  "status": "yellow",
  "issues_count": 1,
  "user_action": "fix" | "approve" | "override",
  "summary": "One issue found: disconnected function."
}
```

A `npx gatekeeper-ai stats` command renders a summary:
```
📊 Gatekeeper Stats for this repo
   Total reviews:     47
   Clean commits:     31 (66%)
   Issues flagged:    16
   User overrides:     3
   Issues prevented:  13
```

---

## GATEKEEPER.md Template

Created at `npx gatekeeper-ai init`. User can edit to add project-specific rules.

```markdown
# Gatekeeper Rules

This file contains project-specific rules for the Gatekeeper AI reviewer.
Add rules below to customise what gets flagged in this repo.

## Protected Files
Never modify these files without explicit user instruction:
- (add files here, e.g. src/auth/auth.js)

## Rules
- (add custom rules here, e.g. "All API calls must go through /services")
- (e.g. "Never hardcode API keys or secrets")
- (e.g. "All new components must have a corresponding test file")
```

---

## Install Flow

```bash
# Run once in any repo where Claude Code is being used
npx gatekeeper-ai init

# Prompts:
# → Anthropic API key (stored in .env, added to .gitignore)
# → GATEKEEPER.md created with template
# → .git/hooks/pre-push written
# → "Gatekeeper is active. It will review all future commits."
```

---

## File Structure of the Package

```
gatekeeper-ai/
├── bin/
│   └── cli.js              # npx entry point (init, stats commands)
├── src/
│   ├── hook.js             # The pre-push hook script (copied into .git/hooks)
│   ├── gatekeeper.js       # Core review function (standalone, no side effects)
│   ├── context-builder.js  # Repo snapshot builder (file tree, signatures, diff)
│   ├── terminal-ui.js      # MCQ terminal renderer
│   └── logger.js           # Activity log writer/reader
├── templates/
│   └── GATEKEEPER.md       # Default template
├── package.json
└── README.md
```

---

## API Usage

The gatekeeper uses the user's own Anthropic API key. No cost to the product.

Model: `claude-sonnet-4-6` (fast, cheap, sufficient for structured review tasks)
Max tokens: 1024 (output is structured JSON, will always be small)
Estimated cost per review: ~$0.001–0.003 depending on repo size

---

## What This Is NOT

- Not a bug detector
- Not a code quality reviewer  
- Not a linter or formatter
- Not a security scanner
- Not autonomous — the user always has final approval

---

## Future State (Not in Scope for MVP)

- **Auto-fix loop**: Gatekeeper feedback sent directly back to Claude Code, retries automatically before surfacing to user
- **CLAUDE.md injection**: Write fix instructions into CLAUDE.md for automatic Claude Code pickup
- **MCP server**: Wrap `gatekeeper.js` as an MCP tool so Claude Code consults it natively before committing (clean migration path because core logic is already isolated)
- **Web dashboard**: Visual activity log and stats across multiple repos
- **Team rules**: Shared `GATEKEEPER.md` committed to repo so the whole team (human and AI) follows the same rules

---

## Build Instructions for Claude Code

Build this in the following order:

1. `gatekeeper.js` — the core review function. Test it standalone with a hardcoded diff before wiring anything else.
2. `context-builder.js` — repo snapshot generator. Test that it produces sensible output for this repo.
3. `terminal-ui.js` — MCQ renderer. Test with a hardcoded review result.
4. `hook.js` — wire 1+2+3 together. Test by triggering a push manually.
5. `logger.js` — activity log. Add after the core loop works.
6. `cli.js` — init command and stats command. Add last.

Do not add complexity beyond what's described here. The MVP is a working git hook with a clean terminal UI and an activity log. Nothing more.
