import type { DraftedReply, OutgoingContext } from './models.js';
import { classifyCommunicationRisk } from './riskClassifier.js';

/**
 * Drafts a reply. This is deliberately a template, not an LLM call — every
 * other decision-making piece of this system (classify.ts, policy.ts,
 * feedbackClassifier.ts) is rule-based and deterministic by design, and the
 * spec explicitly requires "the system must never impersonate my judgment
 * in sensitive conversations" and "never fabricate." A template that
 * acknowledges and buys time is safe to draft automatically; anything
 * requiring real judgment about what to SAY always goes to the approval
 * queue for you to write or edit before it's sent (never auto-sent
 * unedited). Swap this for a real LLM-backed drafter later behind the same
 * interface if you want richer drafts — the risk-gating downstream doesn't
 * change either way.
 */
export interface MessageDrafter {
  draft(context: OutgoingContext): DraftedReply;
}

export class TemplateMessageDrafter implements MessageDrafter {
  draft(context: OutgoingContext): DraftedReply {
    const { risk, reasons } = classifyCommunicationRisk(context.incomingText);
    const text =
      risk === 'routine'
        ? "Thanks for flagging — looking into this now, I'll follow up shortly."
        : '[DRAFT NEEDS YOUR INPUT — this touches a commitment/deadline/decision/client/sensitive topic, template below is a starting point only]\n' +
          "Thanks for the context — let me look into this and get back to you.";
    return { channel: context.channel, threadTs: context.threadTs, text, risk, reasons };
  }
}

export class MockMessageDrafter implements MessageDrafter {
  constructor(private fixedReply: DraftedReply) {}
  draft(): DraftedReply {
    return this.fixedReply;
  }
}
