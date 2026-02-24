/**
 * gatekeeper.js
 * Core review function — standalone, no side effects.
 * Takes a diff + repo context snapshot, calls the Anthropic API,
 * and returns a structured JSON review result.
 */

import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `You are a repository integrity reviewer. Your job is to protect a codebase from
agentic coding mistakes — not to judge code quality, fix bugs, or suggest improvements.

You will receive:
- A git diff of proposed changes
- A snapshot of the repository structure
- The user's original request (if available)

Review the diff ONLY for these five issues, in priority order:

1. DESTRUCTIVE CHANGES
   Does the diff delete, overwrite, or rename anything that wasn't mentioned
   in the user's original request? Flag any file deletions, function removals,
   or data overwrites that seem unintentional.

2. INTERFACE BREAKAGE
   Does the diff change a function signature, rename an export, or modify a
   shared utility in a way that would break other files that depend on it?
   Check the provided import graph.

3. DISCONNECTED CODE
   Is new code being added that nothing calls, imports, or connects to?
   New files or functions with no entry point are a common agentic failure mode.

4. LOGIC DUPLICATION
   Does this recreate logic that clearly already exists elsewhere in the repo?
   Check function names and patterns in the file tree.

5. PATTERN MISMATCH
   Does the code significantly deviate from the patterns visible in the rest
   of the codebase? (e.g. switching paradigms, using different error handling
   approaches, inconsistent naming conventions)

Also respect any rules in GATEKEEPER.md if provided.

Return ONLY valid JSON in this exact schema — no explanation, no markdown:

{
  "status": "green" | "yellow" | "red",
  "issues": [
    {
      "severity": "warning" | "critical",
      "category": "destructive" | "interface_breakage" | "disconnected" | "duplication" | "pattern_mismatch",
      "plain_english": "One sentence description a non-developer can understand",
      "fix_prompt": "Specific instruction to send back to Claude Code to fix this issue"
    }
  ],
  "summary": "One sentence plain-english summary of the overall review"
}

Status rules:
- green: no issues found
- yellow: issues found but none are critical
- red: one or more critical issues found

If no issues are found, return an empty issues array.`;

/**
 * Review a git diff for repo integrity issues.
 *
 * @param {object} params
 * @param {string} params.diff - The git diff of proposed changes
 * @param {object} params.repoContext - Repo snapshot from context-builder
 * @param {string} [params.userRequest] - Original user request, if available
 * @param {string} params.apiKey - Anthropic API key
 * @returns {Promise<{status: string, issues: Array, summary: string}>}
 */
export async function review({ diff, repoContext, userRequest, apiKey }) {
  const client = new Anthropic({ apiKey });

  const userContent = buildUserMessage({ diff, repoContext, userRequest });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  });

  const responseText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return parseReviewResult(responseText);
}

/**
 * Build the user message string from diff, repo context, and optional request.
 */
function buildUserMessage({ diff, repoContext, userRequest }) {
  const parts = [];

  if (userRequest) {
    parts.push(`## User's Original Request\n${userRequest}`);
  }

  parts.push(`## Git Diff\n\`\`\`diff\n${diff}\n\`\`\``);

  parts.push(`## Repository File Tree\n${repoContext.fileTree}`);

  if (repoContext.modifiedFileContents && Object.keys(repoContext.modifiedFileContents).length > 0) {
    parts.push('## Modified File Contents');
    for (const [filePath, content] of Object.entries(repoContext.modifiedFileContents)) {
      parts.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  if (repoContext.dependentSignatures && Object.keys(repoContext.dependentSignatures).length > 0) {
    parts.push('## Signatures of Files That Import Modified Files');
    for (const [filePath, signatures] of Object.entries(repoContext.dependentSignatures)) {
      parts.push(`### ${filePath}\n${signatures}`);
    }
  }

  if (repoContext.gatekeeperRules) {
    parts.push(`## Project-Specific Rules (GATEKEEPER.md)\n${repoContext.gatekeeperRules}`);
  }

  return parts.join('\n\n');
}

/**
 * Parse and validate the JSON response from the model.
 */
function parseReviewResult(responseText) {
  // Strip markdown code fences if the model wrapped the JSON
  const cleaned = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gatekeeper received an invalid response from the API:\n${responseText}`);
  }

  // Basic validation
  if (!['green', 'yellow', 'red'].includes(result.status)) {
    throw new Error(`Invalid status in review result: ${result.status}`);
  }
  if (!Array.isArray(result.issues)) {
    throw new Error('Review result missing issues array');
  }
  if (typeof result.summary !== 'string') {
    throw new Error('Review result missing summary string');
  }

  return result;
}
