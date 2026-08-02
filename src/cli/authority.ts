/** CLI 位置 authority 的 fail-closed 检查。 */

export function validateLegacyCliEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	if (env.RUNLEDGER_SESSION_DIR !== undefined && env.RUNLEDGER_SESSION_DIR.length > 0) {
		return "unsupported_environment_override: RUNLEDGER_SESSION_DIR 已拒绝;请使用预创建的 RUNLEDGER_DIR";
	}
	return undefined;
}
