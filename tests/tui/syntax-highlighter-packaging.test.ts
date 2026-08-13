import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { syntaxBenchmarkFixtures } from "../../scripts/syntax-highlighter-benchmark-fixtures.ts";
import { resolveNativeSyntaxPackage } from "../../src/tui/highlight/native-package.ts";

describe("syntax highlighter packaging", () => {
	it("maps all eight supported OS/libc/arch tuples to exact optional packages", () => {
		const cases = [
			["linux", "x64", "glibc", "@runledger/syntax-highlighter-linux-x64-gnu"],
			["linux", "arm64", "glibc", "@runledger/syntax-highlighter-linux-arm64-gnu"],
			["linux", "x64", "musl", "@runledger/syntax-highlighter-linux-x64-musl"],
			["linux", "arm64", "musl", "@runledger/syntax-highlighter-linux-arm64-musl"],
			["darwin", "x64", undefined, "@runledger/syntax-highlighter-darwin-x64"],
			["darwin", "arm64", undefined, "@runledger/syntax-highlighter-darwin-arm64"],
			["win32", "x64", undefined, "@runledger/syntax-highlighter-win32-x64-msvc"],
			["win32", "arm64", undefined, "@runledger/syntax-highlighter-win32-arm64-msvc"],
		] as const;
		for (const [platform, arch, libc, packageName] of cases) {
			expect(resolveNativeSyntaxPackage({ platform, arch, ...(libc === undefined ? {} : { libc }) })).toEqual({ ok: true, packageName });
		}
		expect(resolveNativeSyntaxPackage({ platform: "linux", arch: "riscv64", libc: "glibc" })).toEqual({ ok: false, reason: "native_unavailable" });
		expect(resolveNativeSyntaxPackage({ platform: "linux", arch: "x64" })).toEqual({ ok: false, reason: "native_unavailable" });
	});

	it("declares exact optional versions and target-specific package manifests", () => {
		const root = JSON.parse(readFileSync("package.json", "utf8")) as {
			version: string;
			files?: string[];
			optionalDependencies?: Record<string, string>;
		};
		expect((root as { private?: boolean }).private).toBe(true);
		expect(root.files).toContain("!dist/native/runledger-syntax-highlighter.node");
		const optional = Object.entries(root.optionalDependencies ?? {}).filter(([name]) => name.startsWith("@runledger/syntax-highlighter-"));
		expect(optional).toHaveLength(8);
		for (const [name, version] of optional) {
			expect(version).toBe(root.version);
			const directory = name.replace("@runledger/syntax-highlighter-", "");
			const manifest = JSON.parse(readFileSync(`npm/syntax-highlighter-${directory}/package.json`, "utf8")) as { name: string; version: string; files?: string[] };
			expect(manifest).toMatchObject({ name, version: root.version });
			expect(manifest.files).toEqual(expect.arrayContaining(["runledger-syntax-highlighter.node", "runledger-syntax-highlighter.node.sigstore.json", "checksums.json", "NOTICE.md", "THIRD_PARTY_NOTICES.md"]));
		}
	});
	it("builds the addon before TypeScript and keeps it under dist/native", () => {
		const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
			scripts?: Record<string, string>;
		};
		const build = packageJson.scripts?.build ?? "";
		const nativeBuild = packageJson.scripts?.["build:syntax-highlighter"] ?? "";

		expect(nativeBuild).toContain("scripts/build-syntax-highlighter.ts");
		expect(build.indexOf("build:syntax-highlighter")).toBeGreaterThanOrEqual(0);
		expect(build.indexOf("build:syntax-highlighter")).toBeLessThan(build.indexOf("tsc -p tsconfig.json"));
		expect(packageJson.scripts?.["check:syntax-highlighter"]).toContain("cargo test");
		expect(packageJson.scripts?.check).toContain("check:syntax-highlighter");
	});

	it("binds each prebuild package name to an explicit Rust target triple", () => {
		const source = readFileSync("scripts/build-syntax-highlighter.ts", "utf8");
		expect(source).toContain("RUNLEDGER_SYNTAX_TARGET");
		expect(source).toContain("--target");
		expect(source).toContain("aarch64-unknown-linux-musl");
		expect(source).toContain("aarch64-pc-windows-msvc");
	});

	it("derives the native engine build identity from the exact Rust source and lockfile", () => {
		const buildScript = readFileSync("scripts/build-syntax-highlighter.ts", "utf8");
		const rustBuild = readFileSync("native/syntax-highlighter/build.rs", "utf8");
		const cargoManifest = readFileSync("native/syntax-highlighter/Cargo.toml", "utf8");
		const rust = readFileSync("native/syntax-highlighter/src/lib.rs", "utf8");
		for (const path of ["src/lib.rs", "Cargo.toml", "Cargo.lock", "build.rs"]) {
			expect(rustBuild).toContain(`\"${path}\"`);
			expect(rustBuild).toContain(`cargo:rerun-if-changed=${path}`);
		}
		expect(rustBuild).toContain("Sha256::new()");
		expect(rustBuild).toContain("cargo:rustc-env=RUNLEDGER_SYNTAX_ENGINE_SOURCE_ID=");
		expect(cargoManifest).toMatch(/sha2\s*=\s*"=[^"]+"/u);
		expect(buildScript).not.toContain("RUNLEDGER_SYNTAX_ENGINE_SOURCE_ID");
		expect(buildScript).not.toContain("createHash");
		expect(rust).toContain('env!("RUNLEDGER_SYNTAX_ENGINE_SOURCE_ID")');
	});

	it("declares a fail-soft loader without runtime download or subprocess fallback", () => {
		const loader = readFileSync("src/tui/highlight/native-loader.ts", "utf8");

		expect(loader).toContain("checksums.json");
		expect(loader).toContain("native_integrity_error");
		expect(loader).not.toMatch(/https?:\/\//u);
		expect(loader).not.toMatch(/child_process|spawn|execFile|curl|wget/u);
	});

	it("ships real-runner build/load, checksum, Sigstore, attestation, and clean-consumer gates", () => {
		const workflow = readFileSync(".github/workflows/syntax-highlighter-prebuild.yml", "utf8");
		for (const marker of ["linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64", "win32-x64-msvc", "win32-arm64-msvc"]) {
			expect(workflow).toContain(marker);
		}
		for (const marker of ["node-smoke", "bun-smoke", "clean-consumer", "attest-build-provenance", "cosign sign-blob", "cosign verify-blob", "checksums.json", "release-gate"]) {
			expect(workflow).toContain(marker);
		}
		expect(workflow).toContain("scripts/verify-syntax-highlighter-clean-consumer.ts");
		expect(workflow).not.toContain("shell: bash");
		expect(workflow).not.toContain("import('runledger')");
		expect(workflow).not.toContain("container:");
		expect(workflow).toContain("RUNLEDGER_SYNTAX_TARGET");
		expect(workflow).toContain("musl-tools");
		expect(workflow).toContain("release-publish");
		expect(workflow).toContain("npm publish");
		expect(workflow).toContain("--provenance");
	});

	it("generates embedded grammar and theme acknowledgements from the pinned two-face crate", () => {
		const packager = readFileSync("scripts/package-syntax-highlighter-prebuild.ts", "utf8");
		const generator = readFileSync("native/syntax-highlighter/src/bin/generate-acknowledgements.rs", "utf8");
		expect(packager).toContain("generate-acknowledgements");
		expect(packager).toContain("THIRD_PARTY_NOTICES.md");
		expect(generator).toContain("two_face::acknowledgement::listing().to_md()");
	});

	it("provides a repeatable native benchmark for the plan boundary fixtures", () => {
		const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
		const benchmark = packageJson.scripts?.["benchmark:syntax-highlighter"] ?? "";
		expect(benchmark).toContain("scripts/benchmark-syntax-highlighter.ts");
		const source = readFileSync("scripts/benchmark-syntax-highlighter.ts", "utf8");
		const fixtures = readFileSync("scripts/syntax-highlighter-benchmark-fixtures.ts", "utf8");
		expect(fixtures).toContain("32 KiB visible snippet");
		expect(fixtures).toContain("near 512 KiB boundary");
		expect(fixtures).toContain("10,000 line boundary");
		expect(source).toContain("WARMUP_RUNS = 20");
		expect(source).toContain("SAMPLE_RUNS = 100");
		expect(source).toContain("VISIBLE_32_KIB_P95_STOP_GATE_MS = 50");
		expect(source).toContain("process.exitCode = 1");
		expect(source).not.toMatch(/console\.log\([^)]*source/u);
	});

	it("keeps each benchmark fixture within both native byte and line guards", () => {
		for (const fixture of syntaxBenchmarkFixtures()) {
			expect(Buffer.byteLength(fixture.source, "utf8"), fixture.name).toBeLessThanOrEqual(512 * 1024);
			const lines = fixture.source.endsWith("\n") ? fixture.source.split("\n").length - 1 : fixture.source.split("\n").length;
			expect(lines, fixture.name).toBeLessThanOrEqual(10_000);
		}
	});
});
