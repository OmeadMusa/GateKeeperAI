#!/usr/bin/env node
/**
 * cli.js
 * Entry point for `npx gatekeeper-ai`.
 * Supports: init, stats
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');

import { bold, dim, red, green, yellow, cyan } from '../src/colors.js';

const [,, command, ...args] = process.argv;

switch (command) {
  case 'init':
    runInit().catch(fatalError);
    break;
  case 'stats':
    runStats().catch(fatalError);
    break;
  default:
    printUsage();
    process.exit(command ? 1 : 0);
}

// ─── init ────────────────────────────────────────────────────────────────────

async function runInit() {
  console.log('');
  console.log(bold('Gatekeeper AI — Setup'));
  console.log(dim('Repository integrity reviewer for agentic coding tools'));
  console.log('');

  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    console.error(red('Error: Not inside a git repository. Run this from your project root.'));
    process.exit(1);
  }

  console.log(`Setting up Gatekeeper in: ${cyan(repoRoot)}`);
  console.log('');

  // 1. Anthropic API key
  const apiKey = await setupApiKey(repoRoot);

  // 2. Write .gitignore entries
  setupGitignore(repoRoot);

  // 3. Write GATEKEEPER.md — scan the repo to populate it with real content
  await setupGatekeeperMd(repoRoot, apiKey);

  // 4. Write pre-push hook
  setupHook(repoRoot);

  // 5. Create .gatekeeper dir
  const logDir = join(repoRoot, '.gatekeeper');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  console.log('');
  console.log(green('✅ Gatekeeper is active.'));
  console.log('   It will review all future pushes in this repository.');
  console.log('');
  console.log(dim('Tips:'));
  console.log(dim('  • Edit GATEKEEPER.md to add project-specific rules'));
  console.log(dim('  • Set GATEKEEPER_REQUEST="<your task>" before pushing to give Gatekeeper context'));
  console.log(dim('  • Run `npx gatekeeper-ai stats` to see your review history'));
  console.log('');
}

async function setupApiKey(repoRoot) {
  const envPath = join(repoRoot, '.env');

  // Check if key already exists
  let existingKey = null;
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/^ANTHROPIC_API_KEY\s*=\s*(.+)$/m);
    if (match) existingKey = match[1].replace(/^['"]|['"]$/g, '').trim();
  }

  if (existingKey) {
    const masked = existingKey.slice(0, 7) + '...' + existingKey.slice(-4);
    console.log(`${green('✓')} Anthropic API key already configured (${dim(masked)})`);
    return existingKey;
  }

  // Prompt for key
  process.stdout.write('Enter your Anthropic API key (sk-ant-...): ');
  const apiKey = await readLine(true);

  if (!apiKey || !apiKey.startsWith('sk-')) {
    console.warn(yellow('Warning: API key looks unusual. Continuing anyway.'));
  }

  // Write to .env
  const envLine = `ANTHROPIC_API_KEY=${apiKey}\n`;
  if (existsSync(envPath)) {
    appendFileSync(envPath, '\n' + envLine, 'utf8');
  } else {
    writeFileSync(envPath, envLine, 'utf8');
  }

  console.log(`${green('✓')} API key saved to .env`);
  return apiKey;
}

function setupGitignore(repoRoot) {
  const gitignorePath = join(repoRoot, '.gitignore');
  const entries = ['.env', '.gatekeeper/'];

  let existing = '';
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, 'utf8');
  }

  const toAdd = entries.filter((e) => !existing.includes(e));
  if (toAdd.length > 0) {
    const addition = '\n# Gatekeeper AI\n' + toAdd.join('\n') + '\n';
    appendFileSync(gitignorePath, addition, 'utf8');
    console.log(`${green('✓')} Added ${toAdd.join(', ')} to .gitignore`);
  } else {
    console.log(`${green('✓')} .gitignore already up to date`);
  }
}

async function setupGatekeeperMd(repoRoot, apiKey) {
  const destPath = join(repoRoot, 'GATEKEEPER.md');

  if (existsSync(destPath)) {
    console.log(`${green('✓')} GATEKEEPER.md already exists — leaving it unchanged`);
    return;
  }

  process.stdout.write('  Scanning repo to generate GATEKEEPER.md...');

  let content;
  try {
    const { scanRepo } = await import(join(PKG_ROOT, 'src', 'scanner.js'));
    content = await scanRepo({ repoRoot, apiKey });
    process.stdout.write(' done\n');
  } catch (err) {
    process.stdout.write(' failed\n');
    console.log(yellow(`  Could not auto-generate (${err.message}) — writing blank template`));
    content = readFileSync(join(PKG_ROOT, 'templates', 'GATEKEEPER.md'), 'utf8');
  }

  writeFileSync(destPath, content, 'utf8');
  console.log(`${green('✓')} GATEKEEPER.md generated — review and edit it to refine the rules`);
}

function setupHook(repoRoot) {
  const hooksDir = join(repoRoot, '.git', 'hooks');
  const hookPath = join(hooksDir, 'pre-push');

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  // Embed the resolved path to hook.js so the hook always finds it,
  // regardless of whether the package is installed locally or globally.
  const hookJsPath = resolve(PKG_ROOT, 'src', 'hook.js');
  const hookScript = buildHookScript(hookJsPath);

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (existing.includes('gatekeeper-ai')) {
      console.log(`${green('✓')} pre-push hook already installed`);
      // Update it to the latest version
      writeFileSync(hookPath, hookScript, 'utf8');
      chmodSync(hookPath, 0o755);
      console.log(`${green('✓')} pre-push hook updated to latest version`);
      return;
    }
    // There's an existing hook that isn't ours — chain it
    const chained = buildChainedHookScript(existing, hookJsPath);
    writeFileSync(hookPath, chained, 'utf8');
    chmodSync(hookPath, 0o755);
    console.log(`${green('✓')} pre-push hook installed (chained with existing hook)`);
    return;
  }

  writeFileSync(hookPath, hookScript, 'utf8');
  chmodSync(hookPath, 0o755);
  console.log(`${green('✓')} pre-push hook installed`);
}

/**
 * Build the hook script with the resolved path to hook.js baked in.
 *
 * Git passes push data via stdin. We capture it into an env var so that
 * Node can open /dev/tty directly for interactive prompts (handled in Node,
 * not in the shell, to avoid "Device not configured" edge cases).
 */
function buildHookScript(hookJsPath) {
  return `#!/bin/sh
# Gatekeeper AI — pre-push hook
# Do not edit this file manually. Re-run \`npx gatekeeper-ai init\` to update.

# Capture git's push data from stdin so Node can open /dev/tty itself.
GATEKEEPER_PUSH_DATA=$(cat)
GATEKEEPER_PUSH_DATA="$GATEKEEPER_PUSH_DATA" node "${hookJsPath}"
exit $?
`;
}

/**
 * Chain an existing hook with the gatekeeper hook.
 */
function buildChainedHookScript(existingScript, hookJsPath) {
  const existingBody = existingScript.replace(/^#!.*\n/, '').split('\n').map((l) => '  ' + l).join('\n');
  return `#!/bin/sh
# Gatekeeper AI — pre-push hook (chained)
# Original hook preserved below.

# Capture git's push data FIRST, before either hook consumes stdin.
GATEKEEPER_PUSH_DATA=$(cat)

# Run original hook with the push data piped to its stdin.
__original_hook() {
${existingBody}
}

echo "$GATEKEEPER_PUSH_DATA" | __original_hook
ORIGINAL_EXIT=$?
if [ $ORIGINAL_EXIT -ne 0 ]; then
  exit $ORIGINAL_EXIT
fi

# Now run Gatekeeper (push data already captured above).
GATEKEEPER_PUSH_DATA="$GATEKEEPER_PUSH_DATA" node "${hookJsPath}"
exit $?
`;
}

// ─── stats ───────────────────────────────────────────────────────────────────

async function runStats() {
  const { readLog, computeStats } = await import(join(PKG_ROOT, 'src', 'logger.js'));

  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    console.error(red('Error: Not inside a git repository.'));
    process.exit(1);
  }

  const entries = readLog(repoRoot);
  if (entries.length === 0) {
    console.log('');
    console.log('No Gatekeeper reviews yet for this repo.');
    console.log(dim('Gatekeeper reviews your pushes automatically once installed.'));
    console.log('');
    return;
  }

  const stats = computeStats(entries);
  const cleanPct = stats.total > 0 ? Math.round((stats.clean / stats.total) * 100) : 0;

  console.log('');
  console.log(bold('Gatekeeper Stats for this repo'));
  console.log(`   Total reviews:   ${pad(stats.total, 5)}`);
  console.log(`   Clean commits:   ${pad(stats.clean, 5)} ${dim(`(${cleanPct}%)`)}`);
  console.log(`   Issues flagged:  ${pad(stats.issuesTotal, 5)}`);
  console.log(`   User overrides:  ${pad(stats.overrides, 5)}`);
  console.log(`   Issues prevented:${pad(stats.prevented, 5)}`);
  console.log('');

  // Show recent entries
  if (entries.length > 0) {
    console.log(bold('Recent reviews:'));
    const recent = entries.slice(-5).reverse();
    for (const entry of recent) {
      const statusIcon = entry.status === 'green' ? green('✅') :
                         entry.status === 'yellow' ? yellow('🟡') : red('🔴');
      const actionLabel = entry.user_action === 'fix' ? red('blocked') :
                          entry.user_action === 'override' ? yellow('override') : green('pushed');
      const date = new Date(entry.timestamp).toLocaleString();
      console.log(`   ${statusIcon}  ${dim(date)}  ${actionLabel}`);
      console.log(`      ${dim(entry.summary)}`);
    }
    console.log('');
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function getRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function readLine(silent = false) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: silent ? null : process.stdout,
      terminal: false,
    });

    if (silent && process.stdin.isTTY) {
      // Hide input for API key entry
      process.stdin.setRawMode(true);
      const chars = [];
      process.stdin.on('data', function handler(ch) {
        ch = ch.toString();
        if (ch === '\n' || ch === '\r' || ch === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          rl.close();
          resolve(chars.join(''));
        } else if (ch === '\u007f') {
          chars.pop();
        } else {
          chars.push(ch);
        }
      });
    } else {
      rl.on('line', (line) => {
        rl.close();
        resolve(line.trim());
      });
    }
  });
}

function pad(n, width) {
  return String(n).padStart(width);
}

function defaultGatekeeperTemplate() {
  return readFileSync(join(PKG_ROOT, 'templates', 'GATEKEEPER.md'), 'utf8');
}

function printUsage() {
  console.log('');
  console.log(bold('gatekeeper-ai'));
  console.log('Repository integrity reviewer for agentic coding tools.');
  console.log('');
  console.log('Usage:');
  console.log(`  ${cyan('npx gatekeeper-ai init')}    Install Gatekeeper in the current git repo`);
  console.log(`  ${cyan('npx gatekeeper-ai stats')}   Show review history for this repo`);
  console.log('');
}

function fatalError(err) {
  console.error(red(`Error: ${err.message}`));
  process.exit(1);
}
