export class ApiError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, credentials: "same-origin", headers: { "Cache-Control": "no-store" } });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { code?: string };
    throw new ApiError(failure.code ?? `http_${response.status}`);
  }
  return await response.json() as T;
}
export function query(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value != null && value !== "") params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
export function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "unknown";
  return ({ database_missing: "尚无运行记录，请先用 RunLedger CLI 创建会话。", schema_incompatible: "存储版本不兼容，请通过 CLI 显式迁移。", migration_in_progress: "存储正在迁移，暂时无法读取。", corrupt: "数据损坏，无法可靠显示。", unauthenticated: "登录已失效，请重新启动 Web 并使用新的启动链接。", resync_required: "数据源已变化，正在重新同步。", not_found: "记录不存在。" } as Record<string, string>)[code] ?? code;
}
