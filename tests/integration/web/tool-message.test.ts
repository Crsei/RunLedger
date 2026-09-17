import { describe, expect, it } from "vitest";
import { webFixture } from "./fixture.ts";
import { WebHistory } from "../../../src/web/history.ts";
import { OfflineWebTrajectory } from "../../../src/web/offline-trajectory.ts";

describe("canonical runtime tool message projection", () => {
  it("projects nested toolResult blocks and retrieves input/output/body independently", async () => {
    const fixture = webFixture(), session = fixture.create("runtime-tool");
    const input = { command: "输入😀".repeat(1500) }, output = [{ type: "text", text: "输出😀".repeat(5000) }];
    session.message("assistant", [{ type: "toolCall", id: "call-1", name: "bash", arguments: input }]);
    session.message("toolResult", [{ type: "toolResult", toolCallId: "call-1", toolName: "bash", content: output, isError: false }]);
    session.message("assistant", [{ type: "text", text: "正文😀".repeat(5000) }]);
    const history = new WebHistory(fixture.layout.database), trajectory = new OfflineWebTrajectory(fixture.layout, history);
    try {
      const rows = history.snapshot(session.sessionId).timeline.items;
      expect(rows).toHaveLength(3);
      expect(rows[0].tool?.callId).toBe(rows[1].tool?.callId);
      expect(rows[1].tool?.state).toBe("succeeded");
      expect(rows.every((row) => row.truncated)).toBe(true);
      const collect = async (id: string, field: "input" | "output") => {
        let detail = await trajectory.detail(session.sessionId, id, field), text = detail.text;
        while (detail.next) { detail = await trajectory.detail(session.sessionId, id, field, detail.next); text += detail.text; }
        expect(detail.availability).toBe("complete"); return text;
      };
      expect(await collect(rows[0].tool!.inputDetailRecordId!, "input")).toBe(JSON.stringify(input));
      expect(JSON.parse(await collect(rows[1].tool!.detailRecordId!, "output"))).toEqual(output);
      expect(await collect(rows[2].detailRecordId!, "output")).toBe("正文😀".repeat(5000));
      expect((await trajectory.detail(session.sessionId, rows[0].tool!.detailRecordId!, "output")).availability).toBe("not-recorded");
    } finally { await trajectory.close(); fixture.close(); }
  });
});
