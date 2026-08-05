export interface QueuedDeltaObservation {
  readonly events: number;
  readonly bytes: number;
}

export interface CoalescedObservation {
  readonly textEvents?: number;
  readonly supersededStatusEvents?: number;
}

export type QueuePressureLevel = "normal" | "soft" | "hard";

export interface QueueDepthObservation {
  readonly events: number;
  readonly bytes: number;
  readonly oldestAgeMs: number;
  readonly pressureLevel: QueuePressureLevel;
}

export interface ProjectionObservation {
  readonly durationMs: number;
  readonly processedChars: number;
  readonly dirtyEntries: number;
}

export interface NativeFrameObservation {
  readonly durationMs: number;
  readonly cellsUpdated: number;
}

export interface TuiPerformanceSnapshot {
  readonly queuedEvents: number;
  readonly queuedBytes: number;
  readonly currentQueuedEvents: number;
  readonly currentQueuedBytes: number;
  readonly oldestQueueAgeMs: number;
  readonly peakQueuedEvents: number;
  readonly peakQueuedBytes: number;
  readonly pressureLevel: QueuePressureLevel;
  readonly pressureEvents: number;
  readonly coalescedTextEvents: number;
  readonly supersededStatusEvents: number;
  readonly projectionCount: number;
  readonly projectionChars: number;
  readonly projectionTimeMs: number;
  readonly dirtyEntryCount: number;
  readonly nativeFrameCount: number;
  readonly nativeFrameTimeMs: number;
  readonly nativeCellsUpdated: number;
  readonly generationDiscardCount: number;
}

/**
 * S0 分层测量 seam。计数器不参与渲染决策，避免 telemetry 自己改变调度行为。
 * queued/projection/frame 使用累计值，测试与 before/after 报告可复现。
 */
export class TuiPerformanceObserver {
  private counters: TuiPerformanceSnapshot = emptySnapshot();

  recordQueued(observation: QueuedDeltaObservation): void {
    this.counters = {
      ...this.counters,
      queuedEvents: this.counters.queuedEvents + Math.max(0, observation.events),
      queuedBytes: this.counters.queuedBytes + Math.max(0, observation.bytes),
    };
  }

  recordQueueDepth(observation: QueueDepthObservation): void {
    const events = Math.max(0, observation.events);
    const bytes = Math.max(0, observation.bytes);
    const oldestAgeMs = Math.max(0, observation.oldestAgeMs);
    const pressureEvents = this.counters.pressureLevel === observation.pressureLevel
      ? this.counters.pressureEvents
      : this.counters.pressureEvents + 1;
    this.counters = {
      ...this.counters,
      currentQueuedEvents: events,
      currentQueuedBytes: bytes,
      oldestQueueAgeMs: oldestAgeMs,
      peakQueuedEvents: Math.max(this.counters.peakQueuedEvents, events),
      peakQueuedBytes: Math.max(this.counters.peakQueuedBytes, bytes),
      pressureLevel: observation.pressureLevel,
      pressureEvents,
    };
  }

  recordCoalesced(observation: CoalescedObservation): void {
    this.counters = {
      ...this.counters,
      coalescedTextEvents: this.counters.coalescedTextEvents + Math.max(0, observation.textEvents ?? 0),
      supersededStatusEvents: this.counters.supersededStatusEvents + Math.max(0, observation.supersededStatusEvents ?? 0),
    };
  }

  recordProjection(observation: ProjectionObservation): void {
    this.counters = {
      ...this.counters,
      projectionCount: this.counters.projectionCount + 1,
      projectionChars: this.counters.projectionChars + Math.max(0, observation.processedChars),
      projectionTimeMs: this.counters.projectionTimeMs + Math.max(0, observation.durationMs),
      dirtyEntryCount: this.counters.dirtyEntryCount + Math.max(0, observation.dirtyEntries),
    };
  }

  recordNativeFrame(observation: NativeFrameObservation): void {
    this.counters = {
      ...this.counters,
      nativeFrameCount: this.counters.nativeFrameCount + 1,
      nativeFrameTimeMs: this.counters.nativeFrameTimeMs + Math.max(0, observation.durationMs),
      nativeCellsUpdated: this.counters.nativeCellsUpdated + Math.max(0, observation.cellsUpdated),
    };
  }

  recordGenerationDiscard(): void {
    this.counters = {
      ...this.counters,
      generationDiscardCount: this.counters.generationDiscardCount + 1,
    };
  }

  snapshot(): TuiPerformanceSnapshot {
    return { ...this.counters };
  }

  reset(): void {
    this.counters = emptySnapshot();
  }
}

function emptySnapshot(): TuiPerformanceSnapshot {
  return {
    queuedEvents: 0,
    queuedBytes: 0,
    currentQueuedEvents: 0,
    currentQueuedBytes: 0,
    oldestQueueAgeMs: 0,
    peakQueuedEvents: 0,
    peakQueuedBytes: 0,
    pressureLevel: "normal",
    pressureEvents: 0,
    coalescedTextEvents: 0,
    supersededStatusEvents: 0,
    projectionCount: 0,
    projectionChars: 0,
    projectionTimeMs: 0,
    dirtyEntryCount: 0,
    nativeFrameCount: 0,
    nativeFrameTimeMs: 0,
    nativeCellsUpdated: 0,
    generationDiscardCount: 0,
  };
}
