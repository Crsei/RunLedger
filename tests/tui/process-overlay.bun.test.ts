import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createManagedProcessOverlayFromRenderer } from "../../src/tui/opentui/process-overlay.ts";

describe("OpenTUI managed process overlay", () => {
  test("renders bounded terminal output, captures driver input, and restores focus on close", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const inputs: string[] = [];
    let restored = 0;
    const runtime = createManagedProcessOverlayFromRenderer(setup.renderer, {
      onInput: (value) => inputs.push(value),
      restoreFocus: () => { restored += 1; },
    });
    try {
      runtime.update({
        title: "Terminal execution_demo",
        state: "running",
        output: ["hello😀", "second line"],
        cursor: { sequence: 1, byteOffset: 12 },
        driver: true,
        canWrite: true,
        canResize: true,
        canStop: true,
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Terminal execution_demo");
      expect(setup.captureCharFrame()).toContain("hello😀");
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-process-overlay-input");

      await setup.mockInput.typeText("x");
      expect(inputs).toContain("x");

      runtime.close();
      expect(restored).toBe(1);
      expect(setup.renderer.isDestroyed).toBe(false);
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });

  test("observer view does not mount a writable input", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const runtime = createManagedProcessOverlayFromRenderer(setup.renderer, {
      onInput: () => {},
      restoreFocus: () => {},
    });
    try {
      runtime.update({
        title: "Observer",
        state: "running",
        output: ["read only"],
        cursor: { sequence: 1, byteOffset: 3 },
        driver: false,
        canWrite: false,
        canResize: false,
        canStop: false,
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("observer · read only");
      expect(setup.renderer.currentFocusedRenderable?.id).not.toBe("runledger-process-overlay-input");
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });
});
