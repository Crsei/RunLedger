/**
 * TUI application boundary 静态检查（B8）。
 *
 * 阻止 InteractiveMode 回归为领域状态 owner：
 *   - 禁止新增领域 mutable state（组件 Map、旧 owner 字段名）；
 *   - 禁止直接 controller 领域调用（prompt/queue 生命周期白名单除外）；
 *   - 禁止直接解析 Host raw response（result.servers / result.descriptors 等）。
 *
 * 运行：npm run check（check:tui-boundaries）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { globSync } from "node:fs";

const root = process.cwd();
const source = readFileSync(join(root, "src/tui/interactive-mode.ts"), "utf8");
const lines = source.split("\n");

const failures: string[] = [];

const COLOR_PROJECTION_ALLOWLIST = new Set([
  "src/tui/highlight/contracts.ts",
  "src/tui/highlight/status-style.ts",
  "src/tui/opentui/diff-renderable.ts",
  "src/tui/opentui/ansi-styled-text.ts",
  "src/tui/opentui/mermaid-block-renderable.ts",
  "src/tui/theme/editor-background.ts",
]);

/** 普通 UI 只用 ANSI semantic palette；RGB foreground 仅限精确 projection boundary。 */
export function findTuiColorBoundaryFailures(relativePath: string, contents: string): string[] {
  if (COLOR_PROJECTION_ALLOWLIST.has(relativePath)) return [];
  const code = contents.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  const found: string[] = [];
  if (/RGBA\.fromInts\s*\(/u.test(code)) found.push(`${relativePath}: custom RGB foreground outside projection allowlist`);
  if (/\b(?:black|white|blue|yellow)\s*\(/u.test(code) || /RGBA\.fromIndex\s*\(\s*(?:0|3|4|7)\s*\)/u.test(code)) {
    found.push(`${relativePath}: forbidden ANSI foreground (black/white/blue/yellow)`);
  }
  return found;
}

for (const absolutePath of globSync(join(root, "src/tui/**/*.ts"))) {
  const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
  failures.push(...findTuiColorBoundaryFailures(relativePath, readFileSync(absolutePath, "utf8")));
}

// 0) S7 已退役路径不得恢复；信息展示只能走 canonical Timeline/projector。
for (const relativePath of [
  "src/tui/components/user-message.ts",
  "src/tui/components/assistant-message.ts",
  "src/tui/components/custom-message.ts",
  "src/tui/components/tool-call.ts",
  "src/tui/components/tool-result.ts",
  "src/tui/components/bash-execution.ts",
  "src/tui/components/diff-preview.ts",
  "src/tui/components/background-task.ts",
  "src/tui/opentui/timeline-store.ts",
  "src/tui/opentui/runtime.ts",
  "src/tui/runtime/repl-handle.ts",
  "src/tui/feature-adapters.ts",
  "src/tui/session-selector.ts",
]) {
  if (existsSync(join(root, relativePath))) failures.push(`retired S7 TUI path restored: ${relativePath}`);
}

// 1) 禁止领域 mutable state owner（旧字段名或组件 Map 模式）
const retiredFieldPattern = /\bprivate\s+(?:readonly\s+)?(?:toolCallComponents|pendingAssistantPartials|modelRegistry|thinkingLevel|state|timeline)\b/u;
if (retiredFieldPattern.test(source)) {
  failures.push("retired field owner pattern found (toolCallComponents/pendingAssistantPartials/modelRegistry/thinkingLevel/state/timeline)");
}
if (/private\s+(?:readonly\s+)?\w+\s*:\s*Map</u.test(source)) {
  failures.push("component/business Map field declared in InteractiveMode");
}

// 2) 直接 controller 调用白名单（生命周期/队列/通道仍属 InteractiveMode authority）
const allowedControllerCalls = [
  "controller.subscribe",
  "controller.subscribeSessionTitleChanged",
  "controller.subscribeIdleRecap",
  "controller.notifyEditorActivity",
  "controller.prompt",
  "controller.interrupt",
  "controller.clearAllQueues",
  "controller.waitForIdle",
  "controller.dispose",
  "controller.queryHostDomain",
  "controller.commandHostDomain",
  "controller.currentSelection",
  "controller.sessionId",
  "controller.inFlight",
  "controller.messages",
  "controller.warnings",
  "controller.auditEntries",
  "controller.agentRuns",
  "controller.toolCount",
  "controller.ledger",
  "controller.getSteeringMessages",
  "controller.getFollowUpMessages",
];
const forbiddenControllerCall = /\bthis\.controller(?:\?\.|\.)(\w+)/gu;
for (const match of source.matchAll(forbiddenControllerCall)) {
  const method = match[1]!;
  if (!allowedControllerCalls.some((allowed) => allowed.endsWith(`.${method}`))) {
    failures.push(`direct controller call this.controller.${method} is not in the B8 whitelist`);
  }
}
const forbiddenAgentCall = /\bthis\.agent(?:\?\.|\.)(setModel|setThinkingLevel|prompt)/gu;
for (const match of source.matchAll(forbiddenAgentCall)) {
  failures.push(`direct agent call this.agent.${match[1]} bypasses the workflow`);
}

// 3) 禁止 raw Host response 解析
for (const fragment of ["result.servers", "result.descriptors", "server.serverId", "descriptor.identity"]) {
  if (source.includes(fragment)) failures.push(`raw Host response parsing fragment: ${fragment}`);
}

if (failures.length > 0) {
  process.stderr.write(`[check:tui-boundaries] ${failures.length} failure(s):\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write("tui application boundary check passed\n");
void lines;
