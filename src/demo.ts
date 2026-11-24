import { formatReport, replayDay } from "./simulator.ts";

const seedArg = process.argv.find((a) => a.startsWith("--seed="));
const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
if (!Number.isFinite(seed)) {
  console.error("usage: npm run demo -- --seed=42");
  process.exit(2);
}

const result = await replayDay(seed);
console.log(formatReport(result, seed));
if (result.checks.some((c) => !c.ok)) process.exit(1);
