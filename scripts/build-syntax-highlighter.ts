/** 构建本机 syntax-highlighter addon；运行时不下载或现场编译。 */

import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const targets = {
	"linux-x64-gnu": { triple: "x86_64-unknown-linux-gnu", library: "librunledger_syntax_highlighter.so" },
	"linux-arm64-gnu": { triple: "aarch64-unknown-linux-gnu", library: "librunledger_syntax_highlighter.so" },
	"linux-x64-musl": { triple: "x86_64-unknown-linux-musl", library: "librunledger_syntax_highlighter.so" },
	"linux-arm64-musl": { triple: "aarch64-unknown-linux-musl", library: "librunledger_syntax_highlighter.so" },
	"darwin-x64": { triple: "x86_64-apple-darwin", library: "librunledger_syntax_highlighter.dylib" },
	"darwin-arm64": { triple: "aarch64-apple-darwin", library: "librunledger_syntax_highlighter.dylib" },
	"win32-x64-msvc": { triple: "x86_64-pc-windows-msvc", library: "runledger_syntax_highlighter.dll" },
	"win32-arm64-msvc": { triple: "aarch64-pc-windows-msvc", library: "runledger_syntax_highlighter.dll" },
} as const;

const requestedTarget = process.env.RUNLEDGER_SYNTAX_TARGET;
const target = requestedTarget === undefined ? undefined : targets[requestedTarget as keyof typeof targets];
if (requestedTarget !== undefined && target === undefined) throw new Error("RUNLEDGER_SYNTAX_TARGET is invalid");
const manifest = resolve("native/syntax-highlighter/Cargo.toml");
const cargoArguments = ["build", "--release", "--locked", "--manifest-path", manifest];
if (target !== undefined) cargoArguments.push("--target", target.triple);
const cargoEnvironment = { ...process.env };
if (target?.triple.endsWith("-musl") === true) {
	const linkerKey = `CARGO_TARGET_${target.triple.replaceAll("-", "_").toUpperCase()}_LINKER`;
	cargoEnvironment[linkerKey] = cargoEnvironment[linkerKey] ?? "musl-gcc";
}
const result = spawnSync("cargo", cargoArguments, {
	env: cargoEnvironment,
	stdio: "inherit",
	shell: false,
});
if (result.status !== 0) process.exit(result.status ?? 1);

const hostLibrary = process.platform === "win32"
	? "runledger_syntax_highlighter.dll"
	: process.platform === "darwin" ? "librunledger_syntax_highlighter.dylib" : "librunledger_syntax_highlighter.so";
const source = target === undefined
	? resolve("native/syntax-highlighter/target/release", hostLibrary)
	: resolve("native/syntax-highlighter/target", target.triple, "release", target.library);
const destinationDirectory = resolve("dist/native");
await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
await copyFile(source, resolve(destinationDirectory, "runledger-syntax-highlighter.node"));
