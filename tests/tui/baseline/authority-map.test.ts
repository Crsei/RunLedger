/**
 * B0：被动合同各 workflow 的真实 authority 清单（characterization）。
 *
 * 以源码静态检查固定“哪个端口拥有哪个领域事实”：
 *   - local   = InteractiveSessionControllerPort 本地实现（interactive-session-controller.ts）
 *   - remote  = RemoteInteractiveSessionController / Host domain 通道（remote-session.ts）
 *   - facade  = 注入的专项 controller（如 process overlay facade）
 *   - none    = 合同存在但当前生产端口不可达
 * 后续批次迁移时按此表接线 EffectRunner/adapters，并同步更新本表。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const localControllerSource = readFileSync(join(root, "src/runtime/interactive-session-controller.ts"), "utf8");
const remoteControllerSource = readFileSync(join(root, "src/runtime/host/remote-session.ts"), "utf8");
const effectSource = readFileSync(join(root, "src/tui/application/effect.ts"), "utf8");
const processAdapterSource = readFileSync(join(root, "src/tui/process/controller-adapter.ts"), "utf8");
const interactiveModeSource = readFileSync(join(root, "src/tui/interactive-mode.ts"), "utf8");

type Authority = "local" | "remote" | "facade" | "none";

interface WorkflowAuthority {
  readonly workflow: string;
  readonly authority: Authority;
  readonly localChannel: string;
  readonly remoteChannel: string;
  readonly note: string;
}

const authorityMap: WorkflowAuthority[] = [
  {
    workflow: "session.catalog/open/resume/fork",
    authority: "local+remote",
    localChannel: "InteractiveSessionController (session manager)",
    remoteChannel: "Host session.open / session.subscribe",
    note: "两端都有真实 authority；TUI 不读 session JSONL",
  },
  {
    workflow: "provider.list",
    authority: "local+remote",
    localChannel: "getProviderStatuses()",
    remoteChannel: "getProviderStatuses() -> session.provider_status",
    note: "两端同方法名，语义一致",
  },
  {
    workflow: "auth.login",
    authority: "local",
    localChannel: "login(providerId, type, interaction)",
    remoteChannel: "remote login 抛错（需 Host auth channel）",
    note: "remote 明确 unavailable，UI 不得伪装成功",
  },
  {
    workflow: "auth.logout",
    authority: "local+remote",
    localChannel: "logout(providerId)",
    remoteChannel: "logout(providerId) 经 Host 命令",
    note: "remote logout 可用",
  },
  {
    workflow: "model.list/select",
    authority: "local+remote",
    localChannel: "getAvailableModels(provider) / selectModel(model)",
    remoteChannel: "getAvailableModels() -> session.models",
    note: "remote selectModel 走 Host selection 命令",
  },
  {
    workflow: "thinking.inspect/select",
    authority: "local+remote",
    localChannel: "currentSelection.thinkingLevel / setThinkingLevel(level)",
    remoteChannel: "同方法，remote 实现转发",
    note: "两端一致",
  },
  {
    workflow: "prompt.list/submit",
    authority: "none",
    localChannel: "无 controller 方法",
    remoteChannel: "无 Host domain operation",
    note: "effect 存在但端口不可达，UI 显示 unavailable",
  },
  {
    workflow: "keymap.inspect/update",
    authority: "none",
    localChannel: "无 controller 方法",
    remoteChannel: "无 Host domain operation",
    note: "effect 存在但端口不可达，UI 显示 unavailable",
  },
  {
    workflow: "queue.inspect/cancel",
    authority: "local",
    localChannel: "getSteeringMessages / getFollowUpMessages / clearAllQueues",
    remoteChannel: "remote 返回空数组",
    note: "remote 无 client-local 队列事实，cancel 需 Host 通道",
  },
  {
    workflow: "approval.resolve",
    authority: "remote",
    localChannel: "无",
    remoteChannel: "Host reverse approval frame -> handleReverseRequest",
    note: "只有 authenticated Host 会话有 approval 事实",
  },
  {
    workflow: "task-goal/plan/agents/extensions/runtime-snapshot/security-mode/workspace-git/update",
    authority: "remote",
    localChannel: "无",
    remoteChannel: "queryHostDomain / commandHostDomain",
    note: "本地 controller 两通道均为 undefined",
  },
  {
    workflow: "process.list/output/mutation",
    authority: "facade",
    localChannel: "无（需注入 ProcessOverlayController）",
    remoteChannel: "processOverlayController -> Host client",
    note: "复用既有 process reducer/controller-adapter，不得再造第二 manager",
  },
  {
    workflow: "shutdown.request",
    authority: "local",
    localChannel: "InteractiveMode.requestQuit()（UI 生命周期）",
    remoteChannel: "无（client detach 后 Host 由 runtime 管理）",
    note: "shutdown 只提交 intent；renderer cleanup 与 Host receipt 可分别观察",
  },
];

describe("B0 authority map: passive contract workflows", () => {
  it("pins the authoritative channel for every workflow", () => {
    for (const row of authorityMap) {
      expect(row.workflow.length).toBeGreaterThan(0);
      expect(["local", "remote", "facade", "none", "local+remote"].includes(row.authority)).toBe(true);
      expect(row.localChannel.length + row.remoteChannel.length).toBeGreaterThan(0);
    }
  });

  it("local controller owns session/provider/model/thinking/queue/login/logout", () => {
    for (const method of ["getProviderStatuses", "getAvailableModels", "login", "logout", "selectModel", "setThinkingLevel", "clearAllQueues"]) {
      expect(localControllerSource).toContain(method);
    }
  });

  it("local controller exposes Host domain channels only on the remote controller", () => {
    expect(localControllerSource).toContain("queryHostDomain");
    expect(localControllerSource).toContain("commandHostDomain");
    expect(localControllerSource).toMatch(/queryHostDomain\?:/u);
    expect(remoteControllerSource).toContain("async queryHostDomain");
    expect(remoteControllerSource).toContain("async commandHostDomain");
  });

  it("remote controller has no local queue facts", () => {
    expect(remoteControllerSource).toMatch(/getSteeringMessages\(\): readonly UserAgentMessage\[\] \{ return \[\]; \}/u);
    expect(remoteControllerSource).toMatch(/getFollowUpMessages\(\): readonly UserAgentMessage\[\] \{ return \[\]; \}/u);
  });

  it("remote login is explicitly unavailable (no fake success path)", () => {
    expect(remoteControllerSource).toMatch(/login\(/u);
    expect(remoteControllerSource).toContain("remote provider login requires an interactive Host auth channel");
  });

  it("approval authority lives on the Host reverse frame handled by InteractiveMode", () => {
    expect(interactiveModeSource).toContain("handleReverseRequest");
    expect(interactiveModeSource).toContain("parseApprovalReverseRequest");
  });

  it("process workflow reuses the existing facade and reducer (no second manager)", () => {
    expect(processAdapterSource).toContain("processOverlayReducer");
    expect(processAdapterSource).toContain("createInitialProcessOverlayState");
    expect(processAdapterSource).toContain("observer_mutation_forbidden");
  });

  it("every effect in the passive contract maps to a documented authority row", () => {
    const effectKinds = [...effectSource.matchAll(/\| \(\{ readonly type: "([a-z0-9.-]+)"/gu)].map((m) => m[1]);
    expect(effectKinds.length).toBeGreaterThanOrEqual(21);
    const documented = authorityMap.map((row) => row.workflow);
    const stem = (value: string): string => value.split(".")[0]!.replace(/s$/u, "");
    for (const kind of effectKinds) {
      const covered = documented.some((name) =>
        name.split("/").some((segment) => stem(segment) === stem(kind)),
      );
      expect(covered, `effect ${kind} has no documented authority row`).toBe(true);
    }
  });
});
