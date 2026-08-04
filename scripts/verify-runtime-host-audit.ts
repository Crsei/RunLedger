#!/usr/bin/env node

import { runRuntimeHostAudit } from "./runtime-host-audit.ts";

const USAGE = "verify-runtime-host-audit --output <existing-absolute-dir>";

async function main(argv: readonly string[]): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
		process.stderr.write(`${USAGE}\n`);
		return 1;
	}
	try {
		const result = await runRuntimeHostAudit({ repositoryRoot: process.cwd(), outputDirectory: argv[1] });
		process.stdout.write(`${JSON.stringify({
			outcome: result.manifest.outcome,
			candidateDigest: result.manifest.candidate.candidateDigest,
			candidateStable: result.manifest.candidateStable,
			manifest: "runtime-host-audit-manifest.json",
		})}\n`);
		return result.exitCode;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "runtime_host_audit_failed"}\n`);
		return 1;
	}
}

main(process.argv.slice(2)).then((exitCode) => {
	process.exitCode = exitCode;
}).catch(() => {
	process.exitCode = 1;
});
