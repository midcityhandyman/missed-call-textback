import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import type { TextbackService } from "./service.ts";
import { SendFailedError, ValidationError } from "./types.ts";

const MAX_BODY_BYTES = 64 * 1024;

export function sign(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function signatureOk(secret: string, rawBody: string, header: string | string[] | undefined): boolean {
  if (!secret) return true;
  if (typeof header !== "string") return false;
  const expected = Buffer.from(sign(secret, rawBody));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ValidationError("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * POST /webhooks/call-events  provider call events (signed when WEBHOOK_SECRET is set)
 * POST /webhooks/sms-inbound  inbound texts, used for STOP and START
 * GET  /healthz
 */
export function createServer(service: TextbackService, config: Config): Server {
  return createHttpServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/healthz") return reply(res, 200, { ok: true });
      if (req.method !== "POST" || (path !== "/webhooks/call-events" && path !== "/webhooks/sms-inbound")) {
        return reply(res, 404, { error: "not found" });
      }
      const raw = await readBody(req);
      if (!signatureOk(config.webhookSecret, raw, req.headers["x-signature"])) {
        return reply(res, 401, { error: "bad signature" });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ValidationError("body must be JSON");
      }
      if (path === "/webhooks/sms-inbound") return reply(res, 200, service.handleInboundSms(body));
      return reply(res, 200, await service.handleCallEvent(body));
    } catch (err) {
      if (err instanceof ValidationError) return reply(res, 400, { error: err.message });
      // A 502 tells the provider to retry. The event id was not recorded, so the retry is processed.
      if (err instanceof SendFailedError) return reply(res, 502, { error: err.message });
      return reply(res, 500, { error: "internal error" });
    }
  });
}
