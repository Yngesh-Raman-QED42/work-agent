import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// The implementer runs Claude Code's `/code-review` on its own change before
// `exec-finish`, fixes what's real, and records the outcome here. `exec-finish`
// refuses to open a PR without this record, for every project: a reviewer
// shouldn't be the first one to find bugs a self-review would have caught.
// Lives under .work-agent/, so it is never committed (see runbook.ts).
export const CODE_REVIEW_PATH = '.work-agent/code-review.json';

const findingSchema = z
  .object({
    summary: z.string().trim().min(1),
    outcome: z.enum(['fixed', 'not_fixed']),
    // Why a finding was left alone (false positive, out of scope, needs a product decision...).
    reason: z.string().trim().optional(),
  })
  .refine((f) => f.outcome === 'fixed' || Boolean(f.reason), {
    message: 'every not_fixed finding needs a "reason"',
  });

const recordSchema = z.object({
  // Empty is fine: the review ran and found nothing.
  findings: z.array(findingSchema),
});

export type CodeReviewRecord = z.infer<typeof recordSchema>;

export type CodeReviewCheck = { ok: true; record: CodeReviewRecord } | { ok: false; reason: string };

const HOW_TO = `Run /code-review on the change in this worktree, fix every real finding, re-run the checks, then write ${CODE_REVIEW_PATH} as {"findings":[{"summary":"...","outcome":"fixed"|"not_fixed","reason":"why, if not_fixed"}]} (an empty array if it found nothing) and run exec-finish again.`;

export async function readCodeReviewRecord(worktreePath: string): Promise<CodeReviewCheck> {
  const fullPath = path.join(worktreePath, CODE_REVIEW_PATH);
  if (!existsSync(fullPath)) {
    return { ok: false, reason: `No code review recorded for this change. ${HOW_TO}` };
  }
  let text: string;
  try {
    text = await readFile(fullPath, 'utf-8');
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `${CODE_REVIEW_PATH} couldn't be read (${why}). ${HOW_TO}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${CODE_REVIEW_PATH} is not valid JSON. ${HOW_TO}` };
  }
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `${CODE_REVIEW_PATH} is malformed (${issue?.path.join('.') || 'root'}: ${issue?.message}). ${HOW_TO}`,
    };
  }
  return { ok: true, record: parsed.data };
}

/**
 * Throw the record away once an attempt has reached a stop that sends the
 * implementer back to change code (failed checks, gate), so the next attempt
 * needs a fresh review instead of reusing a stale one. An attempt that crashes
 * part-way (network, push) keeps it: the code it covers hasn't changed.
 */
export async function discardCodeReviewRecord(worktreePath: string): Promise<void> {
  await rm(path.join(worktreePath, CODE_REVIEW_PATH), { force: true });
}

/** Read the record and discard it at once: for single-pass flows (PR feedback fixes). */
export async function consumeCodeReviewRecord(worktreePath: string): Promise<CodeReviewCheck> {
  const check = await readCodeReviewRecord(worktreePath);
  if (check.ok) await discardCodeReviewRecord(worktreePath);
  return check;
}

/**
 * The review instruction both implementer prompts share (new ticket, PR feedback).
 * `.work-agent/` is the orchestrator's own bookkeeping, never committed, so it is
 * kept out of the review.
 */
export function codeReviewStep(step: number, worktreePath: string): string {
  return `${step}. REVIEW YOUR OWN CHANGE before finishing: run Claude Code's \`/code-review\` command on
   it, pointed explicitly at this worktree (the session's own directory may be a different
   repo), e.g. \`/code-review ${worktreePath} (review the uncommitted changes, git diff HEAD
   plus untracked files, excluding .work-agent/, run inside that directory)\`. Fix every real
   finding, then re-run the checks. Record the outcome in ${CODE_REVIEW_PATH} as
   {"findings":[{"summary":"...","outcome":"fixed"|"not_fixed","reason":"why, if not_fixed"}]}
   (an empty array if it found nothing). No PR is opened or updated without it.`;
}

export function describeCodeReview(record: CodeReviewRecord): string {
  const fixed = record.findings.filter((f) => f.outcome === 'fixed').length;
  const notFixed = record.findings.length - fixed;
  return `Code review: ${record.findings.length} finding(s), ${fixed} fixed, ${notFixed} left with a reason.`;
}
