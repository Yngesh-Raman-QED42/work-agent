import type { GitHubPr, JiraIssue, SlackMessage, WorkItem } from '../models/types.js';
import { prJiraKeys, slackMessageJiraKeys } from '../models/types.js';

export function correlate(jiraIssues: JiraIssue[], prs: GitHubPr[], messages: SlackMessage[]): WorkItem[] {
  const itemsByKey = new Map<string, WorkItem>();
  for (const issue of jiraIssues) {
    itemsByKey.set(issue.key, {
      id: issue.key,
      jira: issue,
      prs: [],
      slackMessages: [],
      category: 'fyi',
      urgency: 'low',
      reasons: [],
    });
  }

  const standalone: WorkItem[] = [];

  for (const pr of prs) {
    let matchedAny = false;
    for (const key of prJiraKeys(pr)) {
      const item = itemsByKey.get(key);
      if (item) {
        item.prs.push(pr);
        matchedAny = true;
      }
    }
    if (!matchedAny) {
      standalone.push({
        id: `pr:${pr.repo}#${pr.number}`,
        jira: null,
        prs: [pr],
        slackMessages: [],
        category: 'fyi',
        urgency: 'low',
        reasons: [],
      });
    }
  }

  // Second pass: a PR explicitly linked from the Jira side (e.g. someone
  // pasted the GitHub URL into a comment) but whose own title/branch never
  // mentions the ticket key — the first pass above can't see this at all.
  // Real case that motivated this: a PR titled with no Jira key, linked only
  // via a Jira comment saying "PR raised: <url>".
  for (const item of itemsByKey.values()) {
    for (const ref of item.jira?.linkedPrRefs ?? []) {
      if (item.prs.some((p) => p.repo === ref.repo && p.number === ref.number)) continue;
      const pr = prs.find((p) => p.repo === ref.repo && p.number === ref.number);
      if (!pr) continue;
      item.prs.push(pr);
      const standaloneIdx = standalone.findIndex((s) => s.id === `pr:${pr.repo}#${pr.number}`);
      if (standaloneIdx !== -1) standalone.splice(standaloneIdx, 1);
    }
  }

  for (const msg of messages) {
    let matchedAny = false;
    for (const key of slackMessageJiraKeys(msg)) {
      const item = itemsByKey.get(key);
      if (item) {
        item.slackMessages.push(msg);
        matchedAny = true;
      }
    }
    if (!matchedAny && msg.mentionsMe) {
      standalone.push({
        id: `slack:${msg.channel}:${msg.ts}`,
        jira: null,
        prs: [],
        slackMessages: [msg],
        category: 'fyi',
        urgency: 'low',
        reasons: [],
      });
    }
  }

  return [...itemsByKey.values(), ...standalone];
}
