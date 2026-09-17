/**
 * canonical event → `ExtensionEventProjection`（D5）。
 *
 * 扩展看不到 canonical event 本体，只看得到本层裁剪后的投影：
 *
 *   - 键取 descriptor 的**精确白名单**；未列出的键直接丢弃（只记键名，不记值）；
 *   - 即使同名出现在白名单，凭据形状的键也被硬性拒绝（纵深防御）；
 *   - 序列化后的 UTF-8 字节数必须落在 descriptor 与框架上限的较小者内，
 *     超限即拒绝，不截断——截断会让扩展基于残片做决策；
 *   - 投影不是事实源：owner 侧合成的结果必须再次通过 canonicalize/authorize。
 */

import { isExtensionEventName, extensionEventDescriptor } from "../../contracts/extensions/events.ts";
import type { ExtensionEventName, ExtensionEventProjection, ExtensionEventProjectionDescriptor } from "../../contracts/extensions/events.ts";
import { EXTENSION_CONTRACT_BOUNDS } from "../../contracts/extensions/common.ts";
import { redactDiagnosticText } from "../diagnostics.ts";

export type ExtensionProjectionCode =
	| "event_not_projected"
	| "payload_oversize"
	| "payload_field_rejected";

export interface ExtensionProjectionFailure {
	readonly code: ExtensionProjectionCode;
	readonly message: string;
	/** 被丢弃的键名（只记名字，绝不记值）。 */
	readonly droppedFields: readonly string[];
}

export type ExtensionProjectionResult =
	| { readonly ok: true; readonly projection: ExtensionEventProjection; readonly droppedFields: readonly string[] }
	| { readonly ok: false; readonly error: ExtensionProjectionFailure };

export interface ExtensionEventProjectionInput {
	readonly name: string;
	/** canonical 来源字段；只有 descriptor 白名单内的键会进入扩展载荷。 */
	readonly source: Readonly<Record<string, unknown>>;
	/** 框架级载荷上限；与 descriptor 上限取较小者。 */
	readonly maxPayloadBytes?: number;
}

/**
 * 凭据形状的键一律不得进入扩展载荷，即使某个 descriptor 误把它们列进白名单。
 * 这是与白名单并行的独立门禁，不是白名单的替代。
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
	"token",
	"accesstoken",
	"refreshtoken",
	"secret",
	"clientsecret",
	"credential",
	"credentials",
	"apikey",
	"authorization",
	"password",
	"cookie",
	"installpath",
	"nativepath",
	"absolutepath",
]);

function byteLength(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function isForbidden(key: string): boolean {
	return FORBIDDEN_PAYLOAD_KEYS.has(key.toLocaleLowerCase());
}

/** 只有 descriptor 白名单内的键与类型可进入载荷。 */
function clipPayload(
	descriptor: ExtensionEventProjectionDescriptor,
	source: Readonly<Record<string, unknown>>,
): { readonly payload: Record<string, unknown>; readonly dropped: readonly string[] } {
	const allowed = new Set(descriptor.payloadFields);
	const payload: Record<string, unknown> = {};
	const dropped: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		if (!allowed.has(key) || isForbidden(key) || value === undefined) {
			dropped.push(key);
			continue;
		}
		payload[key] = value;
	}
	return { payload, dropped: dropped.sort() };
}

/** 投影一个 canonical 事件。未注册的事件名是错误，不是空载荷。 */
export function projectExtensionEvent(input: ExtensionEventProjectionInput): ExtensionProjectionResult {
	if (!isExtensionEventName(input.name)) {
		return {
			ok: false,
			error: {
				code: "event_not_projected",
				message: `event is not in the extension projection whitelist: ${redactDiagnosticText(input.name)}`,
				droppedFields: [],
			},
		};
	}
	const name: ExtensionEventName = input.name;
	const descriptor = extensionEventDescriptor(name);
	if (descriptor === undefined) {
		return { ok: false, error: { code: "event_not_projected", message: "event descriptor is unavailable", droppedFields: [] } };
	}
	const clipped = clipPayload(descriptor, input.source);
	const projection: ExtensionEventProjection = {
		name,
		cancelable: descriptor.cancelable,
		resultKind: descriptor.resultKind,
		payload: clipped.payload,
	};
	const limit = Math.min(descriptor.payloadBytes, input.maxPayloadBytes ?? EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes);
	const bytes = byteLength(clipped.payload);
	if (bytes > limit) {
		return {
			ok: false,
			error: {
				code: "payload_oversize",
				message: `projected payload exceeds ${limit} bytes`,
				droppedFields: clipped.dropped,
			},
		};
	}
	return { ok: true, projection, droppedFields: clipped.dropped };
}
