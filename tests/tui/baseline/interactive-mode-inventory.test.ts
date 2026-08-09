/**
 * InteractiveMode 当前 mutable 状态 / 直接 controller 调用 /
 * Host raw response 解析 / 组件 mutation 清单（characterization）。
 *
 * 这些清单是本计划要分批迁移并删除的旧 owner。每批迁移时：
 *   1. 先把对应断言改成 RED（新状态先独立跑通）；
 *   2. 生产切换后删除本文件中对应旧清单断言；
 * 同一提交内不得同时保留旧字段与新 reducer 双写。
 *
 * B2 已迁移（2026-08-06）：toolCallComponents / pendingAssistantPartials /
 * chat.push / chat.clear 作为业务 owner 删除；Timeline 取代（见 mutableFields 注释）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = readFileSync(join(root, "src/tui/interactive-mode.ts"), "utf8");

/** B3 前仍由 InteractiveMode 持有的本地交互/流式字段。 */
const mutableFields = [
  "streaming",
  "stopReason",
  "streamingGeneration",
  "streamingDeltas",
  "pendingMessageBuffers",
  "lastIdleCtrlC",
  "quitting",
  "processOverlayComponent",
  "consecutiveInitFailures",
];

/** B2 已迁移到 Timeline 的字段必须不再作为 InteractiveMode mutable 状态存在。 */
const retiredFields = [
  "toolCallComponents",
  "pendingAssistantPartials",
  "modelRegistry",
  "thinkingLevel",
];

/** B5 已迁移到 workflow/adapter 的 direct controller 调用。 */
const retiredDirectControllerCalls = [
  "controller.getProviderStatuses",
  "controller.getAvailableModels",
  "controller.login",
  "controller.logout",
  "controller.selectModel",
  "controller.setThinkingLevel",
];

const directControllerCalls = [
  "clearAllQueues",
  "interrupt",
];

const retiredDomainControllerCalls = ["queryHostDomain", "commandHostDomain", "querySessionDomain", "commandSessionDomain"];

/** B4 已迁移到 typed adapter 的 raw parsing（extension/mcp workflow）；compactDomainResult 属 B6/B7。 */
const hostRawResponseParsing = [
  "compactDomainResult",
];

/** B4 已删除的 raw Host response 解析点。 */
const retiredHostParsing = [
  "result.servers",
  "result.descriptors",
  "server.serverId",
  "descriptor.identity",
];

const componentMutationSites = [
  "refs.chat.setTimelineBlocks",
  "refs.status.setTurn",
  "refs.status.setStopReason",
  "refs.status.setQueueCounts",
  "refs.editor.setText",
  "refs.editor.getText",
];

describe("B0 InteractiveMode inventory characterization", () => {
  it("pins the mutable fields that later batches must migrate", () => {
    for (const field of mutableFields) {
      expect(source, `mutable field ${field}`).toContain(field);
    }
  });

  it("pins the fields B2/B5 already migrated as retired (no state owner remains)", () => {
    expect(source).not.toMatch(/private\s+(?:readonly\s+)?(?:toolCallComponents|pendingAssistantPartials|modelRegistry|thinkingLevel)\b/u);
    expect(source).not.toMatch(/this\.(?:toolCallComponents|pendingAssistantPartials|modelRegistry|thinkingLevel)\b/u);
  });

  it("pins the direct controller calls to be replaced by typed adapters", () => {
    for (const call of directControllerCalls) {
      expect(source, `direct controller call ${call}`).toContain(call);
    }
  });

  it("keeps all domain controller calls behind typed adapters", () => {
	for (const call of retiredDomainControllerCalls) expect(source).not.toContain(`this.controller.${call}`);
  });

  it("pins the direct controller calls B5 moved into the adapter as retired", () => {
    for (const call of retiredDirectControllerCalls) {
      expect(source, `retired controller call ${call} must not exist`).not.toContain(`this.${call}`);
      expect(source, `retired controller call ${call} must not exist`).not.toMatch(new RegExp(`this\\.controller\\??\\.${call.split(".")[1]}`, "u"));
    }
  });

  it("pins the raw Host response parsing to be replaced by typed validators", () => {
    for (const fragment of hostRawResponseParsing) {
      expect(source, `raw Host parsing ${fragment}`).toContain(fragment);
    }
  });

  it("pins the raw Host parsing B4 already moved into typed adapters as retired", () => {
    for (const fragment of retiredHostParsing) {
      expect(source, `retired raw parsing ${fragment} must not exist`).not.toContain(fragment);
    }
  });

  it("pins the component mutation sites to be replaced by timeline/reducer projections", () => {
    for (const site of componentMutationSites) {
      expect(source, `component mutation ${site}`).toContain(site);
    }
  });

  it("keeps renderer/lifecycle authority untouched by the migration", () => {
    expect(source).toContain("requestQuit");
    expect(source).not.toContain("createAppKeyListener");
    expect(source).toContain("setAppIntentHandler");
    expect(source).toContain("addActionListener");
    expect(source).toContain("addThemeModeListener");
    expect(source).toContain("flushStreamingDeltas");
  });

	it("S6 consumes one presentation projector for timeline, status, footer, welcome, and composer", () => {
		expect(source).toContain("projectInteractivePresentation");
		expect(source).not.toContain("timelineToBlocks(next.timeline)");
	});
});
