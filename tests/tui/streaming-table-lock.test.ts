import { describe, expect, test } from "vitest";
import {
	splitClosedStreamingTable,
	isMarkdownTableDelimiter,
} from "../../src/tui/opentui/streaming-table-split.ts";

describe("streaming table split", () => {
	test("finds a table followed by a blank line and a non-table tail", () => {
		const source = [
			"intro",
			"",
			"| name | value |",
			"| --- | --- |",
			"| alpha | short |",
			"",
			"assistant tail",
		].join("\n");

		const split = splitClosedStreamingTable(source);

		expect(split).toMatchObject({
			tableText: "| name | value |\n| --- | --- |\n| alpha | short |",
			prefixText: "intro\n\n| name | value |\n| --- | --- |\n| alpha | short |\n\n",
			tailText: "assistant tail",
			rowCount: 3,
		});
		expect(split?.prefixText + split?.tailText).toBe(source);
	});

	test("keeps the same settled table prefix while the tail grows", () => {
		const first = splitClosedStreamingTable([
			"| name | value |",
			"| --- | --- |",
			"| alpha | short |",
			"",
			"tail",
		].join("\n"));
		const second = splitClosedStreamingTable([
			"| name | value |",
			"| --- | --- |",
			"| alpha | short |",
			"",
			"tail grows wider",
		].join("\n"));

		expect(second?.prefixText).toBe(first?.prefixText);
		expect(second?.tailText).toBe("tail grows wider");
	});

	test("does not split an open table that can still receive rows", () => {
		const source = [
			"| name | value |",
			"| --- | --- |",
			"| alpha | short |",
			"| beta | a much wider value |",
		].join("\n");

		expect(splitClosedStreamingTable(source)).toBeUndefined();
	});

	test("requires a real markdown delimiter row", () => {
		expect(isMarkdownTableDelimiter("| --- | :---: | ---: |")).toBe(true);
		expect(isMarkdownTableDelimiter("| -- | value |")).toBe(false);
		expect(isMarkdownTableDelimiter("plain | text")).toBe(false);
	});
});
