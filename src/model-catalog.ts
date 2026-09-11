/**
 * 生成 catalog 的类型派生工具。
 *
 * 模型清单只存在于生成的 `src/providers/data/<id>.json` 中,并按 api 分组;
 * 每个 provider 的 `<id>.models.ts` 只做一次泛型派生,不再逐模型枚举
 * id/api 类型(对照上游 pi 的 model-catalog 机制)。
 */

import type { Api, Model, ProviderId } from "./types.ts";

export type ModelGroups = Record<string, Record<string, object>>;

/** 所有 api 分组键下出现的 model id 并集。 */
type ModelId<TGroups extends ModelGroups> = {
	[TApi in keyof TGroups]: keyof TGroups[TApi];
}[keyof TGroups] &
	string;

/**
 * 由 JSON 的 api 分组键推导某个 model id 的 api 字面量类型。
 *
 * JSON 导入的字符串值会被拓宽为 `string`,因此 api 类型只能来自分组键;
 * 只有该 model id 出现在对应分组内时,该分组键才成为候选 api。
 */
type ModelApi<TGroups extends ModelGroups, TModelId extends ModelId<TGroups>> = {
	[TApi in keyof TGroups]: TModelId extends keyof TGroups[TApi] ? TApi : never;
}[keyof TGroups] &
	Api;

export type ModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TModelId in ModelId<TGroups>]: Model<ModelApi<TGroups, TModelId>> & {
		id: TModelId;
		provider: TProvider;
	};
};

/** 合并 api 分组为按 model id 索引的扁平 catalog,保留每个条目的 api 字面量类型。 */
export function flattenModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	_provider: TProvider,
	groups: TGroups,
): ModelCatalog<TGroups, TProvider> {
	return Object.assign({}, ...Object.values(groups)) as ModelCatalog<TGroups, TProvider>;
}
