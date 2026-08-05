export type TimelineEntryId = string;
export type TimelinePartId = string;
export type TimelineEntryRole = "user" | "assistant" | "tool" | "status";
export type TimelinePartKind = "text" | "markdown" | "thinking" | "tool";

export interface TimelinePartSnapshot {
  readonly id: TimelinePartId;
  readonly kind: TimelinePartKind;
  readonly content: string;
  readonly streaming: boolean;
  readonly generation: number;
  readonly status?: string;
}

export interface TimelineEntrySnapshot {
  readonly id: TimelineEntryId;
  readonly role: TimelineEntryRole;
  readonly generation: number;
  readonly status?: string;
  readonly parts: readonly TimelinePartSnapshot[];
}

export type TimelinePatchKind =
  | "append-text"
  | "replace-status"
  | "complete"
  | "insert"
  | "remove";

export interface TimelinePatch {
  readonly entryId: TimelineEntryId;
  readonly partId?: TimelinePartId;
  readonly kind: TimelinePatchKind;
  readonly text?: string;
  readonly status?: string;
  readonly role?: TimelineEntryRole;
  readonly partKind?: TimelinePartKind;
  readonly generation: number;
}

export interface TimelineProjectionResult {
  readonly changedEntryIds: readonly TimelineEntryId[];
  readonly overlayChanged: false;
  readonly chromeChanged: boolean;
  readonly forceFlush: boolean;
  readonly staleGeneration: boolean;
  readonly ignored?: "missing-entry" | "missing-part" | "invalid-patch";
}

interface TimelinePartState {
  id: TimelinePartId;
  kind: TimelinePartKind;
  content: string;
  streaming: boolean;
  generation: number;
  status?: string;
}
interface TimelineEntryState {
  id: TimelineEntryId;
  role: TimelineEntryRole;
  generation: number;
  status?: string;
  parts: TimelinePartState[];
}

function result(
  changedEntryIds: readonly TimelineEntryId[],
  options: Pick<TimelineProjectionResult, "chromeChanged" | "forceFlush"> &
    Partial<Pick<TimelineProjectionResult, "staleGeneration" | "ignored">>,
): TimelineProjectionResult {
  return {
    changedEntryIds,
    overlayChanged: false,
    chromeChanged: options.chromeChanged,
    forceFlush: options.forceFlush,
    staleGeneration: options.staleGeneration ?? false,
    ...(options.ignored ? { ignored: options.ignored } : {}),
  };
}

function clonePart(part: TimelinePartState): TimelinePartSnapshot {
  return { ...part };
}

function cloneEntry(entry: TimelineEntryState): TimelineEntrySnapshot {
  return {
    id: entry.id,
    role: entry.role,
    generation: entry.generation,
    ...(entry.status === undefined ? {} : { status: entry.status }),
    parts: entry.parts.map(clonePart),
  };
}

/**
 * 不持有 OpenTUI renderable 的 timeline 投影状态。
 *
 * 所有 live/replay 更新都必须带 generation。切换 session 或 retry 时先
 * beginGeneration，再允许新事件写入，避免异步结果回写到新会话。
 */
export class TimelineStore {
  private currentGeneration = 0;
  private readonly order: TimelineEntryId[] = [];
  private readonly entries = new Map<TimelineEntryId, TimelineEntryState>();

  get generation(): number {
    return this.currentGeneration;
  }

  beginGeneration(): number {
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  apply(patch: TimelinePatch): TimelineProjectionResult {
    if (patch.generation !== this.currentGeneration) {
      return result([], {
        chromeChanged: false,
        forceFlush: false,
        staleGeneration: true,
      });
    }

    switch (patch.kind) {
      case "insert":
        return this.insert(patch);
      case "append-text":
        return this.appendText(patch);
      case "replace-status":
        return this.replaceStatus(patch);
      case "complete":
        return this.complete(patch);
      case "remove":
        return this.remove(patch);
    }
  }

  getEntry(entryId: TimelineEntryId): TimelineEntrySnapshot | undefined {
    const entry = this.entries.get(entryId);
    return entry ? cloneEntry(entry) : undefined;
  }

  snapshot(): readonly TimelineEntrySnapshot[] {
    return this.order.flatMap((entryId) => {
      const entry = this.entries.get(entryId);
      return entry ? [cloneEntry(entry)] : [];
    });
  }

  private insert(patch: TimelinePatch): TimelineProjectionResult {
    const existing = this.entries.get(patch.entryId);
    if (existing) {
      if (patch.partId) {
        const part = existing.parts.find((candidate) => candidate.id === patch.partId);
        if (part) return result([], { chromeChanged: false, forceFlush: false });
        existing.parts.push({
          id: patch.partId,
          kind: patch.partKind ?? "text",
          content: patch.text ?? "",
          streaming: true,
          generation: patch.generation,
        });
        return result([patch.entryId], { chromeChanged: false, forceFlush: false });
      }
      return result([], { chromeChanged: false, forceFlush: false });
    }
    if (!patch.role) {
      return result([], {
        chromeChanged: false,
        forceFlush: false,
        ignored: "invalid-patch",
      });
    }

    const entry: TimelineEntryState = {
      id: patch.entryId,
      role: patch.role,
      generation: patch.generation,
      parts: [],
    };
    if (patch.status !== undefined) entry.status = patch.status;
    if (patch.partId) {
      entry.parts.push({
        id: patch.partId,
        kind: patch.partKind ?? "text",
        content: patch.text ?? "",
        streaming: true,
        generation: patch.generation,
      });
    }
    this.entries.set(entry.id, entry);
    this.order.push(entry.id);
    return result([entry.id], { chromeChanged: false, forceFlush: false });
  }

  private appendText(patch: TimelinePatch): TimelineProjectionResult {
    if (!patch.partId || patch.text === undefined) {
      return result([], {
        chromeChanged: false,
        forceFlush: false,
        ignored: "invalid-patch",
      });
    }
    const entry = this.entries.get(patch.entryId);
    if (!entry) {
      return result([], {
        chromeChanged: false,
        forceFlush: false,
        ignored: "missing-entry",
      });
    }
    const part = entry.parts.find((candidate) => candidate.id === patch.partId);
    if (!part) {
      return result([], {
        chromeChanged: false,
        forceFlush: false,
        ignored: "missing-part",
      });
    }
    part.content += patch.text;
    part.streaming = true;
    return result([entry.id], { chromeChanged: false, forceFlush: false });
  }

  private replaceStatus(patch: TimelinePatch): TimelineProjectionResult {
    if (patch.status === undefined) {
      return result([], {
        chromeChanged: false,
        forceFlush: false,
        ignored: "invalid-patch",
      });
    }
    const entry = this.entries.get(patch.entryId);
    if (!entry) {
      return result([], {
        chromeChanged: false,
        forceFlush: false,
        ignored: "missing-entry",
      });
    }
    if (patch.partId) {
      const part = entry.parts.find((candidate) => candidate.id === patch.partId);
      if (!part) {
        return result([], {
          chromeChanged: false,
          forceFlush: false,
          ignored: "missing-part",
        });
      }
      part.status = patch.status;
    } else {
      entry.status = patch.status;
    }
    return result([entry.id], { chromeChanged: true, forceFlush: false });
  }

  private complete(patch: TimelinePatch): TimelineProjectionResult {
    const entry = this.entries.get(patch.entryId);
    if (!entry) {
      return result([], {
        chromeChanged: false,
        forceFlush: true,
        ignored: "missing-entry",
      });
    }
    if (patch.partId) {
      const part = entry.parts.find((candidate) => candidate.id === patch.partId);
      if (!part) {
        return result([], {
          chromeChanged: false,
          forceFlush: true,
          ignored: "missing-part",
        });
      }
      part.streaming = false;
      part.status = patch.status ?? part.status;
    } else {
      entry.status = patch.status ?? "complete";
    }
    return result([entry.id], { chromeChanged: true, forceFlush: true });
  }

  private remove(patch: TimelinePatch): TimelineProjectionResult {
    if (!this.entries.delete(patch.entryId)) {
      return result([], { chromeChanged: false, forceFlush: false });
    }
    const index = this.order.indexOf(patch.entryId);
    if (index >= 0) this.order.splice(index, 1);
    return result([patch.entryId], { chromeChanged: false, forceFlush: false });
  }
}
