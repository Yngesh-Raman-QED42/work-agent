export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  url: string;
  resolved: boolean;
}

export type CiStatus = 'pending' | 'success' | 'failure' | 'unknown';
export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'pending';

export interface PrStatus {
  repo: string;
  number: number;
  url: string;
  branch: string;
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean | null;
  ciStatus: CiStatus;
  reviewState: ReviewState;
  comments: ReviewComment[];
}

export type FeedbackVerdict = 'straightforward' | 'escalate';

export interface FeedbackClassification {
  comment: ReviewComment;
  verdict: FeedbackVerdict;
  reasons: string[];
}

export type MonitorOutcome = 'no_action_needed' | 'auto_fix_pushed' | 'escalated' | 'stopped_failed_checks';

export interface MonitorResult {
  outcome: MonitorOutcome;
  pr: PrStatus;
  reasons: string[];
  worktreePath?: string;
}
