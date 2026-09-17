import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { startWebServer } from "../web/server.ts";
import { validateLegacyCliEnvironment } from "./authority.ts";

export const WEB_USAGE = "Usage: runledger web [--port <0-65535>]\n\n只读本地看板；默认绑定 127.0.0.1 的空闲端口。Ctrl+C 关闭 Web，不停止 Session Owner。\n";
export async function runWebCommand(args: readonly string[]): Promise<void> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { process.stdout.write(WEB_USAGE); return; }
  let port = 0;
  if (args.length !== 0) {
    if (args.length !== 2 || args[0] !== "--port" || !/^(0|[1-9][0-9]*)$/.test(args[1]) || Number(args[1]) > 65535) throw new Error(WEB_USAGE);
    port = Number(args[1]);
  }
  const legacy = validateLegacyCliEnvironment();
  if (legacy) throw new Error(legacy);
  const { layout } = await resolveRunledgerHome();
  const server = await startWebServer({ layout, port });
  // 唯一启动链接只在用户显式启动时显示；HTTP 服务不记录 URL、body 或 Cookie。
  process.stdout.write(`RunLedger 只读看板：${server.loginUrl}\n`);
  await new Promise<void>((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true;
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
      void server.close().finally(resolve);
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
}
