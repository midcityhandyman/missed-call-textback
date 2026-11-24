import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Decision, DeferredText } from "./types.ts";

interface Snapshot {
  decisions: Decision[];
  optOuts: string[];
  lastText: [string, number][];
  deferred: DeferredText[];
}

/**
 * In memory state with an optional JSON snapshot on disk.
 * All methods are synchronous, which is what lets the service reserve an event id
 * and a caller before it awaits the SMS provider.
 */
export class MemoryStore {
  private decisions = new Map<string, Decision>();
  private optOuts = new Set<string>();
  private lastText = new Map<string, number>();
  private deferred: DeferredText[] = [];
  private filePath: string;

  constructor(filePath = "") {
    this.filePath = filePath;
    if (filePath && existsSync(filePath)) {
      const snap = JSON.parse(readFileSync(filePath, "utf8")) as Snapshot;
      for (const d of snap.decisions) this.decisions.set(d.eventId, d);
      this.optOuts = new Set(snap.optOuts);
      this.lastText = new Map(snap.lastText);
      this.deferred = snap.deferred;
    }
  }

  getDecision(eventId: string): Decision | undefined {
    return this.decisions.get(eventId);
  }

  saveDecision(decision: Decision): void {
    this.decisions.set(decision.eventId, decision);
    this.persist();
  }

  allDecisions(): Decision[] {
    return [...this.decisions.values()];
  }

  isOptedOut(phone: string): boolean {
    return this.optOuts.has(phone);
  }

  setOptOut(phone: string, optedOut: boolean): void {
    if (optedOut) this.optOuts.add(phone);
    else this.optOuts.delete(phone);
    this.persist();
  }

  /** Epoch ms of the last text to this number, or of a queued one that has not gone out yet. */
  getLastText(phone: string): number | undefined {
    return this.lastText.get(phone);
  }

  setLastText(phone: string, at: number | undefined): void {
    if (at === undefined) this.lastText.delete(phone);
    else this.lastText.set(phone, at);
    this.persist();
  }

  addDeferred(item: DeferredText): void {
    this.deferred.push(item);
    this.persist();
  }

  removeDeferred(eventId: string): void {
    this.deferred = this.deferred.filter((d) => d.eventId !== eventId);
    this.persist();
  }

  dueDeferred(now: number): DeferredText[] {
    return this.deferred.filter((d) => d.sendAt <= now).sort((a, b) => a.sendAt - b.sendAt);
  }

  pendingDeferred(): DeferredText[] {
    return [...this.deferred];
  }

  /** Call after mutating a queued item in place. */
  persist(): void {
    if (!this.filePath) return;
    const snap: Snapshot = {
      decisions: this.allDecisions(),
      optOuts: [...this.optOuts],
      lastText: [...this.lastText],
      deferred: this.deferred,
    };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, this.filePath);
  }
}
