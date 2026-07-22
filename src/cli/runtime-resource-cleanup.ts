/** CLI 退出时等待全部独立资源，并保留每个 cleanup failure。 */

function flattenCleanupFailure(failure: unknown): unknown[] {
	if (!(failure instanceof AggregateError)) return [failure];
	return failure.errors.flatMap((nested) => flattenCleanupFailure(nested));
}

export async function closeCliRuntimeResources(
	operations: readonly (() => Promise<void>)[],
): Promise<void> {
	const settled = await Promise.allSettled(operations.map(async (operation) => operation()));
	const failures = settled.flatMap((result) =>
		result.status === "rejected" ? flattenCleanupFailure(result.reason) : []);
	if (failures.length === 0) return;
	if (failures.length === 1) throw failures[0];
	throw new AggregateError(failures, "CLI runtime resource cleanup failed");
}
