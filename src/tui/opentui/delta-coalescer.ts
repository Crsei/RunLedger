/** Streaming 队列的最小 patch envelope；canonical Timeline state 由 timeline/reducer.ts 持有。 */
export interface TimelinePatch {
  readonly entryId: string;
  readonly partId?: string;
  readonly kind: "append-text" | "replace-status" | "complete" | "insert" | "remove";
  readonly text?: string;
  readonly status?: string;
  readonly role?: "user" | "assistant" | "tool" | "status";
  readonly partKind?: "text" | "markdown" | "thinking" | "tool";
  readonly generation: number;
}

export interface AppendTextDelta {
  readonly kind: "append-text";
  readonly entryId: string;
  readonly partId: string;
  readonly generation: number;
  readonly text: string;
  readonly channel?: "text" | "thinking" | "tool";
  readonly receivedAt?: number;
}

export interface ReplaceStatusDelta {
  readonly kind: "replace-status";
  readonly key: string;
  readonly entryId: string;
  readonly partId?: string;
  readonly generation: number;
  readonly status: string;
  readonly receivedAt?: number;
}

export interface TerminalDelta {
  readonly kind: "terminal";
  readonly patch: TimelinePatch;
  readonly receivedAt?: number;
}

export type StreamingDelta = AppendTextDelta | ReplaceStatusDelta | TerminalDelta;
export type CoalescedDelta = StreamingDelta;

interface PendingAppendTextDelta {
  kind: "append-text";
  entryId: string;
  partId: string;
  generation: number;
  text: string;
  channel?: "text" | "thinking" | "tool";
  receivedAt?: number;
}

interface PendingReplaceStatusDelta {
  kind: "replace-status";
  key: string;
  entryId: string;
  partId?: string;
  generation: number;
  status: string;
  receivedAt?: number;
}

type PendingDelta = PendingAppendTextDelta | PendingReplaceStatusDelta | TerminalDelta;

export interface DeltaCoalescerStats {
  readonly acceptedEvents: number;
  readonly mergedTextEvents: number;
  readonly supersededStatusEvents: number;
  readonly drainedEvents: number;
  readonly pressureEvents: number;
  readonly maxQueuedEvents: number;
  readonly maxQueuedBytes: number;
}

export type DeltaPressureLevel = "normal" | "soft" | "hard";

export interface DeltaPressureSnapshot {
  readonly level: DeltaPressureLevel;
  readonly queuedEvents: number;
  readonly queuedBytes: number;
  readonly oldestAgeMs: number;
}

export interface DeltaCoalescerOptions {
  readonly softEventLimit?: number;
  readonly hardEventLimit?: number;
  readonly softByteLimit?: number;
  readonly hardByteLimit?: number;
  readonly now?: () => number;
  onPressure?(snapshot: DeltaPressureSnapshot): void;
}

function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function deltaBytes(delta: StreamingDelta): number {
  if (delta.kind === "append-text") return textBytes(delta.text);
  if (delta.kind === "replace-status") return textBytes(delta.status);
  return 0;
}

/**
 * 只合并可证明等价的相邻正文 delta；状态类事件按 key latest-wins。
 * assistant/thinking/tool 正文永远不会因为队列压力被静默丢弃。
 */
export class DeltaCoalescer {
  private readonly pending: PendingDelta[] = [];
  private readonly softEventLimit: number;
  private readonly hardEventLimit: number;
  private readonly softByteLimit: number;
  private readonly hardByteLimit: number;
  private readonly now: () => number;
  private readonly onPressure?: DeltaCoalescerOptions["onPressure"];
  private bytes = 0;
  private acceptedEvents = 0;
  private mergedTextEvents = 0;
  private supersededStatusEvents = 0;
  private drainedEvents = 0;
  private pressureEvents = 0;
  private maximumQueuedEvents = 0;
  private maximumQueuedBytes = 0;
  private lastPressureLevel: DeltaPressureLevel = "normal";

  constructor(options: DeltaCoalescerOptions = {}) {
    const requestedHardEventLimit = normalizeLimit(options.hardEventLimit);
    const requestedHardByteLimit = normalizeLimit(options.hardByteLimit);
    this.hardEventLimit = requestedHardEventLimit;
    this.hardByteLimit = requestedHardByteLimit;
    this.softEventLimit = Math.min(normalizeLimit(options.softEventLimit), requestedHardEventLimit);
    this.softByteLimit = Math.min(normalizeLimit(options.softByteLimit), requestedHardByteLimit);
    this.now = options.now ?? (() => Date.now());
    this.onPressure = options.onPressure;
  }

  get size(): number {
    return this.pending.length;
  }

  get queuedBytes(): number {
    return this.bytes;
  }

  get pressure(): DeltaPressureSnapshot {
    return this.pressureSnapshot();
  }

  get stats(): DeltaCoalescerStats {
    return {
      acceptedEvents: this.acceptedEvents,
      mergedTextEvents: this.mergedTextEvents,
      supersededStatusEvents: this.supersededStatusEvents,
      drainedEvents: this.drainedEvents,
      pressureEvents: this.pressureEvents,
      maxQueuedEvents: this.maximumQueuedEvents,
      maxQueuedBytes: this.maximumQueuedBytes,
    };
  }

  push(delta: StreamingDelta): void {
    this.acceptedEvents += 1;
    if (delta.kind === "append-text") {
      const last = this.pending.at(-1);
      if (last?.kind === "append-text" && this.sameTextKey(last, delta)) {
        last.text += delta.text;
        last.receivedAt = minReceivedAt(last.receivedAt, delta.receivedAt);
        this.bytes += textBytes(delta.text);
        this.mergedTextEvents += 1;
        this.updatePressure();
        return;
      }
    }
    if (delta.kind === "replace-status") {
      const index = this.findStatus(delta.key, delta.generation);
      if (index >= 0) {
        const previous = this.pending[index];
        if (previous.kind !== "replace-status") return;
        this.bytes -= deltaBytes(previous);
        previous.status = delta.status;
        previous.receivedAt = delta.receivedAt ?? previous.receivedAt;
        this.bytes += deltaBytes(previous);
        this.supersededStatusEvents += 1;
        this.updatePressure();
        return;
      }
    }
    this.pending.push(delta.kind === "append-text"
      ? { ...delta }
      : delta.kind === "replace-status"
      ? { ...delta }
      : delta);
    this.bytes += deltaBytes(delta);
    this.maximumQueuedEvents = Math.max(this.maximumQueuedEvents, this.pending.length);
    this.maximumQueuedBytes = Math.max(this.maximumQueuedBytes, this.bytes);
    this.updatePressure();
  }

  drain(maxEvents = Number.POSITIVE_INFINITY): CoalescedDelta[] {
    if (maxEvents <= 0 || this.pending.length === 0) return [];
    const count = Math.min(this.pending.length, Math.floor(maxEvents));
    const drained = this.pending.splice(0, count);
    for (const delta of drained) this.bytes -= deltaBytes(delta);
    this.drainedEvents += drained.length;
    this.updatePressure();
    return drained;
  }

  drainAsPatches(maxEvents = Number.POSITIVE_INFINITY): TimelinePatch[] {
    return this.drain(maxEvents).flatMap((delta) => {
      if (delta.kind === "terminal") return [delta.patch];
      if (delta.kind === "append-text") {
        return [{
          kind: "append-text",
          entryId: delta.entryId,
          partId: delta.partId,
          text: delta.text,
          generation: delta.generation,
        }];
      }
      return [{
        kind: "replace-status",
        entryId: delta.entryId,
        ...(delta.partId ? { partId: delta.partId } : {}),
        status: delta.status,
        generation: delta.generation,
      }];
    });
  }

  clear(): void {
    this.pending.length = 0;
    this.bytes = 0;
    this.updatePressure();
  }

  private findStatus(key: string, generation: number): number {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const delta = this.pending[index];
      if (delta?.kind === "replace-status" && delta.key === key && delta.generation === generation) return index;
    }
    return -1;
  }

  private sameTextKey(left: AppendTextDelta, right: AppendTextDelta): boolean {
    return left.entryId === right.entryId
      && left.partId === right.partId
      && left.generation === right.generation
      && left.channel === right.channel;
  }

  private pressureSnapshot(): DeltaPressureSnapshot {
    const oldestReceivedAt = this.pending.reduce<number | undefined>((oldest, delta) => {
      if (delta.receivedAt === undefined) return oldest;
      return oldest === undefined ? delta.receivedAt : Math.min(oldest, delta.receivedAt);
    }, undefined);
    const oldestAgeMs = oldestReceivedAt === undefined
      ? 0
      : Math.max(0, this.now() - oldestReceivedAt);
    const hard = this.pending.length >= this.hardEventLimit || this.bytes >= this.hardByteLimit;
    const soft = this.pending.length >= this.softEventLimit || this.bytes >= this.softByteLimit;
    return {
      level: hard ? "hard" : soft ? "soft" : "normal",
      queuedEvents: this.pending.length,
      queuedBytes: this.bytes,
      oldestAgeMs,
    };
  }

  private updatePressure(): void {
    const snapshot = this.pressureSnapshot();
    if (snapshot.level !== this.lastPressureLevel) {
      this.lastPressureLevel = snapshot.level;
      this.pressureEvents += 1;
      this.onPressure?.(snapshot);
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(value));
}

function minReceivedAt(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}
