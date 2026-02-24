#!/usr/bin/env node
/**
 * hook.js
 * The pre-push git hook script.
 * Copied into .git/hooks/pre-push during `npx gatekeeper-ai init`.
 *
 * Git passes push data on stdin in the format:
 *   <local-ref> <local-sha1> <remote-ref> <remote-sha1>
 *
 * This script:
 *   1. Reads the diff of commits about to be pushed
 *   2. Builds a repo context snapshot
 *   3. Calls the Gatekeeper review service
 *   4. Renders the result in the terminal
 *   5. Logs the outcome
 *   6. Exits 0 (allow) or 1 (block) based on user choice
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve the gatekeeper-ai package root so we can import modules from it.
// When installed via npm, __dirname is inside node_modules/gatekeeper-ai/src/.
// We walk up to find the package root by looking for package.json.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  // Load environment variables from the repo's .env
  const repoRoot = getRepoRoot();
  loadEnv(repoRoot);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Gatekeeper: ANTHROPIC_API_KEY not set. Run `npx gatekeeper-ai init` to configure.');
    // Do not block push if API key is missing — fail open
    process.exit(0);
  }

  // Read push info from env var (set by the shell hook, which captured stdin
  // before reopening /dev/tty so the terminal UI can show interactive prompts).
  const pushInfo = process.env.GATEKEEPER_PUSH_DATA || '';

  // Parse the ranges of commits being pushed
  const commitRange = parsePushInfo(pushInfo, repoRoot);
  if (!commitRange) {
    // Nothing being pushed (e.g. tag-only push or empty), allow
    process.exit(0);
  }

  // Get the diff of commits being pushed
  let diff;
  try {
    diff = execSync(`git diff ${commitRange}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
  } catch (err) {
    console.error('Gatekeeper: Failed to get diff:', err.message);
    process.exit(0); // fail open
  }

  if (!diff.trim()) {
    // Empty diff — nothing to review
    console.log('✅ Gatekeeper: No code changes detected — pushing');
    process.exit(0);
  }

  // Read optional user request from GATEKEEPER_REQUEST env var
  // (Claude Code or the user can set this before pushing)
  const userRequest = process.env.GATEKEEPER_REQUEST || null;

  // Dynamically import our modules (supports both installed and dev paths)
  const pkgRoot = findPackageRoot(__dirname);
  const { buildContext } = await import(join(pkgRoot, 'src', 'context-builder.js'));
  const { review } = await import(join(pkgRoot, 'src', 'gatekeeper.js'));
  const { prompt } = await import(join(pkgRoot, 'src', 'terminal-ui.js'));
  const { logReview } = await import(join(pkgRoot, 'src', 'logger.js'));

  console.log('\nGatekeeper: Reviewing your changes...');

  let reviewResult;
  try {
    const repoContext = await buildContext({ repoRoot, diff });
    reviewResult = await review({ diff, repoContext, userRequest, apiKey });
  } catch (err) {
    console.error('Gatekeeper: Review failed:', err.message);
    // Fail open — don't block the push if Gatekeeper itself errors
    process.exit(0);
  }

  // Render terminal UI and get user decision.
  // In non-interactive mode (no /dev/tty), print the result but don't prompt —
  // allow yellow, block red so critical issues still surface.
  const nonInteractive = !!process.env.GATEKEEPER_NON_INTERACTIVE;
  let userAction;
  try {
    userAction = await prompt(reviewResult, { nonInteractive });
  } catch (err) {
    console.error('Gatekeeper: UI error:', err.message);
    process.exit(0); // fail open
  }

  // Log the outcome
  try {
    await logReview({ repoRoot, reviewResult, userAction });
  } catch {
    // Logging failure should never block a push
  }

  // Exit code determines whether git allows the push
  if (userAction === 'fix') {
    console.log('\nGatekeeper: Push cancelled. Fix the issue and try again.\n');
    process.exit(1); // block push
  }

  // 'approve' or 'override' — allow the push
  process.exit(0);
}

/**
 * Get the git repository root.
 */
function getRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
    }).trim();
  } catch {
    // Fallback to cwd
    return process.cwd();
  }
}

/**
 * Load .env file from the repo root into process.env.
 */
function loadEnv(repoRoot) {
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return;

  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Silently ignore unreadable .env
  }
}

/**
 * Parse git's pre-push stdin to build a diff range.
 *
 * Format per line: <local-ref> <local-sha1> <remote-ref> <remote-sha1>
 * Zero SHA (40 zeros) means the ref is being deleted or is new.
 */
function parsePushInfo(pushInfo, repoRoot) {
  const ZERO_SHA = '0000000000000000000000000000000000000000';
  const lines = pushInfo.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  const ranges = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;

    const [, localSha, , remoteSha] = parts;

    if (localSha === ZERO_SHA) continue; // deleting a ref — nothing to diff

    if (remoteSha === ZERO_SHA) {
      // New branch: diff against the merge-base with the default branch
      try {
        const base = execSync('git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD origin/master 2>/dev/null || git rev-list --max-parents=0 HEAD', {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim().split('\n')[0];
        if (base) ranges.push(`${base}..${localSha}`);
      } catch {
        // Fall back to just the HEAD commit
        ranges.push(`${localSha}~1..${localSha}`);
      }
    } else {
      ranges.push(`${remoteSha}..${localSha}`);
    }
  }

  if (ranges.length === 0) return null;

  // If multiple refs, use the first (most common case)
  return ranges[0];
}

/**
 * Walk up from __dirname to find the gatekeeper-ai package root
 * (the directory containing its own package.json).
 */
function findPackageRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'gatekeeper-ai') return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume src/../ is the package root
  return resolve(startDir, '..');
}

main().catch((err) => {
  console.error('Gatekeeper: Unexpected error:', err.message);
  process.exit(0); // fail open
});
