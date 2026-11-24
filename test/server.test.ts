import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createServer, sign } from "../src/server.ts";
import { HttpSmsProvider } from "../src/sms.ts";
import { missed, setup } from "./helpers.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(url: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("webhook end to end: send, duplicate, opt out, bad input", async () => {
  const { service, config, sms } = setup();
  const base = await listen(createServer(service, config));
  const event = JSON.stringify(missed("+13125550104"));

  const first = await post(`${base}/webhooks/call-events`, event);
  assert.equal(first.status, 200);
  assert.equal(first.json.outcome, "sent");

  const again = await post(`${base}/webhooks/call-events`, event);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(sms.sent.length, 1);

  const stop = await post(`${base}/webhooks/sms-inbound`, JSON.stringify({ from: "+14155550109", body: "STOP" }));
  assert.equal(stop.json.optedOut, true);
  const blocked = await post(`${base}/webhooks/call-events`, JSON.stringify(missed("+14155550109")));
  assert.equal(blocked.json.outcome, "skipped_opted_out");

  assert.equal((await post(`${base}/webhooks/call-events`, "{not json")).status, 400);
  assert.equal((await post(`${base}/webhooks/call-events`, JSON.stringify({ type: "call.missed" }))).status, 400);
  assert.equal((await post(`${base}/nope`, "{}")).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("a provider outage answers 502 and the retry succeeds", async () => {
  const { service, config, sms } = setup();
  const base = await listen(createServer(service, config));
  const event = JSON.stringify(missed());
  sms.failNext = 1;
  assert.equal((await post(`${base}/webhooks/call-events`, event)).status, 502);
  const retry = await post(`${base}/webhooks/call-events`, event);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.outcome, "sent");
  assert.equal(sms.sent.length, 1);
});

test("signatures are enforced when a secret is configured", async () => {
  const secret = "test-only-secret";
  const { service, config, sms } = setup(undefined, { webhookSecret: secret });
  const base = await listen(createServer(service, config));
  const event = JSON.stringify(missed());

  assert.equal((await post(`${base}/webhooks/call-events`, event)).status, 401);
  assert.equal((await post(`${base}/webhooks/call-events`, event, { "x-signature": "deadbeef" })).status, 401);
  assert.equal((await post(`${base}/webhooks/call-events`, event, { "x-signature": sign(secret, event + " ") })).status, 401);
  assert.equal(sms.sent.length, 0);
  const ok = await post(`${base}/webhooks/call-events`, event, { "x-signature": sign(secret, event) });
  assert.equal(ok.status, 200);
  assert.equal(sms.sent.length, 1);
});

test("HttpSmsProvider posts JSON with a bearer key and an idempotency key", async () => {
  const seen: { headers: Record<string, unknown>; body: string }[] = [];
  let fail = false;
  const stub = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "remote_1" }));
    });
  });
  const base = await listen(stub);
  const provider = new HttpSmsProvider(`${base}/messages`, "fake-key-for-tests");
  const message = { to: "+12125550101", from: "+12125550100", body: "hello", idempotencyKey: "evt_9" };

  assert.deepEqual(await provider.send(message), { messageId: "remote_1" });
  assert.equal(seen[0]!.headers.authorization, "Bearer fake-key-for-tests");
  assert.equal(seen[0]!.headers["idempotency-key"], "evt_9");
  assert.deepEqual(JSON.parse(seen[0]!.body), { to: "+12125550101", from: "+12125550100", body: "hello" });
  fail = true;
  await assert.rejects(provider.send(message), /503/);
});
