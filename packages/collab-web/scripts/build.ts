/**
 * 打包 collab-web 静态资源到产品 dist/web/assets。
 *
 * 产物位置由服务端 HTTP 桥的 `import.meta.url` 决定（dist/web/server.js 旁的 assets/），
 * 因此这里从本脚本位置反推仓库根，而不是依赖调用者的 cwd。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const assets = resolve(repoRoot, "dist/web/assets");
mkdirSync(assets, { recursive: true });

for (const [entry, name] of [["src/main.tsx", "app.js"], ["src/event-worker.ts", "event-worker.js"]] as const) {
	execFileSync("bun", [
		"build", resolve(packageRoot, entry),
		"--outdir", assets,
		"--entry-naming", name,
		"--target=browser",
		"--production",
	], { stdio: "inherit" });
}

copyFileSync(resolve(packageRoot, "index.html"), resolve(assets, "index.html"));
copyFileSync(resolve(packageRoot, "app.css"), resolve(assets, "app.css"));
copyFileSync(resolve(packageRoot, "THIRD_PARTY_NOTICES.md"), resolve(assets, "THIRD_PARTY_NOTICES.md"));
