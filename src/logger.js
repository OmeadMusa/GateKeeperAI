/**
 * logger.js
 * Reads and writes Gatekeeper activity log at .gatekeeper/log.json.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const LOG_DIR = '.gatekeeper';
const LOG_FILE = 'log.json';

/**
 * Append a review result and user action to the activity log.
 *
 * @param {object} params
 * @param {string} params.repoRoot - Absolute path to repo root
 * @param {object} params.reviewResult - The structured result from gatekeeper.js
 * @param {string} params.userAction - 'approve' | 'fix' | 'override'
 */
export function logReview({ repoRoot, reviewResult, userAction }) {
  const logDir = join(repoRoot, LOG_DIR);
  const logPath = join(logDir, LOG_FILE);

  ensureDir(logDir);

  const entries = readLog(logPath);

  entries.push({
    timestamp: new Date().toISOString(),
    status: reviewResult.status,
    issues_count: reviewResult.issues.length,
    user_action: userAction,
    summary: reviewResult.summary,
  });

  writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf8');
}

/**
 * Read all log entries for a repo.
 *
 * @param {string} repoRoot - Absolute path to repo root
 * @returns {Array} log entries
 */
export function readLog(repoRoot) {
  // Called internally with a full path to the log file,
  // or externally with the repo root.
  const logPath = repoRoot.endsWith(LOG_FILE)
    ? repoRoot
    : join(repoRoot, LOG_DIR, LOG_FILE);

  if (!existsSync(logPath)) return [];

  try {
    const content = readFileSync(logPath, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Compute summary stats from all log entries.
 *
 * @param {Array} entries
 * @returns {object} stats
 */
export function computeStats(entries) {
  const total = entries.length;
  const clean = entries.filter((e) => e.status === 'green').length;
  const issuesTotal = entries.filter((e) => e.status !== 'green').length;
  const overrides = entries.filter((e) => e.user_action === 'override').length;
  const fixed = entries.filter((e) => e.user_action === 'fix').length;

  return {
    total,
    clean,
    issuesTotal,
    overrides,
    // "Prevented" = reviews where user chose to fix (not override, not approve-anyway)
    prevented: fixed,
  };
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
