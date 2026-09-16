import type { AnyDb } from '../../db/index.js';
import { AuditLog } from '../../pipeline/audit.js';
import { ApprovalsStore } from '../../shared/approvals.js';
import type { MessageDrafter } from './drafter.js';
import type { SlackSender } from './sender.js';
import type { OutgoingContext } from './models.js';

export interface CommunicationDeps {
  db: AnyDb;
  drafter: MessageDrafter;
  sender: SlackSender;
  autoSendRoutine: boolean; // config.communication.autoSendRoutine — false by default, never inferred
}

export type CommunicationOutcome = 'auto_sent' | 'queued_for_approval';

export interface CommunicationResult {
  outcome: CommunicationOutcome;
  text: string;
  risk: 'routine' | 'consequential';
}

/**
 * Drafts a reply and either sends it (only if BOTH the draft is routine-risk
 * AND autonomy has been explicitly enabled for that) or files it to the
 * approval queue for a human to approve/edit/reject before anything is
 * sent. Never sends a consequential draft autonomously, no matter what
 * config says — that's not a config knob, it's structural.
 */
export async function draftAndRoute(deps: CommunicationDeps, context: OutgoingContext): Promise<CommunicationResult> {
  const audit = new AuditLog(deps.db);
  const approvals = new ApprovalsStore(deps.db);

  const drafted = deps.drafter.draft(context);
  await audit.log('communication_drafted', { channel: context.channel, risk: drafted.risk });

  if (drafted.risk === 'routine' && deps.autoSendRoutine) {
    await deps.sender.sendMessage(drafted.channel, drafted.threadTs, drafted.text);
    await audit.log('communication_auto_sent', { channel: drafted.channel, thread_ts: drafted.threadTs });
    return { outcome: 'auto_sent', text: drafted.text, risk: drafted.risk };
  }

  const id = `comm:${context.channel}:${context.threadTs ?? 'root'}:${Date.now()}`;
  await approvals.file({
    id,
    source: 'communication',
    action: 'send_slack_message',
    target: context.channelName,
    targetUrl: null,
    context: { channel: drafted.channel, threadTs: drafted.threadTs, incomingText: context.incomingText, draftedText: drafted.text },
    reasoning: drafted.reasons.join('; '),
    riskLevel: drafted.risk === 'consequential' ? 'high' : 'low',
    consequenceIfApproved: `Sends the drafted message to ${context.channelName} on your behalf.`,
    recommendedAction: `Review/edit this draft, then approve to send:\n\n"${drafted.text}"`,
  });
  await audit.log('communication_queued_for_approval', { id, risk: drafted.risk });

  return { outcome: 'queued_for_approval', text: drafted.text, risk: drafted.risk };
}

/** Called once a human has approved a queued communication entry (e.g. via
 * the CLI). Sends exactly what's in the approval's context — never
 * re-drafts, never sends anything the human hasn't seen. */
export async function sendApprovedCommunication(db: AnyDb, sender: SlackSender, approvalId: string): Promise<void> {
  const approvals = new ApprovalsStore(db);
  const audit = new AuditLog(db);
  const approval = await approvals.get(approvalId);
  if (!approval) throw new Error(`no such approval: ${approvalId}`);
  if (approval.status !== 'approved') throw new Error(`approval ${approvalId} is not in "approved" status (it's "${approval.status}")`);

  const ctx = approval.context as { channel: string; threadTs: string | null; draftedText: string };
  await sender.sendMessage(ctx.channel, ctx.threadTs, ctx.draftedText);
  await audit.log('communication_sent_after_approval', { approval_id: approvalId, channel: ctx.channel });
}
