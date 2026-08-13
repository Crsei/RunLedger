/** 只从已安装 optional package 加载 native addon；禁止 root tarball 本地产物掩盖失败。 */

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const consumerRoot = resolve(process.env.RUNLEDGER_SYNTAX_CONSUMER_ROOT ?? process.argv[2] ?? process.cwd());
const require = createRequire(resolve(consumerRoot, "package.json"));
const packageRoot = dirname(require.resolve("runledger/package.json"));
const [{ loadNativeSyntaxAddonFromPackage }, { resolveNativeSyntaxPackage }] = await Promise.all([
	import(pathToFileURL(join(packageRoot, "dist/tui/highlight/native-loader.js")).href),
	import(pathToFileURL(join(packageRoot, "dist/tui/highlight/native-package.js")).href),
]);
const platform = process.platform;
const libc = platform === "linux" && process.env.RUNLEDGER_SYNTAX_TARGET?.endsWith("-musl") ? "musl" : "glibc";
const target = resolveNativeSyntaxPackage({ platform, arch: process.arch, ...(platform === "linux" ? { libc } : {}) });
if (!target.ok) throw new Error(target.reason);
const availability = loadNativeSyntaxAddonFromPackage({
	packageName: target.packageName,
	resolvePackageJson: (name) => require.resolve(`${name}/package.json`),
	readFile: (path) => require("node:fs").readFileSync(path) as Uint8Array,
	loadModule: (path) => require(path) as unknown,
});
if (!availability.ok) throw new Error(availability.reason);
const result = await availability.addon.highlightAsync("const clean = true;", "javascript", "catppuccin-mocha");
if (!result.ok || result.lines.length !== 1) throw new Error(result.ok ? "invalid clean-consumer result" : result.reason);
process.stdout.write(`syntax-highlighter-clean-consumer:${target.packageName}:${availability.info.engineBuildId}\n`);
