/** tool call/result 必须一一对应，且同一 ID 不能重复；切点唯一实现在 history.ts。 */
export function isCompleteToolBatch(turn: { readonly toolCallIds: readonly string[]; readonly toolResultIds: readonly string[] }): boolean {
	const calls = new Set(turn.toolCallIds);
	const results = new Set(turn.toolResultIds);
	return calls.size === turn.toolCallIds.length && results.size === turn.toolResultIds.length && calls.size === results.size && [...calls].every((id) => results.has(id));
}
