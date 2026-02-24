# Gatekeeper Rules

## Protected Files
Never modify these files without explicit user instruction:
- bin/cli.js
- src/gatekeeper.js
- src/hook.js
- package.json
- templates/GATEKEEPER.md
- .gitattributes

## Rules
- This is a Node.js ESM project (`"type": "module"`) — all files must use ES module syntax (`import`/`export`), never `require()`
- Diff review API calls must go through `src/gatekeeper.js`; repo scan API calls go through `src/scanner.js` — do not make Anthropic API calls elsewhere
- All terminal output and UI rendering must go through `src/terminal-ui.js` and `src/logger.js`
- Colour handling must go through `src/colors.js` — do not introduce additional colour/styling libraries
- Repo context assembly must go through `src/context-builder.js`
- The CLI entry point is `bin/cli.js` — no additional entry points should be created
- Source files belong in `src/` — do not place logic in `bin/`
- Project templates belong in `templates/` — do not hardcode template content in source files
- Do not add runtime dependencies without explicit user instruction; keep the dependency footprint minimal
- The Claude model in use is `claude-sonnet-4-6` — do not change the model without explicit instruction
- Max tokens per review is 1024 — do not increase this without explicit instruction
- Never hardcode API keys or secrets; the Anthropic API key must be read from `.env` only
- Tests must be run via Jest with `--experimental-vm-modules` as configured in `package.json`
- Node.js >= 18.0.0 is required — do not use APIs unavailable in Node 18
- `.gatekeeper/log.json` is runtime-generated and gitignored — do not commit it or treat it as a source file

## Stack
- **Language:** JavaScript (Node.js, ESM)
- **Runtime:** Node.js >= 18.0.0
- **Framework:** None (plain Node.js CLI tool)
- **AI SDK:** `@anthropic-ai/sdk` (Anthropic Claude)
- **Test runner:** Jest (with `--experimental-vm-modules`)
- **Package manager:** npm
- **Distribution:** npx-compatible via `bin` field in `package.json`
