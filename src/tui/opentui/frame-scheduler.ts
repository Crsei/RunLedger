export interface FrameClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void;
}

export type FrameReason = "window" | "force" | "terminal" | "input" | "scheduled";

export interface FrameSchedulerOptions {
  readonly clock?: FrameClock;
  readonly frameWindowMs?: number;
  readonly backlogLimits?: FrameBacklogLimits;
  readonly onFrame: (reason: FrameReason, scheduledAt: number) => void;
}

export interface FrameBacklogSnapshot {
  readonly queuedEvents: number;
  readonly queuedBytes: number;
  readonly oldestAgeMs: number;
}

export interface FrameBacklogLimits {
  readonly maxQueuedEvents?: number;
  readonly maxQueuedBytes?: number;
  readonly maxOldestAgeMs?: number;
}

function systemClock(): FrameClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
}

/**
 * 应用层帧窗口：事件 handler 只标记 dirty，projection owner 才在窗口内触发一次
 * frame。terminal/input 等高优先级路径可以取消等待并立即 flush。
 */
export class FrameScheduler {
  private readonly clock: FrameClock;
  private readonly frameWindowMs: number;
  private readonly backlogLimits: Required<FrameBacklogLimits>;
  private readonly onFrame: FrameSchedulerOptions["onFrame"];
  private timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private scheduledTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private scheduledAt = 0;
  private scheduledFrameAt = 0;
  private dirty = false;
  private destroyed = false;

  constructor(options: FrameSchedulerOptions) {
    this.clock = options.clock ?? systemClock();
    this.frameWindowMs = Math.max(0, options.frameWindowMs ?? 16);
    this.backlogLimits = {
      maxQueuedEvents: normalizeLimit(options.backlogLimits?.maxQueuedEvents),
      maxQueuedBytes: normalizeLimit(options.backlogLimits?.maxQueuedBytes),
      maxOldestAgeMs: normalizeLimit(options.backlogLimits?.maxOldestAgeMs),
    };
    this.onFrame = options.onFrame;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get hasScheduledFrame(): boolean {
    return this.timer !== undefined || this.scheduledTimer !== undefined;
  }

  markDirty(backlog?: FrameBacklogSnapshot): void {
    if (this.destroyed) return;
    this.dirty = true;
    if (backlog && this.exceedsBacklogLimit(backlog)) {
      this.flush("force");
      return;
    }
    if (this.timer !== undefined) return;
    this.scheduledAt = this.clock.now();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty || this.destroyed) return;
      this.dirty = false;
      this.onFrame("window", this.scheduledAt);
    }, this.frameWindowMs);
  }

  /** 在共享帧调度器中安排一次时间驱动帧，不创建调用方私有 ticker。 */
  scheduleFrameIn(delayMs: number): void {
    if (this.destroyed) return;
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    const nextFrameAt = this.clock.now() + delay;
    if (this.scheduledTimer !== undefined && this.scheduledFrameAt <= nextFrameAt) return;
    this.cancelScheduledTimer();
    this.scheduledFrameAt = nextFrameAt;
    this.scheduledTimer = this.clock.setTimeout(() => {
      this.scheduledTimer = undefined;
      if (this.destroyed) return;
      this.cancelTimer();
      this.dirty = false;
      this.onFrame("scheduled", this.scheduledFrameAt);
    }, delay);
  }

  flush(reason: Exclude<FrameReason, "window"> = "force"): void {
    if (this.destroyed || !this.dirty) return;
    this.cancelTimer();
    this.dirty = false;
    this.onFrame(reason, this.scheduledAt);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelTimer();
    this.cancelScheduledTimer();
    this.dirty = false;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private cancelScheduledTimer(): void {
    if (this.scheduledTimer === undefined) return;
    this.clock.clearTimeout(this.scheduledTimer);
    this.scheduledTimer = undefined;
  }

  private exceedsBacklogLimit(backlog: FrameBacklogSnapshot): boolean {
    return backlog.queuedEvents >= this.backlogLimits.maxQueuedEvents
      || backlog.queuedBytes >= this.backlogLimits.maxQueuedBytes
      || backlog.oldestAgeMs >= this.backlogLimits.maxOldestAgeMs;
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(1, value);
}
