import { describe, expect, test } from "vitest";
import { freezeStreamPrefix, type SettledSpan } from "../../src/tui/opentui/settled-prefix.ts";

describe("freezeStreamPrefix", () => {
  test("returns the largest non-whitespace hard-break prefix", () => {
    const settled = freezeStreamPrefix("# title\n\nbody text");

    expect(settled).toMatchObject({
      start: 0,
      prefixText: "# title\n\n",
    });
    expect(settled?.end).toBe("# title\n\n".length);
  });

  test("does not freeze a blank line inside an open fence", () => {
    const settled = freezeStreamPrefix("intro\n\n```ts\nconst value = 1;\n\nstill open");

    expect(settled?.prefixText).toBe("intro\n\n");
  });

  test("advances past a fence only after its closing marker", () => {
    const settled = freezeStreamPrefix("intro\n\n```ts\nconst value = 1;\n```\n\nnext");

    expect(settled?.prefixText).toBe("intro\n\n```ts\nconst value = 1;\n```\n\n");
  });

  test("keeps a same-marker list open across a blank line", () => {
    expect(freezeStreamPrefix("- first\n\n- second")).toBeUndefined();
    expect(freezeStreamPrefix("- first\n\nparagraph")).toMatchObject({
      prefixText: "- first\n\n",
    });
    expect(freezeStreamPrefix("- first\n\n  continuation\n\n- second")).toBeUndefined();
  });

  test("keeps an ordered list open while its next marker is incomplete", () => {
    expect(freezeStreamPrefix("1. first\n\n1")).toBeUndefined();
    expect(freezeStreamPrefix("1. first\n\n2x")).toMatchObject({
      prefixText: "1. first\n\n",
    });
  });

  test("preserves the settled prefix on append and resets on rewind", () => {
    const first = freezeStreamPrefix("heading\n\nactive") as SettledSpan;
    const unchanged = freezeStreamPrefix("heading\n\nactive tail", first);
    const advanced = freezeStreamPrefix("heading\n\nactive\n\nnext", first);
    const rewound = freezeStreamPrefix("replacement\n\ntext", first);

    expect(unchanged).toEqual(first);
    expect(advanced?.end).toBeGreaterThan(first.end);
    expect(advanced?.prefixText).toBe("heading\n\nactive\n\n");
    expect(rewound).toBeUndefined();
  });
});
