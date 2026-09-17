import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  WEB_BOUNDS, WebEventSchema, WebPageRequestSchema, WebSessionSchema,
  WebSnapshotSchema, WebTimelineRowSchema, WebUsageSchema, WebTrajectoryDetailSchema,
} from "../src/contracts/index.ts";
import type { WebSession, WebSnapshot, WebUsage } from "../src/contracts/index.ts";

const session: WebSession = {
  id: "session-1", projectId: "project-1", repositoryId: null, title: null,
  status: "active", createdAtMs: 1, updatedAtMs: 2, headSequence: 10,
};
const watermark = { sessionId: session.id, sequence: 10, ownerGeneration: null, source: "history" as const, epoch: "epoch-1" };
const snapshot: WebSnapshot = {
  version: 1, session,
  connection: { state: "offline", freshness: "stale", checkedAtMs: 3 },
  timeline: { version: 1, before: null, after: null, asOfMs: 3, watermark, items: [] },
  resumeCursor: "opaque_cursor",
};

describe("Web browser contracts", () => {
  it("retains durable active status while owner is offline", () => {
    expect(Value.Check(WebSnapshotSchema, snapshot)).toBe(true);
    expect(Value.Check(WebSnapshotSchema, { ...snapshot, session: { ...session, status: "offline" } })).toBe(false);
  });

  it.each(["sourceWorkspaceLocator", "worktreeLocator", "authToken", "port", "settingsDigest"])("rejects private catalog field %s", (field) => {
    expect(Value.Check(WebSessionSchema, { ...session, [field]: "private" })).toBe(false);
    expect(Value.Check(WebSnapshotSchema, { ...snapshot, session: { ...session, [field]: "private" } })).toBe(false);
  });

  it("rejects raw event/tool objects and unbounded text", () => {
    const row = { id: "row-1", sequence: 1, createdAtMs: 1, kind: "tool", text: "safe text", truncated: false };
    expect(Value.Check(WebTimelineRowSchema, row)).toBe(true);
    expect(Value.Check(WebTimelineRowSchema, { ...row, payload: { token: "private" } })).toBe(false);
    expect(Value.Check(WebTimelineRowSchema, { ...row, text: "x".repeat(WEB_BOUNDS.textCharacters + 1) })).toBe(false);
  });

  it("requires bounded integer pagination and opaque cursors", () => {
    expect(Value.Check(WebPageRequestSchema, { pageSize: 50 })).toBe(true);
    for (const pageSize of [0, -1, 1.5, 201, Infinity]) {
      expect(Value.Check(WebPageRequestSchema, { pageSize })).toBe(false);
    }
    for (const cursor of ["", "../../state.db", "x".repeat(WEB_BOUNDS.cursorCharacters + 1)]) {
      expect(Value.Check(WebPageRequestSchema, { cursor })).toBe(false);
    }
    expect(Value.Check(WebPageRequestSchema, { command: "abort" })).toBe(false);
  });

  it("keeps invalidation separate from durable sequence and resume cursor", () => {
    const invalidation = { version: 1, kind: "invalidate", sessionId: session.id, target: "trajectory" };
    expect(Value.Check(WebEventSchema, invalidation)).toBe(true);
    expect(Value.Check(WebEventSchema, { ...invalidation, sequence: 11 })).toBe(false);
    expect(Value.Check(WebEventSchema, { ...invalidation, resumeCursor: "wrong_cursor" })).toBe(false);
    expect(Value.Check(WebEventSchema, { version: 1, kind: "durable", watermark, resumeCursor: "cursor" })).toBe(true);
  });

  it("preserves missing cost separately from known and estimated cost", () => {
    const quantity = { exact: null, estimated: null, missingCalls: 1 };
    const usage: WebUsage = {
      version: 1, projectId: "project-1", asOfMs: 3, timeFrom: 0, timeTo: 3,
      coverage: "partial", uniqueCalls: 1, excludedUnidentifiedObservations: 1, sources: ["provider"],
      inputTokens: quantity, outputTokens: quantity, cacheReadTokens: quantity, cacheWriteTokens: quantity, costUsd: quantity,
    };
    expect(Value.Check(WebUsageSchema, usage)).toBe(true);
    expect(Value.Check(WebUsageSchema, { ...usage, costUsd: 0 })).toBe(false);
    expect(Value.Check(WebUsageSchema, { ...usage, costUsd: { ...quantity, exact: -1 } })).toBe(false);
  });

  it.each(["not-recorded", "unavailable", "corrupt"])("represents detail state %s without artifact paths", (availability) => {
    const detail = { version: 1, sessionId: session.id, recordId: "record-1", field: "output", text: "", availability, next: null };
    expect(Value.Check(WebTrajectoryDetailSchema, detail)).toBe(true);
    expect(Value.Check(WebTrajectoryDetailSchema, { ...detail, artifactPath: "/tmp/other-session" })).toBe(false);
  });
});
