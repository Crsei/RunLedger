import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

async function start(): Promise<void> {
  const root = createRoot(document.getElementById("root")!);
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  if (token) {
    try {
      const response = await fetch("/auth/exchange", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      if (!response.ok) throw new Error("启动链接已使用或失效，请重新启动 runledger web。");
    } catch (error) { root.render(<div className="login-error">{error instanceof Error ? error.message : "登录失败"}</div>); return; }
  }
  root.render(<App />);
}
void start();
