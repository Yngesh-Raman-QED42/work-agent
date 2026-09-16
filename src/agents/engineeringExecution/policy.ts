import { taskFullText, type TaskContext } from './models.js';

// Explicit human instructions to hold off. Checked against the FULL text
// (summary + description + every comment) — the real-world case that
// motivated this list was a comment, not the description, saying
// "keep this one on hold, do not start working on this one."
const BLOCKING_PHRASES = [
  /do not start/i,
  /don'?t start/i,
  /keep .{0,20}on hold/i,
  /put .{0,20}on hold/i,
  /hold off/i,
  /do not work on/i,
  /don'?t work on/i,
  /paused? for now/i,
];

// Anything touching auth/permissions/security/money is excluded from
// autonomy regardless of how small it looks — those categories have blast
// radius that isn't visible from the diff alone.
const SENSITIVE_KEYWORDS = [
  'permission', 'role-based', 'rbac', 'admin right', 'auth', 'security',
  'password', 'credential', 'secret', 'token', 'payment', 'billing',
  'invoice', 'salary', 'compensation', 'pii', 'gdpr', 'encrypt',
];

const ALLOWED_ISSUE_TYPES = new Set(['task', 'bug']);
// Every standard Jira priority is allowed — urgency alone doesn't make a
// ticket unsafe for autonomous work; scope/sensitivity (checked below)
// does. Kept as an explicit allowlist (not "anything goes") so a
// non-standard priority value some project invents isn't silently admitted.
const ALLOWED_PRIORITIES = new Set(['low', 'medium', 'high', 'critical', 'highest', 'lowest']);
// "On Hold" is allowed alongside "To Do" — a status of On Hold doesn't by
// itself mean stop; BLOCKING_PHRASES below still catches an explicit human
// "keep this on hold, don't start" instruction in the ticket's own text.
const ALLOWED_STATUSES = new Set(['to do', 'on hold']);
const MIN_DESCRIPTION_LENGTH = 80;

export interface AutonomyPolicyConfig {
  allowedProjects?: Set<string>; // empty/undefined = no additional restriction beyond repo mapping
  allowedIssueTypes?: Set<string>;
  allowedPriorities?: Set<string>;
  allowedStatuses?: Set<string>;
  minDescriptionLength?: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export class AutonomyPolicy {
  private allowedProjects: Set<string>;
  private allowedIssueTypes: Set<string>;
  private allowedPriorities: Set<string>;
  private allowedStatuses: Set<string>;
  private minDescriptionLength: number;

  constructor(config: AutonomyPolicyConfig = {}) {
    this.allowedProjects = config.allowedProjects ?? new Set();
    this.allowedIssueTypes = config.allowedIssueTypes ?? new Set(ALLOWED_ISSUE_TYPES);
    this.allowedPriorities = config.allowedPriorities ?? new Set(ALLOWED_PRIORITIES);
    this.allowedStatuses = config.allowedStatuses ?? new Set(ALLOWED_STATUSES);
    this.minDescriptionLength = config.minDescriptionLength ?? MIN_DESCRIPTION_LENGTH;
  }

  isEligible(task: TaskContext): EligibilityResult {
    if (this.allowedProjects.size > 0 && !this.allowedProjects.has(task.project)) {
      return { eligible: false, reasons: [`project ${task.project} is not in the autonomy allowlist`] };
    }
    if (!this.allowedIssueTypes.has(task.issueType.toLowerCase())) {
      return { eligible: false, reasons: [`issue type ${task.issueType} is not eligible for autonomous execution`] };
    }
    if (!this.allowedPriorities.has(task.priority.toLowerCase())) {
      return { eligible: false, reasons: [`priority ${task.priority} is above the autonomy threshold`] };
    }
    if (!this.allowedStatuses.has(task.status.toLowerCase())) {
      return { eligible: false, reasons: [`status ${task.status} is not eligible (expected one of ${[...this.allowedStatuses].sort().join(', ')})`] };
    }

    const fullText = taskFullText(task);
    for (const phrase of BLOCKING_PHRASES) {
      if (phrase.test(fullText)) {
        return { eligible: false, reasons: [`found an explicit hold instruction matching ${phrase}`] };
      }
    }

    const hitKeywords = SENSITIVE_KEYWORDS.filter((kw) => fullText.toLowerCase().includes(kw));
    if (hitKeywords.length > 0) {
      return { eligible: false, reasons: [`touches sensitive area(s): ${[...new Set(hitKeywords)].sort().join(', ')}`] };
    }

    if (task.description.trim().length < this.minDescriptionLength) {
      return { eligible: false, reasons: ['description is too short/absent to safely scope autonomous work'] };
    }

    return {
      eligible: true,
      reasons: [
        `project ${task.project} allowed`,
        `issue type ${task.issueType} allowed`,
        `priority ${task.priority} allowed`,
        `status ${task.status} allowed`,
        'no blocking instructions found',
        'no sensitive keywords found',
        `description length ${task.description.trim().length} chars, sufficient`,
      ],
    };
  }
}
