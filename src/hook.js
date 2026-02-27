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
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Skip review if fewer than this many changed lines (trivial pushes)
const TRIVIAL_LINE_THRESHOLD = 20;

// Written at module load time so we always know the hook ran, even if it exits silently
let _debugLogPath = null;

function debugLog(repoRoot, message) {
  try {
    const dir = join(repoRoot, '.gatekeeper');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _debugLogPath = join(dir, 'hook-debug.log');
    const ts = new Date().toISOString();
    appendFileSync(_debugLogPath, `[${ts}] ${message}\n`, 'utf8');
  } catch {
    // debug logging must never block a push
  }
}

// Cache TTL: don't re-review the same diff within this window
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Resolve the gatekeeper-ai package root so we can import modules from it.
// When installed via npm, __dirname is inside node_modules/gatekeeper-ai/src/.
// We walk up to find the package root by looking for package.json.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  // Load environment variables from the repo's .env
  const repoRoot = getRepoRoot();
  loadEnv(repoRoot);

  debugLog(repoRoot, `hook started | pid=${process.pid} | cwd=${repoRoot}`);

  // Check for override flag (set by `npx gatekeeper-ai review` when user overrides)
  if (process.env.GATEKEEPER_OVERRIDE === '1') {
    debugLog(repoRoot, 'EXIT: GATEKEEPER_OVERRIDE=1 — skipping review');
    console.log('Gatekeeper: Override active — skipping review');
    process.exit(0);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    debugLog(repoRoot, 'EXIT: no API key — failing open');
    console.error('Gatekeeper: ANTHROPIC_API_KEY not set. Run `npx gatekeeper-ai init` to configure.');
    process.exit(0);
  }

  // Read push info from env var (set by the shell hook, which captured stdin
  // before reopening /dev/tty so the terminal UI can show interactive prompts).
  // GUI clients (VSCode, Tower, etc.) often pass empty stdin, so we fall back
  // to inferring the commit range directly from git when pushInfo is absent.
  const pushInfo = process.env.GATEKEEPER_PUSH_DATA || '';
  debugLog(repoRoot, `pushInfo from stdin: ${pushInfo ? JSON.stringify(pushInfo.slice(0, 200)) : '(empty)'}`);

  // Parse the ranges of commits being pushed
  const parsedRange = parsePushInfo(pushInfo, repoRoot);
  const commitRange = parsedRange || inferCommitRange(repoRoot);
  debugLog(repoRoot, `parsedRange=${parsedRange} | inferredRange=${parsedRange ? 'n/a' : commitRange} | final=${commitRange}`);

  if (!commitRange) {
    debugLog(repoRoot, 'EXIT: no commit range — nothing to push (tag-only or already up-to-date)');
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
    debugLog(repoRoot, `EXIT: git diff failed — ${err.message}`);
    console.error('Gatekeeper: Failed to get diff:', err.message);
    process.exit(0); // fail open
  }

  if (!diff.trim()) {
    debugLog(repoRoot, 'EXIT: empty diff — no code changes');
    console.log('✅ Gatekeeper: No code changes detected — pushing');
    process.exit(0);
  }

  // Skip trivial pushes (below line threshold)
  const changedLines = diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length;
  debugLog(repoRoot, `changedLines=${changedLines} | threshold=${TRIVIAL_LINE_THRESHOLD}`);
  if (changedLines < TRIVIAL_LINE_THRESHOLD) {
    debugLog(repoRoot, 'EXIT: trivial change — skipping review');
    console.log(`✅ Gatekeeper: Trivial change (${changedLines} lines) — skipping review`);
    process.exit(0);
  }

  // Check diff hash cache to avoid re-reviewing identical diffs
  const diffHash = createHash('sha256').update(diff).digest('hex');
  const cachedResult = readCache(repoRoot, diffHash);
  debugLog(repoRoot, `diffHash=${diffHash.slice(0, 16)}… | cached=${cachedResult ? cachedResult.status : 'none'}`);

  // Read optional user request from GATEKEEPER_REQUEST env var
  // (Claude Code or the user can set this before pushing)
  const userRequest = process.env.GATEKEEPER_REQUEST || null;

  // Dynamically import our modules (supports both installed and dev paths)
  const pkgRoot = findPackageRoot(__dirname);
  const { buildContext } = await import(join(pkgRoot, 'src', 'context-builder.js'));
  const { review } = await import(join(pkgRoot, 'src', 'gatekeeper.js'));
  const { prompt } = await import(join(pkgRoot, 'src', 'terminal-ui.js'));
  const { logReview } = await import(join(pkgRoot, 'src', 'logger.js'));

  let reviewResult;

  if (cachedResult && cachedResult.status === 'green') {
    // Green cached result: auto-pass without re-reviewing or showing UI
    debugLog(repoRoot, 'EXIT: green cache hit — auto-passing');
    console.log(`\n✅ Gatekeeper: Same diff reviewed recently — ${cachedResult.summary}`);
    process.exit(0);
  } else if (cachedResult) {
    // Non-green cached result: skip the API call but still show the UI
    // so the user must acknowledge the issue before the push goes through.
    const ageMs = Date.now() - cachedResult.timestamp;
    const ageMin = Math.round(ageMs / 60000);
    const ageLabel = ageMin < 1 ? 'just now' : `${ageMin} minute${ageMin === 1 ? '' : 's'} ago`;
    debugLog(repoRoot, `cache hit (${cachedResult.status}) — replaying through UI`);
    console.log(`\nGatekeeper: Replaying review from ${ageLabel} (same diff detected — did you commit your fix?)`);
    reviewResult = cachedResult;
  } else {
    // Fresh review
    debugLog(repoRoot, 'no cache — calling review API');
    console.log('\nGatekeeper: Reviewing your changes...');
    const slowTimer = setTimeout(() => {
      console.log('  (still reviewing, large diffs take longer...)');
    }, 5000);
    try {
      const repoContext = await buildContext({ repoRoot });
      reviewResult = await review({ diff, repoContext, userRequest, apiKey });
      clearTimeout(slowTimer);
      debugLog(repoRoot, `review result: ${reviewResult.status} | issues=${reviewResult.issues?.length ?? 0}`);
      writeCache(repoRoot, diffHash, reviewResult);
    } catch (err) {
      clearTimeout(slowTimer);
      debugLog(repoRoot, `EXIT: review API failed — ${err.message}`);
      console.error('Gatekeeper:', formatApiError(err));
      process.exit(0); // fail open
    }
  }

  // Detect whether we have an interactive terminal by trying to open /dev/tty.
  // This is more reliable than checking env vars set by the shell.
  const nonInteractive = !canOpenTty();
  debugLog(repoRoot, `nonInteractive=${nonInteractive}`);
  let userAction;
  try {
    userAction = await prompt(reviewResult, { nonInteractive, repoRoot, isCachedReplay: !!cachedResult });
  } catch (err) {
    debugLog(repoRoot, `EXIT: UI error — ${err.message}`);
    console.error('Gatekeeper: UI error:', err.message);
    process.exit(0); // fail open
  }

  // If user chose to re-review, force a fresh API call
  if (userAction === 're-review') {
    debugLog(repoRoot, 'user requested re-review — calling API');
    console.log('\nGatekeeper: Re-reviewing your changes...');
    try {
      const repoContext = await buildContext({ repoRoot });
      reviewResult = await review({ diff, repoContext, userRequest, apiKey });
      debugLog(repoRoot, `re-review result: ${reviewResult.status} | issues=${reviewResult.issues?.length ?? 0}`);
      writeCache(repoRoot, diffHash, reviewResult);
    } catch (err) {
      debugLog(repoRoot, `EXIT: re-review API failed — ${err.message}`);
      console.error('Gatekeeper:', formatApiError(err));
      process.exit(0); // fail open
    }

    // Show the fresh result
    try {
      userAction = await prompt(reviewResult, { nonInteractive, repoRoot, isCachedReplay: false });
    } catch (err) {
      debugLog(repoRoot, `EXIT: UI error on re-review — ${err.message}`);
      console.error('Gatekeeper: UI error:', err.message);
      process.exit(0);
    }
  }

  debugLog(repoRoot, `userAction=${userAction}`);

  // Log the outcome
  try {
    await logReview({ repoRoot, reviewResult, userAction });
  } catch {
    // Logging failure should never block a push
  }

  // Exit code determines whether git allows the push
  if (userAction === 'fix') {
    debugLog(repoRoot, 'EXIT 1: user chose fix — blocking push');
    // Write the pending review so `npx gatekeeper-ai review` can pick it up
    try {
      const pendingPath = join(repoRoot, '.gatekeeper', 'last-review.json');
      writeFileSync(pendingPath, JSON.stringify(reviewResult, null, 2), 'utf8');
    } catch { /* ignore */ }
    console.log('\nGatekeeper: Push cancelled. Fix the issues and push again.');
    console.log(`Tip: Run \x1b[2mnpx gatekeeper-ai review\x1b[0m to see details or override.\n`);
    process.exit(1); // block push
  }

  // 'approve' or 'override' — allow the push
  debugLog(repoRoot, `EXIT 0: user action=${userAction} — allowing push`);
  process.exit(0);
}

/**
 * Read a cached review result for this diff hash, if it exists and is fresh.
 */
function readCache(repoRoot, diffHash) {
  const cachePath = join(repoRoot, '.gatekeeper', 'cache.json');
  if (!existsSync(cachePath)) return null;
  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    const entry = cache[diffHash];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      // Prune this and any other expired entries while we're here
      let pruned = false;
      for (const [key, e] of Object.entries(cache)) {
        if (Date.now() - e.timestamp > CACHE_TTL_MS) { delete cache[key]; pruned = true; }
      }
      if (pruned) {
        try { writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8'); } catch { /* ignore */ }
      }
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Write a review result to the diff hash cache.
 */
function writeCache(repoRoot, diffHash, reviewResult) {
  const cacheDir = join(repoRoot, '.gatekeeper');
  const cachePath = join(cacheDir, 'cache.json');
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    let cache = {};
    if (existsSync(cachePath)) {
      try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* start fresh */ }
    }
    cache[diffHash] = { status: reviewResult.status, summary: reviewResult.summary, issues: reviewResult.issues ?? [], timestamp: Date.now() };
    // Prune entries older than TTL to keep the file small
    for (const [key, entry] of Object.entries(cache)) {
      if (Date.now() - entry.timestamp > CACHE_TTL_MS) delete cache[key];
    }
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // Cache write failure must never block a push
  }
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
 * Fallback commit range inference for when stdin push data is unavailable
 * (e.g. GUI clients like VSCode, Tower, Fork that don't pipe stdin to hooks).
 *
 * Uses the reflog to find what the remote tracking branch pointed to *before*
 * this push — that's the reliable boundary regardless of timing. Falls back
 * through progressively simpler strategies.
 */
function inferCommitRange(repoRoot) {
  // Strategy 1: use the reflog of the remote tracking branch.
  // origin/main@{1} is where origin/main was before the most recent update,
  // which (for a push) is the last-known remote state before our commits.
  const trackingBranches = ['origin/main', 'origin/master'];
  for (const branch of trackingBranches) {
    try {
      const prev = execSync(`git rev-parse "${branch}@{1}"`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const head = execSync('git rev-parse HEAD', {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (prev && prev !== head) {
        return `${prev}..${head}`;
      }
    } catch {
      // branch doesn't exist, try next
    }
  }

  // Strategy 2: find the merge-base between HEAD and any remote tracking ref,
  // then diff from there. Works for new branches pushed for the first time.
  try {
    const remoteRefs = execSync('git for-each-ref --format="%(refname:short)" refs/remotes/origin', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    for (const ref of remoteRefs) {
      try {
        const base = execSync(`git merge-base HEAD ${ref}`, {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const head = execSync('git rev-parse HEAD', {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (base && base !== head) {
          return `${base}..${head}`;
        }
      } catch { /* try next */ }
    }
  } catch { /* fall through */ }

  // Strategy 3: last resort — diff just the most recent commit
  try {
    execSync('git rev-parse HEAD~1', { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    return 'HEAD~1..HEAD';
  } catch {
    return null;
  }
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

/**
 * Check whether /dev/tty is available for interactive input.
 * More reliable than checking shell env vars or process.stdin.isTTY,
 * because git hooks have stdin consumed by push data.
 */
function canOpenTty() {
  if (process.platform === 'win32') return false;
  try {
    const fd = openSync('/dev/tty', 'r+');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map API errors to actionable user-facing messages.
 */
function formatApiError(err) {
  const msg = err.message || '';
  const status = err.status || err.statusCode || 0;

  if (status === 401 || msg.includes('401') || msg.includes('Unauthorized')) {
    return 'Invalid API key. Check ANTHROPIC_API_KEY in .env or run `npx gatekeeper-ai init`. Push allowed — review skipped.';
  }
  if (status === 429 || msg.includes('429') || msg.includes('rate')) {
    return 'API rate limited. Push allowed — try again in a minute.';
  }
  if (status >= 500 || msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return 'API temporarily unavailable. Push allowed — review skipped.';
  }
  if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('ETIMEDOUT') || msg.includes('AbortError')) {
    return 'Review timed out after 30s. Push allowed — review skipped.';
  }
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('network')) {
    return 'Could not reach API (check your internet). Push allowed — review skipped.';
  }

  return `Review failed: ${msg}. Push allowed — review skipped.`;
}

main().catch((err) => {
  // Best-effort debug log — repoRoot may not be set if we crashed very early
  try {
    const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    debugLog(root, `EXIT: unexpected error — ${err.message}\n${err.stack}`);
  } catch { /* ignore */ }
  console.error('Gatekeeper: Unexpected error:', err.message);
  process.exit(0); // fail open
});
