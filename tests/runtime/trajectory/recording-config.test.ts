import { describe, expect, it } from "vitest";
import { resolveRecordingConfig } from "../../../src/storage/settings-manager.ts";

describe("trajectory recording authority", () => {
  it("defaults only absent fields and preserves explicit off", () => {
    expect(resolveRecordingConfig({})).toEqual({ mode: "events", failurePolicy: "best_effort" });
    expect(resolveRecordingConfig({ recording: { mode: "off" } })).toEqual({ mode: "off", failurePolicy: "best_effort" });
    expect(resolveRecordingConfig({ recording: { failurePolicy: "fail_closed" } })).toEqual({ mode: "events", failurePolicy: "fail_closed" });
  });
  it.each([null, [], "off", { mode: "typo" }, { mode: "off", failurePolicy: "typo" }, { mode: "events", unknown: true }])("disables malformed input instead of activating recording: %j", (recording) => {
    expect(resolveRecordingConfig({ recording }).mode).toBe("off");
  });
});
