/** OTel metrics 是运行观测，不替代 durable ledger 审计。 */

import type { Meter, Counter, Histogram } from "@opentelemetry/api";

export class ExtensionMetrics {
	readonly #operations: Counter;
	readonly #failures: Counter;
	readonly #duration: Histogram;

	public constructor(meter: Meter) {
		this.#operations = meter.createCounter("runledger.extensions.operations", { description: "Extension lifecycle and invocation operations" });
		this.#failures = meter.createCounter("runledger.extensions.failures", { description: "Extension failures" });
		this.#duration = meter.createHistogram("runledger.extensions.duration", { unit: "ms", description: "Extension operation duration" });
	}

	public record(input: { kind: "plugin" | "skill" | "hook" | "mcp"; operation: string; ok: boolean; durationMs: number }): void {
		const attributes = { "extension.kind": input.kind, "extension.operation": input.operation };
		this.#operations.add(1, attributes);
		if (!input.ok) this.#failures.add(1, attributes);
		this.#duration.record(input.durationMs, attributes);
	}
}
