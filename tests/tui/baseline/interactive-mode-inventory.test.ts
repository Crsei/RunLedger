/**
 * InteractiveMode 当前 mutable 状态 / 直接 controller 调用 /
 * Host raw response 解析 / 组件 mutation 清单（characterization）。
 *
 * 这些清单是本计划要分批迁移并删除的旧 owner。每批迁移时：
 *   1. 先把对应断言改成 RED（新状态先独立跑通）；
 *   2. 生产切换后删除本文件中对应旧清单断言；
 * 同一提交内不得同时保留旧字段与新 reducer 双写。
 *
 * S7 已迁移（2026-08-29）：streaming/stopReason/streamingGeneration/
 * streamingDeltas/pendingMessageBuffers 移入 `interactive/streaming-controller.ts`；
 * compactDomainResult 移入 `interactive/plan-workflow.ts`；Footer registry/reducer
 * 接管参数状态后，旧 refs.status.* mutation 已退休。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = readFileSync(join(root, "src/tui/interactive-mode.ts"), "utf8");
const interactiveDir = (name: string): string => readFileSync(join(root, `src/tui/interactive/${name}.ts`), "utf8");

/** S7 后仍由 InteractiveMode facade 持有的本地交互/生命周期字段。 */
const mutableFields = [
  "quitting",
  "processOverlayComponent",
  "consecutiveInitFailures",
];

/** S7 已迁移到 interactive/streaming-controller.ts 的流式字段。 */
const streamFields = [
  "streaming",
  "stopReason",
  "streamingGeneration",
  "streamingDeltas",
  "pendingMessageBuffers",
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

/** S7 后 facade 与 interactive/ 模块的组件 mutation 站点。 */
const componentMutationSites = [
  "refs.chat.setTimelineBlocks",
  "refs.editor.setText",
  "refs.editor.getText",
];

/** S7 迁移后又由 Footer registry/reducer 退休的组件 mutation。 */
const retiredMigratedMutationSites: ReadonlyArray<{ readonly file: string; readonly site: string }> = [
  { file: "streaming-controller", site: "refs.status.setStopReason" },
  { file: "event-controller", site: "refs.status.setTurn" },
  { file: "event-controller", site: "refs.status.setQueueCounts" },
];

describe("B0 InteractiveMode inventory characterization", () => {
  it("pins the mutable fields that later batches must migrate", () => {
    for (const field of mutableFields) {
      expect(source, `mutable field ${field}`).toContain(field);
    }
  });

  it("pins the streaming fields S7 moved into the streaming controller", () => {
    const streamSource = interactiveDir("streaming-controller");
    for (const field of streamFields) {
      expect(streamSource, `stream field ${field}`).toContain(field);
    }
    // facade 不再直接声明流式状态字段(streaming 控制器实例字段除外)
    for (const field of ["stopReason", "streamingGeneration", "streamingDeltas", "pendingMessageBuffers"]) {
      expect(source, `facade must not own ${field}`).not.toMatch(new RegExp(`private\\s+(?:readonly\\s+)?${field}\\b`, "u"));
    }
    expect(source).toMatch(/private\s+readonly\s+streaming:\s+StreamingController;/u);
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
    const planSource = interactiveDir("plan-workflow");
    for (const fragment of hostRawResponseParsing) {
      expect(planSource, `raw Host parsing ${fragment}`).toContain(fragment);
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
    for (const { file, site } of retiredMigratedMutationSites) {
      expect(interactiveDir(file), `retired component mutation ${site} in ${file}`).not.toContain(site);
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
