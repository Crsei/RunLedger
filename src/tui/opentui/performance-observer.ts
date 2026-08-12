import type { HighlightFallbackReason } from "../highlight/contracts.ts";

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

export interface MermaidProjectionObservation {
  readonly durationMs: number;
  readonly cacheHit: boolean;
  readonly fallback: boolean;
}

export interface MermaidCacheObservation {
  readonly entries: number;
  readonly bytes: number;
  readonly evictions: number;
  readonly oversized: number;
}

export interface SyntaxHighlightObservation {
  readonly ok: boolean;
  readonly cacheHit: boolean;
  readonly fallbackReason?: HighlightFallbackReason;
  readonly durationMs: number;
  readonly queueWaitMs: number;
  readonly nativeDurationMs: number;
  readonly adapterDurationMs: number;
  readonly inputBytes: number;
  readonly inputLines: number;
  readonly activeJobs: number;
  readonly queuedJobs: number;
  readonly queuedBytes: number;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly cacheSpans: number;
  readonly cacheEvictions: number;
  readonly themeRevision: number;
  readonly engineBuildId: string;
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
  readonly mermaidProjectionCount: number;
  readonly mermaidProjectionTimeMs: number;
  readonly mermaidCacheHits: number;
  readonly mermaidCacheMisses: number;
  readonly mermaidCacheEntries: number;
  readonly mermaidCacheBytes: number;
  readonly mermaidCacheEvictions: number;
  readonly mermaidCacheOversized: number;
  readonly mermaidFallbackCount: number;
  readonly highlightRequests: number;
  readonly highlightOk: number;
  readonly highlightFallbacks: number;
  readonly highlightCacheHits: number;
  readonly highlightCacheMisses: number;
  readonly highlightCacheEvictions: number;
  readonly highlightDurationMs: number;
  readonly highlightQueueWaitMs: number;
  readonly highlightNativeDurationMs: number;
  readonly highlightAdapterDurationMs: number;
  readonly highlightFallbackReasons: Readonly<Record<HighlightFallbackReason, number>>;
  readonly highlightInputBytes: number;
  readonly highlightInputLines: number;
  readonly highlightActiveJobs: number;
  readonly highlightQueuedJobs: number;
  readonly highlightQueuedBytes: number;
  readonly highlightCacheEntries: number;
  readonly highlightCacheBytes: number;
  readonly highlightCacheSpans: number;
  readonly highlightThemeRevision: number;
  readonly highlightEngineBuildId: string;
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

  recordMermaidProjection(observation: MermaidProjectionObservation): void {
    this.counters = {
      ...this.counters,
      mermaidProjectionCount: this.counters.mermaidProjectionCount + 1,
      mermaidProjectionTimeMs: this.counters.mermaidProjectionTimeMs + Math.max(0, observation.durationMs),
      mermaidCacheHits: this.counters.mermaidCacheHits + (observation.cacheHit ? 1 : 0),
      mermaidCacheMisses: this.counters.mermaidCacheMisses + (observation.cacheHit ? 0 : 1),
      mermaidFallbackCount: this.counters.mermaidFallbackCount + (observation.fallback ? 1 : 0),
    };
  }

  recordMermaidCache(observation: MermaidCacheObservation): void {
    this.counters = {
      ...this.counters,
      mermaidCacheEntries: Math.max(0, Math.floor(observation.entries)),
      mermaidCacheBytes: Math.max(0, Math.floor(observation.bytes)),
      mermaidCacheEvictions: Math.max(0, Math.floor(observation.evictions)),
      mermaidCacheOversized: Math.max(0, Math.floor(observation.oversized)),
    };
  }

  recordSyntaxHighlight(observation: SyntaxHighlightObservation): void {
    this.counters = {
      ...this.counters,
      highlightRequests: this.counters.highlightRequests + 1,
      highlightOk: this.counters.highlightOk + (observation.ok ? 1 : 0),
      highlightFallbacks: this.counters.highlightFallbacks + (observation.ok ? 0 : 1),
      highlightCacheHits: this.counters.highlightCacheHits + (observation.cacheHit ? 1 : 0),
      highlightCacheMisses: this.counters.highlightCacheMisses + (observation.cacheHit ? 0 : 1),
      highlightCacheEvictions: Math.max(this.counters.highlightCacheEvictions, observation.cacheEvictions),
      highlightDurationMs: this.counters.highlightDurationMs + Math.max(0, observation.durationMs),
      highlightQueueWaitMs: this.counters.highlightQueueWaitMs + Math.max(0, observation.queueWaitMs),
      highlightNativeDurationMs: this.counters.highlightNativeDurationMs + Math.max(0, observation.nativeDurationMs),
      highlightAdapterDurationMs: this.counters.highlightAdapterDurationMs + Math.max(0, observation.adapterDurationMs),
      highlightFallbackReasons: incrementFallbackReason(this.counters.highlightFallbackReasons, observation.fallbackReason),
      highlightInputBytes: this.counters.highlightInputBytes + Math.max(0, observation.inputBytes),
      highlightInputLines: this.counters.highlightInputLines + Math.max(0, observation.inputLines),
      highlightActiveJobs: Math.max(0, observation.activeJobs),
      highlightQueuedJobs: Math.max(0, observation.queuedJobs),
      highlightQueuedBytes: Math.max(0, observation.queuedBytes),
      highlightCacheEntries: Math.max(0, observation.cacheEntries),
      highlightCacheBytes: Math.max(0, observation.cacheBytes),
      highlightCacheSpans: Math.max(0, observation.cacheSpans),
      highlightThemeRevision: Math.max(0, observation.themeRevision),
      highlightEngineBuildId: observation.engineBuildId,
    };
  }

  recordGenerationDiscard(): void {
    this.counters = {
      ...this.counters,
      generationDiscardCount: this.counters.generationDiscardCount + 1,
    };
  }

  snapshot(): TuiPerformanceSnapshot {
    return { ...this.counters, highlightFallbackReasons: { ...this.counters.highlightFallbackReasons } };
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
    mermaidProjectionCount: 0,
    mermaidProjectionTimeMs: 0,
    mermaidCacheHits: 0,
    mermaidCacheMisses: 0,
    mermaidCacheEntries: 0,
    mermaidCacheBytes: 0,
    mermaidCacheEvictions: 0,
    mermaidCacheOversized: 0,
    mermaidFallbackCount: 0,
    highlightRequests: 0,
    highlightOk: 0,
    highlightFallbacks: 0,
    highlightCacheHits: 0,
    highlightCacheMisses: 0,
    highlightCacheEvictions: 0,
    highlightDurationMs: 0,
    highlightQueueWaitMs: 0,
    highlightNativeDurationMs: 0,
    highlightAdapterDurationMs: 0,
    highlightFallbackReasons: emptyHighlightFallbackReasons(),
    highlightInputBytes: 0,
    highlightInputLines: 0,
    highlightActiveJobs: 0,
    highlightQueuedJobs: 0,
    highlightQueuedBytes: 0,
    highlightCacheEntries: 0,
    highlightCacheBytes: 0,
    highlightCacheSpans: 0,
    highlightThemeRevision: 0,
    highlightEngineBuildId: "native-unavailable",
  };
}

function emptyHighlightFallbackReasons(): Record<HighlightFallbackReason, number> {
  return {
    empty: 0,
    unknown_language: 0,
    oversize_bytes: 0,
    oversize_lines: 0,
    native_unavailable: 0,
    theme_invalid: 0,
    highlight_error: 0,
    timeout: 0,
    queue_pressure: 0,
    stale_generation: 0,
  };
}

function incrementFallbackReason(
  current: Readonly<Record<HighlightFallbackReason, number>>,
  reason: HighlightFallbackReason | undefined,
): Readonly<Record<HighlightFallbackReason, number>> {
  return reason === undefined ? current : { ...current, [reason]: current[reason] + 1 };
}
