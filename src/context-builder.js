/**
 * context-builder.js
 * Generates a lightweight repo snapshot for each Gatekeeper review.
 *
 * Produces:
 *   - fileTree: names and paths of all tracked files
 *   - modifiedFileContents: full content of files the diff directly modifies
 *   - dependentSignatures: function/class signatures of files that import modified files
 *   - gatekeeperRules: contents of GATEKEEPER.md if present
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

// File extensions we'll try to extract signatures from
const SIGNATURE_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go']);

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
 * @param {string} params.diff - The git diff string (used to identify modified files)
 * @returns {object} repoContext
 */
export async function buildContext({ repoRoot, diff }) {
  const modifiedFiles = extractModifiedFiles(diff);
  const fileTree = buildFileTree(repoRoot);
  const modifiedFileContents = readModifiedFiles(repoRoot, modifiedFiles);
  const dependentSignatures = findDependentSignatures(repoRoot, modifiedFiles, fileTree);
  const gatekeeperRules = readGatekeeperRules(repoRoot);

  return {
    fileTree,
    modifiedFileContents,
    dependentSignatures,
    gatekeeperRules,
  };
}

/**
 * Extract the list of files modified in the diff.
 * Parses +++ b/path and --- a/path lines.
 */
function extractModifiedFiles(diff) {
  const files = new Set();

  for (const line of diff.split('\n')) {
    const match = line.match(/^(?:\+\+\+|---)\s+[ab]\/(.+)$/);
    if (match && match[1] !== '/dev/null') {
      files.add(match[1]);
    }
  }

  return [...files];
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
 * Read the full content of files modified in the diff.
 * Skips binary files and files larger than 100KB.
 */
function readModifiedFiles(repoRoot, modifiedFiles) {
  const contents = {};

  for (const relPath of modifiedFiles) {
    const fullPath = resolve(repoRoot, relPath);
    if (!existsSync(fullPath)) continue;

    try {
      const stat = statSync(fullPath);
      if (stat.size > 100 * 1024) continue;

      const content = readFileSync(fullPath, 'utf8');
      if (content.includes('\0')) continue; // binary check

      contents[relPath] = content;
    } catch {
      // Skip unreadable files silently
    }
  }

  return contents;
}

/**
 * Find files that import any of the modified files, then extract
 * only their function/class signatures (not full content).
 */
function findDependentSignatures(repoRoot, modifiedFiles, fileTree) {
  const signatures = {};
  const allFiles = fileTree.split('\n').filter(Boolean);

  for (const relPath of allFiles) {
    const ext = relPath.includes('.') ? '.' + relPath.split('.').pop() : '';
    if (!SIGNATURE_EXTENSIONS.has(ext)) continue;
    if (modifiedFiles.includes(relPath)) continue;

    const fullPath = resolve(repoRoot, relPath);
    let content;
    try {
      const stat = statSync(fullPath);
      if (stat.size > 100 * 1024) continue;
      content = readFileSync(fullPath, 'utf8');
      if (content.includes('\0')) continue;
    } catch {
      continue;
    }

    if (importsAnyModifiedFile(content, modifiedFiles)) {
      signatures[relPath] = extractSignatures(content, ext);
    }
  }

  return signatures;
}

/**
 * Check whether file content imports any of the modified files.
 */
function importsAnyModifiedFile(content, modifiedFiles) {
  for (const modFile of modifiedFiles) {
    // Strip extension for import matching (e.g. src/utils/auth.js → src/utils/auth)
    const withoutExt = modFile.replace(/\.[^/.]+$/, '');
    const baseName = withoutExt.split('/').pop();

    // Match both full relative paths and base-name-only imports
    if (
      content.includes(`'${withoutExt}'`) ||
      content.includes(`"${withoutExt}"`) ||
      content.includes(`'./${baseName}'`) ||
      content.includes(`"./${baseName}"`) ||
      content.includes(`'../${baseName}'`) ||
      content.includes(`"../${baseName}"`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract function and class signature lines from source code.
 */
function extractSignatures(content, ext) {
  const lines = content.split('\n');
  const signatures = [];

  const jsPatterns = [
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function[\s*]\w+/,
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/,
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?function/,
    /^(?:export\s+)?class\s+\w+/,
    /^\s{2,}(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)\s*\{/, // class methods
  ];

  const pyPatterns = [
    /^(?:async\s+)?def\s+\w+/,
    /^class\s+\w+/,
  ];

  const patterns = ext === '.py' ? pyPatterns : jsPatterns;

  for (const line of lines) {
    if (patterns.some((p) => p.test(line))) {
      signatures.push(line.trimEnd());
    }
  }

  return signatures.length > 0 ? signatures.join('\n') : '(no extractable signatures)';
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
