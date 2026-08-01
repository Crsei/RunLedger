/** 所有外部 adapter 共用的 identity/generation/config/trust/health 引用。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { RuntimeContentRefSchema, RuntimeDigestSchema } from "./foundation-schemas.ts";
import type { RuntimeContentRef, RuntimeDigest } from "./foundation.ts";

export interface AdapterIdentityRef {
	readonly adapterId: string;
	readonly generation: number;
	readonly configDigest: RuntimeDigest;
	readonly trustRef?: RuntimeContentRef;
	readonly healthRef?: RuntimeContentRef;
}

export const AdapterIdentityRefSchema = Type.Object(
	{
		adapterId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", minLength: 1, maxLength: 128 }),
		generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		configDigest: RuntimeDigestSchema,
		trustRef: Type.Optional(RuntimeContentRefSchema),
		healthRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export function isAdapterIdentityRef(value: unknown): value is AdapterIdentityRef {
	return Value.Check(AdapterIdentityRefSchema, value);
}
