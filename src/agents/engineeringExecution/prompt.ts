import type { TaskContext } from './models.js';
import { SCREENSHOT_STEPS_PATH, type PreviewRecipe } from './screenshot.js';

function commentsBlockFor(task: TaskContext): string {
  return task.comments.length > 0 ? task.comments.map((c) => `- ${c.author}: ${c.body}`).join('\n') : '(no comments)';
}

export function buildImplementationPrompt(task: TaskContext, worktreePath: string, previewRecipe: PreviewRecipe | null = null): string {
  const commentsBlock = commentsBlockFor(task);
  const subtasks = task.subtasks ?? [];
  const hasSubtasks = subtasks.length > 0;

  // A story's own text is often just "As a user, I want X" — the real
  // acceptance criteria live in its sub-tasks, so each one gets the same
  // full treatment (summary/description/comments) the top-level ticket
  // does, not just a one-line list of titles.
  const subtasksBlock = hasSubtasks
    ? `\n\nThis story has ${subtasks.length} sub-task(s) — implement all of them together, in this one branch,
as one coherent change. They build on each other (a later one may depend on an earlier one's
work), so read all of them before starting, not one at a time:
${subtasks
  .map(
    (s, i) =>
      `\n--- Sub-task ${i + 1}/${subtasks.length}: ${s.key} (${s.issueType}) ---\nSummary: ${s.summary}\n\nDescription:\n${s.description}\n\nComments:\n${commentsBlockFor(s)}`,
  )
  .join('\n')}`
    : '';
  const loginBlock = previewRecipe?.testLogin
    ? ` This app requires signing in to see most pages — if your screenshot needs an
authenticated view, make your FIRST step log in using this exact test identity, then a
SECOND step for the real page you want to show:
[
  { "label": "sign in", "path": "/login", "waitForSelector": "${previewRecipe.testLogin.emailSelector}",
    "actions": [
      { "type": "fill", "selector": "${previewRecipe.testLogin.emailSelector}", "value": "${previewRecipe.testLogin.email}" },
      { "type": "click", "selector": "${previewRecipe.testLogin.submitSelector}" }
    ] },
  { "label": "...the real page...", "path": "/wherever-the-change-is" }
]`
    : '';
  const screenshotBlock = previewRecipe
    ? `

Optional — only if this change is visible in the running app's UI:
Write ${SCREENSHOT_STEPS_PATH} (create the .work-agent/ directory if needed) as a JSON
array describing 1-3 navigation steps that would show the change once the dev server is
running, e.g.:
[
  { "label": "Export button on the Reports page", "path": "/reports", "waitForSelector": "[data-testid=export-btn]" }
]
Each step: "label" (short caption), "path" (URL path to visit), optionally
"waitForSelector" (CSS selector to wait for before capturing) and "actions" (a list of
{ "type": "click"|"fill", "selector": "...", "value": "..." } to run first, e.g. to open a
panel or apply a filter).${loginBlock} Do NOT write this file for a backend-only or
non-visual change — skip it entirely rather than guessing at a page to screenshot.`
    : '';

  const scopeLine = hasSubtasks
    ? `You are implementing one Jira story — ${task.key} — together with all ${subtasks.length} of its
sub-tasks below, as ONE coherent change in ONE isolated git worktree. This is deliberate: the
sub-tasks build on each other and a story is the real unit of reviewable, testable work, not
any one sub-task alone. Follow this order strictly:`
    : `You are implementing exactly one Jira ticket in an isolated git worktree. Follow this order strictly:`;

  return `${scopeLine}

1. INSPECT FIRST. Read the relevant existing code before changing anything. Do not
   guess at file locations — search the codebase for the feature area described below.
2. Implement the smallest change that satisfies the acceptance criteria below${hasSubtasks ? ' — across every sub-task' : ''}. Do not
   expand scope, refactor unrelated code, or "improve while you're in there."
3. After implementing, run the project's test suite, lint, typecheck, and build
   (check package.json scripts) and fix any failures your change introduced.

Hard constraints:
- Your working directory is ${worktreePath} — never touch any path outside it.
- Do NOT run any git command that mutates history or refs: no \`git commit\`, \`git push\`,
  \`git checkout -b\`, \`git reset\`, \`git rebase\`. Read-only git (status/diff/log) is fine
  for your own situational awareness. Committing and pushing is handled by the
  orchestrator after your work is reviewed, not by you.
- Do NOT touch CI config (.github/workflows), environment files (.env*), lockfiles
  (package-lock.json etc.), or database migrations — if the task genuinely requires
  changing one of those, STOP and explain why instead of making the change.
- Do NOT send any Slack message, do NOT call any Jira/GitHub write API, do NOT deploy
  anything, do NOT merge anything. You have no credentials for any of that here anyway.
- If the ticket is ambiguous, or the fix requires a product/design decision you can't
  make from the ticket text alone, STOP and clearly say so instead of guessing.

${hasSubtasks ? 'Story' : 'Ticket'}: ${task.key} (${task.issueType}, priority ${task.priority})
URL: ${task.url}

Summary: ${task.summary}

Description:
${task.description}

Comments:
${commentsBlock}
${subtasksBlock}
${screenshotBlock}

When you're done (or if you stopped early), give a final summary of exactly what you
changed and why, and confirm the test/lint/typecheck/build results.
`;
}
