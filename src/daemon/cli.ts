#!/usr/bin/env node
/** 编译后的 daemon bin 入口；协议输出只写 stdout，fatal 诊断只写 stderr。 */

import { daemonMain } from "./stdio-cli.ts";

daemonMain(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`[runledger-daemon] fatal: ${error instanceof Error ? error.message : "unknown error"}\n`);
		process.exitCode = 1;
	},
);
