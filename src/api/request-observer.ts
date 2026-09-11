import type { Api, Model, StreamOptions } from "../types.ts";

/** 捕获修改后的 provider 输入；字符串快照不能反向修改正在发送的对象。 */
export async function notifyRequestPrepared(options: StreamOptions | undefined, payload: unknown, model: Model<Api>): Promise<void> {
	if (options?.onRequestPrepared === undefined) return;
	try {
		const json = JSON.stringify(payload);
		if (json !== undefined) await options.onRequestPrepared(json, model);
	} catch {
		// 观测失败不能阻断模型请求；没有快照时查询端明确报告 unavailable。
	}
}
