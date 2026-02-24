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

You will receive the repo's file tree and the contents of key files.

Generate a GATEKEEPER.md file that contains:

1. A "Protected Files" section listing files that should never be modified without explicit user instruction. Look for:
   - Authentication and authorisation files
   - Database schema and migration files
   - CI/CD configuration (.github/workflows, Dockerfile, etc.)
   - Environment config files
   - Payment or billing logic
   - Any file whose name suggests it is foundational (e.g. config, schema, auth, middleware, seed)

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

  const userContent = buildScanMessage(fileTree, keyFileContents);

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
    /^src\/index\./,
    /^src\/app\./,
    /^src\/main\./,
    /^app\.(js|ts|py|rb|go)$/,
    /^server\.(js|ts|py|rb|go)$/,
    /^index\.(js|ts|py|rb|go)$/,
    /schema\.(js|ts|sql|prisma|graphql)$/,
    /routes?\.(js|ts)$/,
    /middleware\.(js|ts)$/,
  ];

  for (const file of files) {
    if (contents[file]) continue; // already included
    if (Object.keys(contents).length >= 10) break; // cap at 10 files
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

function buildScanMessage(fileTree, keyFileContents) {
  const parts = [`## Repository File Tree\n${fileTree}`];

  if (Object.keys(keyFileContents).length > 0) {
    parts.push('## Key File Contents');
    for (const [path, content] of Object.entries(keyFileContents)) {
      parts.push(`### ${path}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  return parts.join('\n\n');
}
