export interface CallEvent {
  eventId: string;
  type: string;
  from: string;
  to: string;
  occurredAt: string;
  callerTimeZone?: string;
}

export type Outcome =
  | "sent"
  | "deferred"
  | "skipped_opted_out"
  | "skipped_already_texted"
  | "ignored_not_missed";

export interface Decision {
  eventId: string;
  outcome: Outcome;
  reason: string;
  to: string;
  decidedAt: string;
  timeZone?: string;
  sendAt?: string;
  sentAt?: string;
  messageId?: string;
  wasDeferred?: boolean;
  duplicate?: boolean;
}

export interface DeferredText {
  eventId: string;
  to: string;
  timeZone: string;
  sendAt: number;
  attempts: number;
}

export interface OutboundSms {
  to: string;
  from: string;
  body: string;
  idempotencyKey: string;
}

export interface SmsProvider {
  send(message: OutboundSms): Promise<{ messageId: string }>;
}

export class ValidationError extends Error {}
export class SendFailedError extends Error {}
