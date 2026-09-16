/**
 * allowlist Harness Profile 的冻结工具 manifest 摘要 —— 唯一事实来源。
 *
 * 两种形态的摘要在不同环节被比对,必须同时维护:
 *   - `raw`:对 `{name, description, parameters}` 求 digest,用于 `projectHarnessTools`
 *     的投影完整性校验(工具 schema 变即漂移)。
 *   - `table`:对 `{name, descriptorDigest}` 求 digest,即
 *     `harnessToolReceiptTable` 的输出,用于 `harness.composed` receipt 的重放审计。
 *
 * 只有 `tools.mode === "allowlist"` 的 profile 需要冻结值;standard 是直通投影,
 * 工具表增长不改变其语义,因此不做 pin(由 `standard-plan-tool-guard` 测试固定)。
 *
 * 修订规则:任一被投影工具的 name/description/parameters 变化,都会让本表失效。
 * 必须**新增 profile version**(而不是改写既有条目的摘要),既有版本的条目继续为
 * 已存在 Session 的 receipt 重放服务;新 Session 通过
 * `resolveAgentMode` / `*HarnessProfileRef()` 选择新版本。
 */

export interface FrozenToolManifest {
  /** `{name, description, parameters}` 摘要。 */
  readonly raw: string;
  /** `{name, descriptorDigest}` 摘要(harnessToolReceiptTable 形态)。 */
  readonly table: string;
}

/** `manifestFormat: "descriptor-digests@1"` 的当前格式标识。 */
export const HARNESS_MANIFEST_FORMAT = "descriptor-digests@1";

export const FROZEN_TOOL_MANIFESTS: Readonly<Record<string, Readonly<Record<number, FrozenToolManifest>>>> = Object.freeze({
  plan: Object.freeze({
    // plan@1:find 合并进 glob、read 增加行选择器之前的工具描述。
    1: Object.freeze({ raw: "7b5b2a3c5e04a75321d057bbdc9dac200dc97878088e62427f49afb1c3640f5e", table: "d11dcb4da8c9e40e0f03c31f807d1511c9c2f38663b851021e0d6e00c1032cf6" }),
    // plan@2:glob 增加 hidden/gitignore 参数与任意深度语义,read 增加内联选择器描述。
    2: Object.freeze({ raw: "8e368bc0746a0281757d0356606a488056ba107124dfc337924dca3ee175bbec", table: "1e9108b80fe63727cf32af4300d7a785eab389261ea4ea5ef460bfcb09df1290" }),
  }),
  minimal: Object.freeze({
    1: Object.freeze({ raw: "3325e5598de3f84582ef89c65532a6c969355c3eb4821bd19c4529ea7bdacafc", table: "d2c8fe72792fcd0313513f23eab6ddd7f0f6e9073796c01fa245e1818a2c9327" }),
    2: Object.freeze({ raw: "ae5d2f08cd47a0c48d2a1408eae36e4cac0376a3f8a7d9bc339b8894c2350712", table: "dc93397ad8328602012d01d24bda980f50fd970e5c6527855421685c2941e1ea" }),
  }),
});

/** 取某 profile 版本的冻结摘要;未冻结(如 standard)返回 undefined。 */
export function frozenToolManifest(id: string, version: number): FrozenToolManifest | undefined {
  return FROZEN_TOOL_MANIFESTS[id]?.[version];
}

/** 便于诊断:确认已冻结的 profile 版本集合。 */
export function frozenManifestVersions(): readonly string[] {
  return Object.entries(FROZEN_TOOL_MANIFESTS).flatMap(([id, versions]) =>
    Object.keys(versions).map((version) => `${id}@${version}`));
}
