/**
 * context-builder.js
 * Generates a lightweight repo snapshot for each Gatekeeper review.
 *
 * Produces:
 *   - fileTree: names and paths of all tracked files
 *   - gatekeeperRules: contents of GATEKEEPER.md if present
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

// Dirs to always exclude
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.gatekeeper',
]);

/**
 * Build a repo context snapshot.
 *
 * @param {object} params
 * @param {string} params.repoRoot - Absolute path to the repo root
 * @returns {object} repoContext
 */
export async function buildContext({ repoRoot }) {
  const fileTree = buildFileTree(repoRoot);
  const gatekeeperRules = readGatekeeperRules(repoRoot);

  return {
    fileTree,
    gatekeeperRules,
  };
}

/**
 * Build a plain-text file tree using git ls-files.
 * Falls back to a filesystem walk if git is unavailable.
 */
function buildFileTree(repoRoot) {
  let files;

  try {
    const output = execSync('git ls-files', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    files = output.trim().split('\n').filter(Boolean);
  } catch {
    files = walkDirectory(repoRoot, repoRoot);
  }

  // Filter out excluded directories
  files = files.filter((f) => !f.split('/').some((segment) => EXCLUDED_DIRS.has(segment)));

  return files.join('\n');
}

/**
 * Fallback filesystem walk returning relative paths.
 */
function walkDirectory(dir, repoRoot) {
  const results = [];

  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      const rel = fullPath.slice(repoRoot.length + 1);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        results.push(rel);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Read GATEKEEPER.md from the repo root if present.
 */
function readGatekeeperRules(repoRoot) {
  const gatekeeperPath = join(repoRoot, 'GATEKEEPER.md');
  if (!existsSync(gatekeeperPath)) return null;

  try {
    return readFileSync(gatekeeperPath, 'utf8');
  } catch {
    return null;
  }
}
