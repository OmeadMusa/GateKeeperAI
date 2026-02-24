/**
 * scanner.js
 * Scans a repo on first install and generates an initial GATEKEEPER.md
 * populated with the project's real structure, protected files, and inferred rules.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';

const SCAN_SYSTEM_PROMPT = `You are analyzing a software repository to generate the initial configuration for Gatekeeper AI — a tool that protects repos from unintended changes by AI coding assistants.

You will receive the repo's file tree, the contents of key files, and git history metadata.

Generate a GATEKEEPER.md file that contains:

1. A "Protected Files" section listing files that should never be modified without explicit user instruction. Look for:
   - Authentication and authorisation files
   - Database schema and migration files
   - CI/CD configuration (.github/workflows, Dockerfile, etc.)
   - Environment config files
   - Payment or billing logic
   - Any file whose name suggests it is foundational (e.g. config, schema, auth, middleware, seed)
   - Files with very few git commits (rarely changed) — these are stable, foundational files
   - Files added in the initial commit (seeding/bootstrapping files)
   - Use the "File Change Frequency" data provided to identify rarely-touched files; treat files with 1–3 commits as strong protected-file candidates

2. A "Rules" section with project-specific rules inferred from the codebase. Look for:
   - Where API calls are routed (e.g. "All API calls must go through /services")
   - Test patterns (e.g. "All new components must have a corresponding test file")
   - Naming conventions visible in the file tree
   - Architecture patterns (e.g. MVC, feature folders, monorepo)
   - Any hardcoded constraints implied by the structure

3. A "Stack" section briefly noting the detected tech stack (language, framework, package manager).

Return ONLY the markdown content — no explanation, no preamble, no code fences.
Start with exactly: # Gatekeeper Rules`;

/**
 * Scan the repo and generate initial GATEKEEPER.md content.
 *
 * @param {object} params
 * @param {string} params.repoRoot
 * @param {string} params.apiKey
 * @returns {Promise<string>} Markdown content for GATEKEEPER.md
 */
export async function scanRepo({ repoRoot, apiKey }) {
  const client = new Anthropic({ apiKey });

  const fileTree = buildFileTree(repoRoot);
  const keyFileContents = readKeyFiles(repoRoot, fileTree);
  const changeFrequency = buildFileChangeFrequency(repoRoot);
  const initialCommitFiles = getInitialCommitFiles(repoRoot);

  const userContent = buildScanMessage(fileTree, keyFileContents, changeFrequency, initialCommitFiles);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SCAN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const result = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Ensure it starts with the expected header
  if (!result.trim().startsWith('# Gatekeeper Rules')) {
    return `# Gatekeeper Rules\n\n${result.trim()}`;
  }

  return result.trim() + '\n';
}

function buildFileTree(repoRoot) {
  try {
    return execSync('git ls-files', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Count how many commits have touched each file.
 * Returns { 'path/to/file': N, ... } sorted by count ascending.
 * Falls back to {} on any error (shallow clones, non-git dirs).
 */
function buildFileChangeFrequency(repoRoot) {
  try {
    const raw = execSync('git log --format="" --name-only', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const counts = {};
    for (const line of raw.split('\n')) {
      const f = line.trim();
      if (f) counts[f] = (counts[f] || 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

/**
 * Return the list of files added in the very first commit (root commit).
 * These are often seeding/bootstrapping files — strong protected-file candidates.
 */
function getInitialCommitFiles(repoRoot) {
  try {
    const rootCommit = execSync('git rev-list --max-parents=0 HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!rootCommit) return [];
    const raw = execSync(
      `git diff-tree --no-commit-id -r --name-only ${rootCommit}`,
      { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return raw.split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read a curated set of key files to give Claude context about the project.
 * Prioritises: README, package manifests, entry points, config files.
 */
function readKeyFiles(repoRoot, fileTree) {
  const files = fileTree.split('\n').filter(Boolean);
  const contents = {};

  // Files to always try to read (in priority order)
  const priorityFiles = [
    'README.md', 'readme.md',
    'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile',
    'docker-compose.yml', 'docker-compose.yaml',
    '.env.example', '.env.sample',
  ];

  for (const name of priorityFiles) {
    const match = files.find((f) => f === name || f.endsWith('/' + name));
    if (match) {
      const content = safeRead(resolve(repoRoot, match));
      if (content) contents[match] = content;
    }
  }

  // Also include any files that look like entry points or core config
  const interestingPatterns = [
    // Standard entry points
    /^src\/index\./,
    /^src\/app\./,
    /^src\/main\./,
    /^app\.(js|ts|py|rb|go)$/,
    /^server\.(js|ts|py|rb|go)$/,
    /^index\.(js|ts|py|rb|go)$/,
    // Auth / security-critical pages and modules
    /\/auth\//,
    /login\./,
    /signup\./,
    /callback\./,
    /onboarding\./,
    /session/,
    // Config files (any extension)
    /config\./,
    // Edge/worker functions
    /worker/,
    // API layer
    /api\.(js|ts)$/,
    /(services?|client)\.(js|ts)$/,
    // Legal / policy pages
    /(privacy|terms|tos|termsofservice)\./,
    // Database
    /schema\.(js|ts|sql|prisma|graphql)$/,
    /(migration|seed|models?)\./,
    // Routing / middleware
    /routes?\.(js|ts)$/,
    /middleware\.(js|ts)$/,
    // CI/CD
    /Dockerfile$/,
    /\.dockerignore$/,
  ];

  for (const file of files) {
    if (contents[file]) continue; // already included
    if (Object.keys(contents).length >= 20) break; // cap at 20 files
    if (interestingPatterns.some((p) => p.test(file))) {
      const content = safeRead(resolve(repoRoot, file));
      if (content) contents[file] = content;
    }
  }

  return contents;
}

function safeRead(fullPath) {
  if (!existsSync(fullPath)) return null;
  try {
    const stat = statSync(fullPath);
    if (stat.size > 50 * 1024) return null; // skip files >50KB
    const content = readFileSync(fullPath, 'utf8');
    if (content.includes('\0')) return null; // binary
    return content;
  } catch {
    return null;
  }
}

function buildScanMessage(fileTree, keyFileContents, changeFrequency, initialCommitFiles) {
  const parts = [`## Repository File Tree\n${fileTree}`];

  // Include git change-frequency data (capped at 30 most stable files)
  if (Object.keys(changeFrequency).length > 0) {
    const sorted = Object.entries(changeFrequency)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 30);
    const lines = sorted.map(([f, n]) => `${f}: ${n} commit${n === 1 ? '' : 's'}`).join('\n');
    parts.push(
      `## File Change Frequency (from git log)\nFiles with low commit counts are rarely touched and likely foundational. Files with high counts are actively developed.\n\n${lines}`
    );
  }

  // Include initial-commit files
  if (initialCommitFiles.length > 0) {
    parts.push(
      `## Files Added in Initial Commit (foundational/seeding files)\n${initialCommitFiles.join('\n')}`
    );
  }

  if (Object.keys(keyFileContents).length > 0) {
    parts.push('## Key File Contents');
    for (const [path, content] of Object.entries(keyFileContents)) {
      parts.push(`### ${path}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  return parts.join('\n\n');
}
