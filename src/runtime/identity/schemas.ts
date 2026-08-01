/** Runtime identity contract 的 exact TypeBox schema 与 runtime guard。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { CanonicalUtcTimestampSchema, RuntimeContentRefSchema, isCanonicalUtcTimestamp } from "../protocol/foundation-schemas.ts";
import type { IdentityContext } from "./types.ts";

const AuthorityIdSchema = Type.String({ pattern: "^authority_[A-Za-z0-9._~-]{1,128}$", maxLength: 138 });
const TenantIdSchema = Type.String({ pattern: "^tenant_[A-Za-z0-9._~-]{1,128}$", maxLength: 135 });
const PrincipalIdSchema = Type.String({ pattern: "^principal_[A-Za-z0-9._~-]{1,128}$", maxLength: 138 });

const LocalIdentityContextSchema = Type.Object(
	{
		authorityId: AuthorityIdSchema,
		tenantId: TenantIdSchema,
		principalId: PrincipalIdSchema,
		principalKind: Type.Literal("local"),
		issuedAt: CanonicalUtcTimestampSchema,
		authenticationRef: Type.Optional(RuntimeContentRefSchema),
		attestationRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

const ServiceIdentityContextSchema = Type.Object(
	{
		authorityId: AuthorityIdSchema,
		tenantId: TenantIdSchema,
		principalId: PrincipalIdSchema,
		principalKind: Type.Literal("service"),
		issuedAt: CanonicalUtcTimestampSchema,
		authenticationRef: RuntimeContentRefSchema,
		attestationRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

const RemoteIdentityContextSchema = Type.Object(
	{
		authorityId: AuthorityIdSchema,
		tenantId: TenantIdSchema,
		principalId: PrincipalIdSchema,
		principalKind: Type.Literal("remote"),
		issuedAt: CanonicalUtcTimestampSchema,
		authenticationRef: RuntimeContentRefSchema,
		attestationRef: RuntimeContentRefSchema,
	},
	{ additionalProperties: false },
);

export const IdentityContextSchema = Type.Union([
	LocalIdentityContextSchema,
	ServiceIdentityContextSchema,
	RemoteIdentityContextSchema,
]);

export function isIdentityContext(value: unknown): value is IdentityContext {
	if (!Value.Check(IdentityContextSchema, value)) return false;
	return isCanonicalUtcTimestamp(value.issuedAt);
}
