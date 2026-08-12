export interface SyntaxBenchmarkFixture {
	readonly name: string;
	readonly source: string;
	readonly language: string;
	readonly theme: string;
}

export function syntaxBenchmarkFixtures(): readonly SyntaxBenchmarkFixture[] {
	return [
		fixture("32 KiB visible snippet", fitBytes("const audit = true;\n", 32 * 1024)),
		fixture("near 512 KiB boundary", fitBytes("const audit = true; // xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n", 512 * 1024 - 1)),
		fixture("10,000 line boundary", "x\n".repeat(10_000)),
	];
}

function fixture(name: string, source: string): SyntaxBenchmarkFixture {
	return { name, source, language: "javascript", theme: "catppuccin-mocha" };
}

function fitBytes(seed: string, target: number): string {
	const repeats = Math.floor(target / Buffer.byteLength(seed, "utf8"));
	return seed.repeat(repeats) + "x".repeat(target - repeats * Buffer.byteLength(seed, "utf8"));
}
