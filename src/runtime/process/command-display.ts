/** Security-authorized command label receipt；只保存脱敏且有界的 presentation。 */

import { canonicalDigest } from "../protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import type { AuthorizedCommandDisplayReceipt } from "./types.ts";

const KIND = "authorized_command_display" as const;
const MAX_LABEL_BYTES = 256;

export function createAuthorizedCommandDisplayReceipt(input: {
	readonly command: string;
	readonly requestDigest: RuntimeDigest;
	readonly constraintSnapshotDigest: RuntimeDigest;
}): AuthorizedCommandDisplayReceipt {
	const display = boundedCommandLabel(redactCommandSecrets(input.command));
	const body = {
		kind: KIND,
		label: display.label,
		truncated: display.truncated,
		commandDigest: runtimeDigest(input.command),
		requestDigest: input.requestDigest,
		constraintSnapshotDigest: input.constraintSnapshotDigest,
	};
	return { ...body, receiptDigest: runtimeDigest(body) };
}

export function validateAuthorizedCommandDisplayReceipt(
	receipt: AuthorizedCommandDisplayReceipt,
	expected: { readonly requestDigest: RuntimeDigest; readonly constraintSnapshotDigest?: RuntimeDigest },
): boolean {
	if (
		receipt.kind !== KIND ||
		receipt.label.length === 0 ||
		Buffer.byteLength(receipt.label, "utf8") > MAX_LABEL_BYTES ||
		/[\u0000-\u001f\u007f]/u.test(receipt.label) ||
		receipt.requestDigest.digest !== expected.requestDigest.digest ||
		expected.constraintSnapshotDigest === undefined ||
		receipt.constraintSnapshotDigest.digest !== expected.constraintSnapshotDigest.digest
	) return false;
	const { receiptDigest, ...body } = receipt;
	return receiptDigest.digest === canonicalDigest(body);
}

function redactCommandSecrets(command: string): string {
	const withoutAssignments = command.replace(
		/(^|\s)([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|[^\s]*)/giu,
		(_match, prefix: string, name: string) => `${prefix}${name}=[redacted]`,
	);
	return withoutAssignments.replace(
		/(--?(?:token|secret|password|passwd|api[-_]?key|credential|authorization))(?:=|\s+)(?:'[^']*'|"[^"]*"|[^\s]*)/giu,
		(_match, flag: string) => `${flag}=[redacted]`,
	).replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim() || "command";
}

function boundedCommandLabel(label: string): { readonly label: string; readonly truncated: boolean } {
	if (Buffer.byteLength(label, "utf8") <= MAX_LABEL_BYTES) return { label, truncated: false };
	let output = "";
	for (const character of label) {
		if (Buffer.byteLength(`${output}${character}…`, "utf8") > MAX_LABEL_BYTES) break;
		output += character;
	}
	return { label: `${output}…`, truncated: true };
}
