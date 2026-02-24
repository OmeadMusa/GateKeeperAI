/**
 * terminal-ui.js
 * Renders the Gatekeeper review result in the terminal and
 * prompts the user to approve, fix, or override.
 *
 * Returns: 'approve' | 'fix' | 'override'
 */

import { createInterface } from 'readline';

// ANSI colour helpers
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

function bold(str) { return `${BOLD}${str}${RESET}`; }
function dim(str) { return `${DIM}${str}${RESET}`; }
function red(str) { return `${RED}${str}${RESET}`; }
function yellow(str) { return `${YELLOW}${str}${RESET}`; }
function green(str) { return `${GREEN}${str}${RESET}`; }
function cyan(str) { return `${CYAN}${str}${RESET}`; }

/**
 * Render the review result and collect the user's decision.
 *
 * @param {object} reviewResult - The structured result from gatekeeper.js
 * @returns {Promise<'approve'|'fix'|'override'>}
 */
export async function prompt(reviewResult) {
  const { status, issues, summary } = reviewResult;

  process.stdout.write('\n');

  if (status === 'green') {
    return handleGreen(summary);
  }

  if (status === 'yellow') {
    return handleYellow(issues, summary);
  }

  // red
  return handleRed(issues, summary);
}

/**
 * Green: no issues. Auto-approve, print a single line.
 */
async function handleGreen(summary) {
  console.log(`${GREEN}✅ Gatekeeper: No issues found — pushing${RESET}`);
  return 'approve';
}

/**
 * Yellow: warnings only.
 */
async function handleYellow(issues, summary) {
  const count = issues.length;
  console.log(bold(yellow(`🟡 Gatekeeper Review — ${count} issue${count === 1 ? '' : 's'} found`)));
  console.log('');

  for (const issue of issues) {
    const icon = issue.severity === 'critical' ? red('🚨') : yellow('⚠️ ');
    console.log(`  ${icon}  ${issue.plain_english}`);
  }

  console.log('');
  console.log(dim(`Summary: ${summary}`));
  console.log('');
  console.log('What would you like to do?');
  console.log(`  ${cyan('[A]')} Fix this first ${dim('(copies fix prompt to clipboard, cancels push)')}`);
  console.log(`  ${cyan('[B]')} Push anyway`);
  console.log(`  ${cyan('[C]')} See full details`);
  console.log('');

  const choice = await readChoice(['a', 'b', 'c']);

  if (choice === 'c') {
    printFullDetails(issues);
    console.log('');
    console.log('What would you like to do?');
    console.log(`  ${cyan('[A]')} Fix this first ${dim('(copies fix prompt to clipboard, cancels push)')}`);
    console.log(`  ${cyan('[B]')} Push anyway`);
    console.log('');
    const choice2 = await readChoice(['a', 'b']);
    return choice2 === 'a' ? copyAndFix(issues) : 'approve';
  }

  if (choice === 'a') return copyAndFix(issues);
  return 'approve';
}

/**
 * Red: at least one critical issue.
 */
async function handleRed(issues, summary) {
  const count = issues.length;
  console.log(bold(red(`🔴 Gatekeeper Review — CRITICAL issue${count === 1 ? '' : 's'} found`)));
  console.log('');

  for (const issue of issues) {
    const icon = issue.severity === 'critical' ? red('🚨') : yellow('⚠️ ');
    console.log(`  ${icon}  ${issue.plain_english}`);
  }

  console.log('');
  console.log(dim(`Summary: ${summary}`));
  console.log('');
  console.log('What would you like to do?');
  console.log(`  ${cyan('[A]')} Fix this first ${dim('(copies fix prompt to clipboard, cancels push)')}  ${dim('← default')}`);
  console.log(`  ${cyan('[B]')} Push anyway ${red('(override)')}`);
  console.log(`  ${cyan('[C]')} See full details`);
  console.log('');

  const choice = await readChoice(['a', 'b', 'c'], 'a');

  if (choice === 'c') {
    printFullDetails(issues);
    console.log('');
    console.log('What would you like to do?');
    console.log(`  ${cyan('[A]')} Fix this first ${dim('(copies fix prompt to clipboard, cancels push)')}  ${dim('← default')}`);
    console.log(`  ${cyan('[B]')} Push anyway ${red('(override)')}`);
    console.log('');
    const choice2 = await readChoice(['a', 'b'], 'a');
    if (choice2 === 'b') return confirmOverride();
    return copyAndFix(issues);
  }

  if (choice === 'b') return confirmOverride();
  return copyAndFix(issues);
}

/**
 * Print full issue details including fix prompts.
 */
function printFullDetails(issues) {
  console.log('');
  console.log(bold('Full issue details:'));
  console.log('');

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const severityLabel = issue.severity === 'critical' ? red('[CRITICAL]') : yellow('[WARNING]');
    const categoryLabel = cyan(`[${issue.category.toUpperCase().replace('_', ' ')}]`);

    console.log(`  ${i + 1}. ${severityLabel} ${categoryLabel}`);
    console.log(`     ${issue.plain_english}`);
    console.log('');
    console.log(`     ${dim('Fix instruction:')}`);
    console.log(`     ${dim(issue.fix_prompt)}`);
    console.log('');
  }
}

/**
 * Confirm override for red-status pushes.
 */
async function confirmOverride() {
  process.stdout.write(red('Are you sure you want to override a critical issue? (y/N): '));
  const answer = await readLine();
  if (answer.toLowerCase() === 'y') {
    return 'override';
  }
  console.log('Override cancelled. Push blocked.');
  return 'fix';
}

/**
 * Copy fix prompts to clipboard and signal fix mode.
 */
async function copyAndFix(issues) {
  const criticalIssues = issues.filter((i) => i.severity === 'critical');
  const targetIssues = criticalIssues.length > 0 ? criticalIssues : issues;

  const fixPrompts = targetIssues.map((i) => i.fix_prompt).join('\n\n');

  const copied = await copyToClipboard(fixPrompts);
  if (copied) {
    console.log(green('✓ Fix instruction copied to clipboard.'));
    console.log(dim('Paste it into Claude Code to fix the issue, then try pushing again.'));
  } else {
    console.log(yellow('Could not copy to clipboard automatically. Fix instruction:'));
    console.log('');
    for (const issue of targetIssues) {
      console.log(`  → ${issue.fix_prompt}`);
    }
  }

  return 'fix';
}

/**
 * Copy text to clipboard using platform-native commands.
 */
async function copyToClipboard(text) {
  const { execSync } = await import('child_process');
  const { platform } = process;

  try {
    if (platform === 'darwin') {
      execSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    } else if (platform === 'linux') {
      // Try xclip then xsel
      try {
        execSync('xclip -selection clipboard', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      } catch {
        execSync('xsel --clipboard --input', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      }
    } else if (platform === 'win32') {
      execSync('clip', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a single keypress from stdin, normalised to lowercase.
 * Accepts only keys in the allowed set.
 */
async function readChoice(allowed, defaultKey = null) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    // Show prompt
    process.stdout.write(`Choice [${allowed.join('/').toUpperCase()}]${defaultKey ? ` (default: ${defaultKey.toUpperCase()})` : ''}: `);

    // Attempt raw mode for single-keypress UX
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (key) => {
        // Ctrl+C
        if (key === '\u0003') {
          process.stdout.write('\n');
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          rl.close();
          process.exit(1);
        }

        // Enter/return: use default
        if ((key === '\r' || key === '\n') && defaultKey) {
          process.stdout.write(defaultKey.toUpperCase() + '\n');
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          rl.close();
          resolve(defaultKey);
          return;
        }

        const lower = key.toLowerCase();
        if (allowed.includes(lower)) {
          process.stdout.write(key.toUpperCase() + '\n');
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          rl.close();
          resolve(lower);
        }
        // Ignore other keys
      };

      process.stdin.on('data', onData);
    } else {
      // Fallback: line-based input
      rl.on('line', (line) => {
        const lower = line.trim().toLowerCase();
        if (allowed.includes(lower)) {
          rl.close();
          resolve(lower);
        } else if (!lower && defaultKey) {
          rl.close();
          resolve(defaultKey);
        } else {
          process.stdout.write(`Please enter one of: ${allowed.join(', ').toUpperCase()}: `);
        }
      });
    }
  });
}

/**
 * Read a full line from stdin.
 */
async function readLine() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
}
