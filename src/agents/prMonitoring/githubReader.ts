import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CiStatus, PrStatus, ReviewComment, ReviewState } from './models.js';

const execFileAsync = promisify(execFile);

export interface PrStatusReader {
  fetchPrStatus(repo: string, number: number): Promise<PrStatus>;
}

/** Read-only, via `gh` CLI (see engineeringExecution/prOps.ts for why: the
 * GitHub MCP plugin's PAT can't see org repos, `gh` already can here).
 *
 * Simplification, documented rather than hidden: `gh pr view` doesn't expose
 * per-thread "resolved" state (that needs a separate GraphQL query) so every
 * comment here is treated as unresolved. Fine for Phase 3 — worst case is
 * re-classifying an already-addressed comment, which is idempotent, not
 * unsafe. */
export class GhCliPrStatusReader implements PrStatusReader {
  async fetchPrStatus(repo: string, number: number): Promise<PrStatus> {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'view', String(number),
      '--repo', repo,
      '--json', 'number,url,state,headRefName,mergeable,reviewDecision,statusCheckRollup,comments,reviews',
    ]);
    const data = JSON.parse(stdout) as {
      number: number;
      url: string;
      state: string;
      headRefName: string;
      mergeable: string; // "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
      reviewDecision: string; // "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | ""
      statusCheckRollup?: Array<{ conclusion?: string; state?: string }>;
      comments?: Array<{ id: string; author: { login: string }; body: string; url: string }>;
      reviews?: Array<{ id: string; author: { login: string }; body: string; state: string }>;
    };

    const comments: ReviewComment[] = [
      ...(data.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author?.login ?? 'unknown',
        body: c.body,
        url: c.url,
        resolved: false,
      })),
      ...(data.reviews ?? [])
        .filter((r) => r.body && r.body.trim().length > 0)
        .map((r) => ({
          id: r.id,
          author: r.author?.login ?? 'unknown',
          body: r.body,
          url: data.url,
          resolved: false,
        })),
    ];

    return {
      repo,
      number: data.number,
      url: data.url,
      branch: data.headRefName,
      state: data.state.toLowerCase() === 'open' ? 'open' : data.state.toLowerCase() === 'merged' ? 'merged' : 'closed',
      mergeable: data.mergeable === 'MERGEABLE' ? true : data.mergeable === 'CONFLICTING' ? false : null,
      ciStatus: mapCiStatus(data.statusCheckRollup ?? []),
      reviewState: mapReviewState(data.reviewDecision),
      comments,
    };
  }
}

function mapCiStatus(rollup: Array<{ conclusion?: string; state?: string }>): CiStatus {
  if (rollup.length === 0) return 'unknown';
  const values = rollup.map((r) => (r.conclusion ?? r.state ?? '').toUpperCase());
  if (values.some((v) => v === 'FAILURE' || v === 'ERROR')) return 'failure';
  if (values.some((v) => v === 'PENDING' || v === 'IN_PROGRESS' || v === 'QUEUED')) return 'pending';
  if (values.every((v) => v === 'SUCCESS')) return 'success';
  return 'unknown';
}

function mapReviewState(reviewDecision: string): ReviewState {
  switch (reviewDecision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'pending';
    default:
      return 'commented';
  }
}

export class MockPrStatusReader implements PrStatusReader {
  constructor(private status: PrStatus) {}

  async fetchPrStatus(): Promise<PrStatus> {
    return this.status;
  }
}
