import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { TextbackService } from "./service.ts";
import { HttpSmsProvider, MockSmsProvider } from "./sms.ts";
import { MemoryStore } from "./store.ts";

const config = loadConfig();
const store = new MemoryStore(config.stateFile);
const sms =
  config.smsProvider === "http" ? new HttpSmsProvider(config.smsApiUrl, config.smsApiKey) : new MockSmsProvider();
const service = new TextbackService({ store, sms, config });

// Queued texts go out when the caller's quiet hours end.
const timer = setInterval(() => {
  service.flushDue().then(
    (sent) => sent.forEach((d) => console.log(`flush ${d.eventId} ${d.outcome} ${d.to}`)),
    (err) => console.error("flush failed", err),
  );
}, 30_000);

const server = createServer(service, config);
server.listen(config.port, () => {
  console.log(`missed-call-textback listening on :${config.port} (sms provider: ${config.smsProvider})`);
  if (!config.webhookSecret) console.log("WEBHOOK_SECRET is empty, so webhook signatures are not checked");
});

process.on("SIGINT", () => {
  clearInterval(timer);
  server.close(() => process.exit(0));
});
