import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

interface RuntimeSnapshot {
  header: string;
  resources: string;
  transcript: readonly string[];
  status: string;
  footer: string;
  hints: string;
}

interface RuntimeUnderTest {
  mount(snapshot: RuntimeSnapshot): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  destroy(): void;
}

type RuntimeFactory = (options: {
  renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"];
  onSubmit?: (text: string) => void;
}) => RuntimeUnderTest;

describe("OpenTUI runtime", () => {
	test("Host reconnect status preserves the mounted transcript", async () => {
		const tuiModule: object = await import("../../src/tui/index.ts");
		const candidate = Reflect.get(tuiModule, "createOpenTuiRuntime");
		expect(typeof candidate).toBe("function");
		if (typeof candidate !== "function") return;
		const setup = await createTestRenderer({ width: 72, height: 16 });
		try {
			const runtime = (candidate as RuntimeFactory)({ renderer: setup.renderer });
			runtime.mount({ header: "RunLedger", resources: "", transcript: ["user: retained", "assistant: retained"], status: "Host reconnecting", footer: "model", hints: "" });
			await setup.renderOnce();
			const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
			expect(setup.captureCharFrame()).toContain("Host reconnecting");
			runtime.mount({ header: "RunLedger", resources: "", transcript: ["user: retained", "assistant: retained"], status: "Host reconnected", footer: "model", hints: "" });
			await setup.renderOnce();
			expect(setup.renderer.root.findDescendantById("runledger-transcript")?.num).toBe(transcript?.num);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("user: retained");
			expect(frame).toContain("assistant: retained");
			expect(frame).toContain("Host reconnected");
			runtime.destroy();
		} finally {
			if (!setup.renderer.isDestroyed) setup.renderer.destroy();
		}
	});

  test("mount updates persistent screen nodes instead of rebuilding the whole tree", async () => {
    const tuiModule: object = await import("../../src/tui/index.ts");
    const candidate = Reflect.get(tuiModule, "createOpenTuiRuntime");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;

    const setup = await createTestRenderer({ width: 60, height: 16 });
    try {
      const runtime = (candidate as RuntimeFactory)({ renderer: setup.renderer });
      runtime.mount({
        header: "RunLedger",
        resources: "tools: 8",
        transcript: ["assistant: first"],
        status: "streaming",
        footer: "model",
        hints: "Ctrl+D exit",
      });
      await setup.renderOnce();
      const screenBefore = setup.renderer.root.findDescendantById("runledger-screen");
      const transcriptBefore = setup.renderer.root.findDescendantById("runledger-transcript");
      const editorBefore = setup.renderer.root.findDescendantById("runledger-editor");

      runtime.mount({
        header: "RunLedger",
        resources: "tools: 8",
        transcript: ["assistant: first", "assistant: second"],
        status: "idle",
        footer: "model",
        hints: "Ctrl+D exit",
      });
      await setup.renderOnce();

      expect(setup.renderer.root.findDescendantById("runledger-screen")?.num).toBe(screenBefore?.num);
      expect(setup.renderer.root.findDescendantById("runledger-transcript")?.num).toBe(transcriptBefore?.num);
      expect(setup.renderer.root.findDescendantById("runledger-editor")?.num).toBe(editorBefore?.num);
      expect(setup.renderer.root.findDescendantById("runledger-transcript")?.getChildren().length).toBe(2);
      expect(setup.captureCharFrame()).toContain("assistant: second");
      runtime.destroy();
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("绘制最小 RunLedger screen，并由 runtime owner 销毁 renderer", async () => {
    const tuiModule: object = await import("../../src/tui/index.ts");
    const candidate = Reflect.get(tuiModule, "createOpenTuiRuntime");

    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;

    const setup = await createTestRenderer({ width: 60, height: 16 });
    try {
      const runtime = (candidate as RuntimeFactory)({ renderer: setup.renderer });
      runtime.mount({
        header: "RunLedger",
        resources: "tools: 8",
        transcript: ["user: hello", "assistant: ready"],
        status: "idle",
        footer: "deepseek-v4-pro",
        hints: "Ctrl+D exit",
      });

      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("RunLedger");
      expect(frame).toContain("tools: 8");
      expect(frame).toContain("user: hello");
      expect(frame).toContain("assistant: ready");
      expect(frame).toContain("idle");
      expect(frame).toContain("deepseek-v4-pro");
      expect(frame).toContain("Ctrl+D exit");

      runtime.destroy();
      expect(setup.renderer.isDestroyed).toBe(true);
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("Textarea 接收输入、Enter 提交并清空草稿", async () => {
    const tuiModule: object = await import("../../src/tui/index.ts");
    const candidate = Reflect.get(tuiModule, "createOpenTuiRuntime");
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;

    const setup = await createTestRenderer({ width: 60, height: 16 });
    const submitted: string[] = [];
    try {
      const runtime = (candidate as RuntimeFactory)({
        renderer: setup.renderer,
        onSubmit: (text) => submitted.push(text),
      });
      runtime.mount({
        header: "RunLedger",
        resources: "",
        transcript: [],
        status: "idle",
        footer: "model",
        hints: "",
      });

      expect(typeof runtime.getEditorText).toBe("function");
      await setup.mockInput.typeText("hello");
      setup.mockInput.pressEnter();
      await setup.renderOnce();

      expect(submitted).toEqual(["hello"]);
      expect(runtime.getEditorText()).toBe("");
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });
});
