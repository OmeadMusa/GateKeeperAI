/**
 * terminal-ui.js
 * Renders the Gatekeeper review result in the terminal and
 * prompts the user to approve, fix, or override.
 *
 * Returns: 'approve' | 'fix' | 'override'
 */

import { createInterface } from 'readline';
import { createReadStream, writeFileSync, mkdirSync, existsSync } from 'fs';
import { openSync } from 'fs';
import { join } from 'path';
import { RESET, BOLD, DIM, RED, GREEN, YELLOW, CYAN, bold, dim, red, green, yellow, cyan } from './colors.js';

/**
 * Open /dev/tty as a readable stream for interactive input.
 * Returns null if unavailable (non-interactive environment).
 */
function openTtyStream() {
  if (process.platform === 'win32') return null;
  try {
    const fd = openSync('/dev/tty', 'r+');
    return createReadStream(null, { fd, autoClose: true });
  } catch {
    return null;
  }
}

/**
 * Render the review result and collect the user's decision.
 *
 * @param {object} reviewResult - The structured result from gatekeeper.js
 * @param {object} [options]
 * @param {boolean} [options.nonInteractive] - No TTY available; auto-decide instead of prompting
 * @param {string} [options.repoRoot] - Repo root path, used to write LAST_REVIEW.md
 * @returns {Promise<'approve'|'fix'|'override'>}
 */
export async function prompt(reviewResult, { nonInteractive = false, repoRoot = null } = {}) {
  const { status, issues, summary } = reviewResult;

  process.stdout.write('\n');

  if (status === 'green') {
    return handleGreen(summary);
  }

  if (nonInteractive) {
    return handleNonInteractive(status, issues ?? [], summary, repoRoot);
  }

  if (status === 'yellow') {
    return handleYellow(issues ?? [], summary);
  }

  // red
  return handleRed(issues ?? [], summary);
}

/**
 * Non-interactive mode (no /dev/tty — running inside a GUI client or CI).
 *
 * Yellow: warn and pass. The push is allowed but warnings are printed and
 * written to LAST_REVIEW.md so the user can review them at leisure.
 *
 * Red: block the push and spawn an interactive terminal window so the user
 * can respond to the review without leaving their GUI client.
 *
 * Override path for red:
 *   GATEKEEPER_OVERRIDE=1  bypass critical issues
 */
async function handleNonInteractive(status, issues, summary, repoRoot) {
  const isYellow = status === 'yellow';
  const count = issues.length;

  // Always write LAST_REVIEW.md for non-green results
  if (repoRoot) {
    writeLastReview(repoRoot, status, issues, summary);
  }

  if (isYellow) {
    // Yellow: warn but allow the push through
    console.log(bold(yellow(`🟡 Gatekeeper: ${count} warning${count === 1 ? '' : 's'} — push allowed`)));
    for (const issue of issues) {
      console.log(`   ⚠️  ${issue.plain_english}`);
    }
    console.log('');
    console.log(dim(`   ${summary}`));
    if (repoRoot) {
      console.log('');
      console.log(`   📋 Details: .gatekeeper/LAST_REVIEW.md`);
    }
    console.log('');
    return 'approve';
  }

  // Red: block and try to open an interactive terminal for the user
  console.log(bold(red(`🔴 Gatekeeper: ${count} CRITICAL issue${count === 1 ? '' : 's'} — push blocked`)));
  for (const issue of issues.filter((i) => i.severity === 'critical')) {
    console.log(`   🚨 ${issue.plain_english}`);
  }
  console.log('');
  console.log(dim(`   ${summary}`));
  console.log('');

  if (process.env.GATEKEEPER_OVERRIDE === '1') {
    console.log(yellow('   GATEKEEPER_OVERRIDE=1 set — allowing push'));
    return 'override';
  }

  if (repoRoot) {
    console.log(`   📋 Full details + fix instructions: .gatekeeper/LAST_REVIEW.md`);
    console.log('');
    // Spawn an interactive terminal so the user can respond without using the CLI
    const opened = await openReviewTerminal(repoRoot);
    if (opened) {
      console.log(dim('   A review window has been opened — respond there to allow or cancel the push.'));
    } else {
      console.log(dim('   To override: GATEKEEPER_OVERRIDE=1 git push'));
    }
    console.log('');
  }

  return 'fix';
}

/**
 * Spawn a new terminal window running `npx gatekeeper-ai review` so the user
 * can interact with the review result from a GUI client push.
 *
 * Returns true if a terminal was successfully opened, false otherwise.
 */
async function openReviewTerminal(repoRoot) {
  const { execSync, spawn } = await import('child_process');
  const { platform } = process;

  // The command to run inside the new terminal
  const reviewCmd = `cd ${JSON.stringify(repoRoot)} && npx gatekeeper-ai review; echo "Press any key to close..."; read -n1`;

  try {
    if (platform === 'darwin') {
      // macOS: use AppleScript to open a new Terminal.app window
      const script = `tell application "Terminal"
  activate
  do script ${JSON.stringify(reviewCmd)}
end tell`;
      execSync(`osascript -e ${JSON.stringify(script)}`, { stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } else if (platform === 'linux') {
      // Linux: try common terminal emulators
      const terminals = [
        ['gnome-terminal', '--', 'bash', '-c', reviewCmd],
        ['xterm', '-e', reviewCmd],
        ['konsole', '-e', reviewCmd],
      ];
      for (const [bin, ...args] of terminals) {
        try {
          execSync(`which ${bin}`, { stdio: ['ignore', 'ignore', 'ignore'] });
          spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
          return true;
        } catch { /* try next */ }
      }
    }
  } catch { /* fall through */ }

  return false;
}

/**
 * Write a human-readable review report to .gatekeeper/LAST_REVIEW.md.
 * This is the primary way GUI users (VSCode, etc.) find out what happened.
 */
function writeLastReview(repoRoot, status, issues, summary) {
  try {
    const dir = join(repoRoot, '.gatekeeper');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const ts = new Date().toLocaleString();
    const emoji = status === 'yellow' ? '🟡' : '🔴';
    const heading = status === 'yellow' ? 'Warnings — push blocked' : 'CRITICAL issues — push blocked';

    const lines = [
      `# ${emoji} Gatekeeper Review`,
      `**${heading}**  ·  ${ts}`,
      '',
      `## Summary`,
      summary,
      '',
      `## Issues`,
      '',
    ];

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const sev = issue.severity === 'critical' ? '🚨 CRITICAL' : '⚠️  Warning';
      lines.push(`### ${i + 1}. ${sev}`);
      lines.push(issue.plain_english);
      lines.push('');
      lines.push('**How to fix:**');
      lines.push(`> ${issue.fix_prompt}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    if (status === 'yellow') {
      lines.push('To push anyway (bypass warnings): `GATEKEEPER_ALLOW_WARNINGS=1 git push`');
    } else {
      lines.push('To override (bypass critical issues): `GATEKEEPER_OVERRIDE=1 git push`');
    }
    lines.push('');

    writeFileSync(join(dir, 'LAST_REVIEW.md'), lines.join('\n'), 'utf8');
  } catch {
    // Never block a push due to file write failure
  }
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
 * Read a single keypress from /dev/tty, normalised to lowercase.
 * Accepts only keys in the allowed set.
 * Uses /dev/tty directly so it works even when process.stdin is a git pipe.
 */
async function readChoice(allowed, defaultKey = null) {
  return new Promise((resolve) => {
    const ttyStream = openTtyStream();
    const inputStream = ttyStream || process.stdin;

    const rl = createInterface({ input: inputStream, output: process.stdout });
    process.stdout.write(`Choice [${allowed.join('/').toUpperCase()}]${defaultKey ? ` (default: ${defaultKey.toUpperCase()})` : ''}: `);

    // Raw mode: single keypress UX (works when the stream is a real tty)
    if (inputStream.setRawMode) {
      inputStream.setRawMode(true);
      inputStream.resume();
      inputStream.setEncoding('utf8');

      const onData = (key) => {
        if (key === '\u0003') { // Ctrl+C
          process.stdout.write('\n');
          inputStream.setRawMode(false);
          inputStream.removeListener('data', onData);
          rl.close();
          process.exit(1);
        }

        if ((key === '\r' || key === '\n') && defaultKey) {
          process.stdout.write(defaultKey.toUpperCase() + '\n');
          inputStream.setRawMode(false);
          inputStream.removeListener('data', onData);
          rl.close();
          resolve(defaultKey);
          return;
        }

        const lower = key.toLowerCase();
        if (allowed.includes(lower)) {
          process.stdout.write(key.toUpperCase() + '\n');
          inputStream.setRawMode(false);
          inputStream.removeListener('data', onData);
          rl.close();
          resolve(lower);
        }
      };

      inputStream.on('data', onData);
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
 * Read a full line from /dev/tty.
 */
async function readLine() {
  return new Promise((resolve) => {
    const ttyStream = openTtyStream();
    const inputStream = ttyStream || process.stdin;
    const rl = createInterface({ input: inputStream, output: process.stdout });
    rl.on('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
}
