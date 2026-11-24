import { isValidTimeZone, parseClock } from "./quietHours.ts";

export interface Config {
  port: number;
  businessName: string;
  businessLine: string;
  defaultTimeZone: string;
  quietStart: string;
  quietEnd: string;
  cooldownHours: number;
  webhookSecret: string;
  stateFile: string;
  smsProvider: "mock" | "http";
  smsApiUrl: string;
  smsApiKey: string;
}

export const DEFAULT_CONFIG: Config = {
  port: 8787,
  businessName: "Example Home Services",
  businessLine: "+12125550100",
  defaultTimeZone: "America/New_York",
  quietStart: "21:00",
  quietEnd: "08:00",
  cooldownHours: 24,
  webhookSecret: "",
  stateFile: "",
  smsProvider: "mock",
  smsApiUrl: "",
  smsApiKey: "",
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const d = DEFAULT_CONFIG;
  const config: Config = {
    port: Number(env.PORT || d.port),
    businessName: env.BUSINESS_NAME || d.businessName,
    businessLine: env.BUSINESS_LINE || d.businessLine,
    defaultTimeZone: env.DEFAULT_TIME_ZONE || d.defaultTimeZone,
    quietStart: env.QUIET_START || d.quietStart,
    quietEnd: env.QUIET_END || d.quietEnd,
    cooldownHours: Number(env.COOLDOWN_HOURS || d.cooldownHours),
    webhookSecret: env.WEBHOOK_SECRET || "",
    stateFile: env.STATE_FILE || "",
    smsProvider: env.SMS_PROVIDER === "http" ? "http" : "mock",
    smsApiUrl: env.SMS_API_URL || "",
    smsApiKey: env.SMS_API_KEY || "",
  };
  if (!Number.isInteger(config.port) || config.port < 0) throw new Error("PORT must be a port number");
  if (!(config.cooldownHours >= 0)) throw new Error("COOLDOWN_HOURS must be zero or more");
  if (!isValidTimeZone(config.defaultTimeZone)) throw new Error("DEFAULT_TIME_ZONE is not an IANA time zone");
  parseClock(config.quietStart);
  parseClock(config.quietEnd);
  if (config.smsProvider === "http" && (!config.smsApiUrl || !config.smsApiKey)) {
    throw new Error("SMS_PROVIDER=http needs SMS_API_URL and SMS_API_KEY");
  }
  return config;
}
