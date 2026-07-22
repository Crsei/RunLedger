import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RESOURCE_FILES = ["types.ts", "schemas.ts", "ports.ts", "events.ts"] as const;

function source(name: (typeof RESOURCE_FILES)[number]): string {
	return readFileSync(new URL(`../../../src/runtime/resources/${name}`, import.meta.url), "utf8");
}

describe("resource contract architecture boundary", () => {
	it("contains only neutral contracts and no extension behavior dependencies", () => {
		const joined = RESOURCE_FILES.map(source).join("\n");
		for (const forbidden of [
			'from "node:fs',
			'from "node:child_process',
			'from "node:net',
			'from "node:http',
			'from "node:https',
			"@modelcontextprotocol",
			"yaml",
			"semver",
			"src/extensions",
			'from "../../extensions',
		]) {
			expect(joined, forbidden).not.toContain(forbidden);
		}
		expect(joined).not.toMatch(/TODO\(/);
	});

	it("does not expose broad record payloads or executable objects in public resource types", () => {
		const types = source("types.ts");
		expect(types).not.toContain("Record<string, unknown>");
		expect(types).not.toMatch(/\bhandler\s*:/);
		expect(types).not.toMatch(/\bclient\s*:/);
		expect(types).not.toMatch(/\bprocessHandle\s*:/);
		expect(types).not.toMatch(/\bloader\s*:/);
		expect(types).toContain("rawInput: unknown");
		expect(types).toContain('verification: "content_identity_only"');
	});

	it("keeps the adapter surface exact and transport agnostic", () => {
		const ports = source("ports.ts");
		expect(ports).toContain("resolveExact(request: ResourceResolveRequest)");
		expect(ports).toContain("search(request: ResourceSearchRequest)");
		expect(ports).toContain("canonicalizeAndDerive(");
		expect(ports).toContain("invoke(invocation: RuntimeToolInvocation");
		expect(ports).toContain("cancel(request: ResourceCancellationRequest)");
		expect(ports).toContain("emit(request: ResourceEventEmissionRequest)");
		expect(ports).toContain("acquire(request: ResourceSnapshotAcquireRequest)");
		expect(ports).toContain("release(request: ResourceSnapshotReleaseRequest)");
		expect(ports).not.toContain("scan(");
		expect(ports).not.toContain("install(");
		expect(ports).not.toContain("connect(");
		expect(ports).not.toContain("spawn(");
	});
});
