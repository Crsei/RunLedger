import { describe, expect, it } from "vitest";
import {
	DIFF_TAB_REPLACEMENT,
	EXEC_CONTINUATION_MAX_LINES,
	EXEC_CONTINUATION_PREFIX,
	EXEC_INTERACTION_PREVIEW_CHARS,
	EXEC_OUTPUT_MAX_LINES,
	EXEC_OUTPUT_MAX_LINES_TOOL,
	EXEC_OUTPUT_MAX_LINES_USER_SHELL,
	EXEC_OUTPUT_PREFIX,
	EXEC_TRUNCATION_HINT,
	NOTICE_CONTINUATION_INDENT,
	NOTICE_WARN_PREFIX,
	PLAN_STEP_CONTINUATION_INDENT,
	PLAN_STEP_PREFIX,
	STATUS_DETAILS_MAX_LINES,
	STATUS_DETAILS_PREFIX,
	diffLineNumberWidth,
	formatElapsedCompact,
	formatExecTruncationHint,
	planWrapWidth,
} from "../../../src/tui/opentui/block-layout.ts";
import { sessionDisplayFixtures } from "./fixtures.ts";

describe("Codex session display S0 layout contract", () => {
	it("freezes the Codex-aligned layout constants", () => {
		expect({
			EXEC_CONTINUATION_PREFIX,
			EXEC_CONTINUATION_MAX_LINES,
			EXEC_OUTPUT_PREFIX,
			EXEC_OUTPUT_MAX_LINES,
			EXEC_OUTPUT_MAX_LINES_TOOL,
			EXEC_OUTPUT_MAX_LINES_USER_SHELL,
			EXEC_INTERACTION_PREVIEW_CHARS,
			PLAN_STEP_PREFIX,
			PLAN_STEP_CONTINUATION_INDENT,
			DIFF_TAB_REPLACEMENT,
			STATUS_DETAILS_PREFIX,
			STATUS_DETAILS_MAX_LINES,
			NOTICE_WARN_PREFIX,
			NOTICE_CONTINUATION_INDENT,
			EXEC_TRUNCATION_HINT,
		}).toEqual({
			EXEC_CONTINUATION_PREFIX: "  │ ",
			EXEC_CONTINUATION_MAX_LINES: 2,
			EXEC_OUTPUT_PREFIX: "  └ ",
			EXEC_OUTPUT_MAX_LINES: 5,
			EXEC_OUTPUT_MAX_LINES_TOOL: 5,
			EXEC_OUTPUT_MAX_LINES_USER_SHELL: 50,
			EXEC_INTERACTION_PREVIEW_CHARS: 80,
			PLAN_STEP_PREFIX: "  └ ",
			PLAN_STEP_CONTINUATION_INDENT: "    ",
			DIFF_TAB_REPLACEMENT: "    ",
			STATUS_DETAILS_PREFIX: "  └ ",
			STATUS_DETAILS_MAX_LINES: 3,
			NOTICE_WARN_PREFIX: "⚠ ",
			NOTICE_CONTINUATION_INDENT: "  ",
			EXEC_TRUNCATION_HINT: "(Ctrl+T for transcript)",
		});
	});

	it("computes bounded plan wrapping and diff gutter widths", () => {
		expect(planWrapWidth(80)).toBe(76);
		expect(planWrapWidth(4)).toBe(1);
		expect(planWrapWidth(0)).toBe(1);
		expect(diffLineNumberWidth(1)).toBe(1);
		expect(diffLineNumberWidth(999)).toBe(3);
		expect(diffLineNumberWidth(-1)).toBe(1);
	});

	it.each([
		[0, "0s"],
		[59, "59s"],
		[60, "1m 00s"],
		[3_599, "59m 59s"],
		[3_600, "1h 00m 00s"],
		[3_661, "1h 01m 01s"],
	])("formats %i seconds as %s", (seconds, expected) => {
		expect(formatElapsedCompact(seconds)).toBe(expected);
	});

	it("formats the middle-truncation hint with the omitted screen-line count", () => {
		expect(formatExecTruncationHint(12)).toBe("… +12 lines (Ctrl+T for transcript)");
		expect(formatExecTruncationHint(-1)).toBe("… +0 lines (Ctrl+T for transcript)");
	});

	it("keeps representative plan, exec, diff, and separator fixtures available", () => {
		expect(sessionDisplayFixtures.plan.complete.steps).toHaveLength(3);
		expect(sessionDisplayFixtures.plan.empty.steps).toHaveLength(0);
		expect(sessionDisplayFixtures.exec.longOutput.output).toHaveLength(8);
		expect(sessionDisplayFixtures.exec.failed.exitCode).toBe(7);
		expect(sessionDisplayFixtures.diff.contextAddDeleteCrossHunk.hunks).toHaveLength(2);
		expect(sessionDisplayFixtures.separator.workedWithMetrics.metrics).toEqual(["2 tools", "1.2k tokens"]);
	});

	it("anchors the current exec, diff, and separator block shapes", () => {
		expect([
			sessionDisplayFixtures.exec.baseline,
			sessionDisplayFixtures.diff.baseline,
			sessionDisplayFixtures.separator.baseline,
		]).toMatchInlineSnapshot(`
      [
        {
          "command": "echo baseline",
          "durationMs": 12,
          "exitCode": 0,
          "kind": "exec",
          "output": [
            {
              "channel": "stdout",
              "text": "baseline",
            },
          ],
          "status": "succeeded",
        },
        {
          "document": {
            "addedLines": {
              "state": "known",
              "value": 1,
            },
            "hunks": [
              {
                "lines": [
                  {
                    "kind": "context",
                    "newLine": 10,
                    "oldLine": 10,
                    "text": {
                      "byteLength": 20,
                      "text": "const before = true;",
                      "truncated": false,
                    },
                  },
                  {
                    "kind": "delete",
                    "oldLine": 11,
                    "text": {
                      "byteLength": 16,
                      "text": "const value = 1;",
                      "truncated": false,
                    },
                  },
                  {
                    "kind": "add",
                    "newLine": 11,
                    "text": {
                      "byteLength": 16,
                      "text": "const value = 2;",
                      "truncated": false,
                    },
                  },
                ],
                "newStart": 10,
                "oldStart": 10,
              },
            ],
            "kind": "document",
            "path": {
              "byteLength": 14,
              "text": "src/example.ts",
              "truncated": false,
            },
            "removedLines": {
              "state": "known",
              "value": 1,
            },
            "truncated": false,
          },
          "kind": "diff",
        },
        {
          "kind": "separator",
          "label": "stop · Worked for 12s",
        },
      ]
    `);
	});
});
