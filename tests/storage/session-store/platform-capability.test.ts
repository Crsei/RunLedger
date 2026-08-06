/**
 * R1:数据库文件保护平台能力 fixtures。
 */

import { describe, expect, it } from "vitest";
import { databasePlatformCapability } from "../../../src/storage/session-store/platform-capability.ts";

describe("R1 database platform capability", () => {
	it("declares verified 0600 floor only for linux with runner evidence", () => {
		const linux = databasePlatformCapability("linux");
		expect(linux).toEqual({ platform: "linux", evidence: "verified", fileModeFloor: 0o600 });
	});

	it("declares unverified_platform without fabricating ACL equivalence elsewhere", () => {
		for (const platform of ["macos", "windows"] as const) {
			const capability = databasePlatformCapability(platform);
			expect(capability.evidence).toBe("unverified_platform");
			expect(capability.fileModeFloor).toBeNull();
		}
	});
});
