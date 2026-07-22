/** Runtime v3 stream/cursor/revision 的无领域依赖 exact schema。 */

import { Type } from "typebox";

const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const RuntimeEventStreamRefSchema = Type.Union([
	Type.Object(
		{
			scope: Type.Literal("session"),
			streamId: runtimeId("eventStream"),
			sessionId: runtimeId("session"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			scope: Type.Literal("authority_tenant"),
			streamId: runtimeId("eventStream"),
		},
		{ additionalProperties: false },
	),
]);

export const EventCursorSchema = Type.Object(
	{
		stream: RuntimeEventStreamRefSchema,
		sequence: revision,
		eventId: runtimeId("event"),
		eventHash: digest,
	},
	{ additionalProperties: false },
);

export const ExpectedRevisionSchema = Type.Object(
	{
		stream: RuntimeEventStreamRefSchema,
		sequence: revision,
		eventHash: digest,
	},
	{ additionalProperties: false },
);
