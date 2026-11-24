import type { OutboundSms, SmsProvider } from "./types.ts";

export interface SentMessage extends OutboundSms {
  messageId: string;
  sentAt: Date;
}

/** Offline provider. Records every message and honors the idempotency key like a real API would. */
export class MockSmsProvider implements SmsProvider {
  readonly sent: SentMessage[] = [];
  /** Number of upcoming sends that should fail, for tests. */
  failNext = 0;
  private now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  async send(message: OutboundSms): Promise<{ messageId: string }> {
    await Promise.resolve();
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("mock provider outage");
    }
    const prior = this.sent.find((m) => m.idempotencyKey === message.idempotencyKey);
    if (prior) return { messageId: prior.messageId };
    const messageId = `msg_${String(this.sent.length + 1).padStart(4, "0")}`;
    this.sent.push({ ...message, messageId, sentAt: this.now() });
    return { messageId };
  }
}

/** Generic JSON SMS API client. Only used when SMS_PROVIDER=http. */
export class HttpSmsProvider implements SmsProvider {
  private url: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    this.url = url;
    this.apiKey = apiKey;
  }

  async send(message: OutboundSms): Promise<{ messageId: string }> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({ to: message.to, from: message.from, body: message.body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SMS API responded ${res.status}`);
    const data = (await res.json()) as { id?: unknown };
    return { messageId: String(data.id ?? message.idempotencyKey) };
  }
}
