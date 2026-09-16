export type CommunicationRisk = 'routine' | 'consequential';

export interface DraftedReply {
  channel: string;
  threadTs?: string | null;
  text: string;
  risk: CommunicationRisk;
  reasons: string[];
}

export interface OutgoingContext {
  channel: string;
  channelName: string;
  threadTs?: string | null;
  incomingText: string; // the message being replied to
}
