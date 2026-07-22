/** workspace fencing-token secret 的 CAS store；registry 只保存 digest/ref。 */

import type { WorkspaceId } from "../runtime/protocol/v3/ids.ts";
import type { WorkspaceLeaseMutationPort, WorkspaceLeaseSecret } from "./ports.ts";

export class MemoryWorkspaceLeaseMutationPort implements WorkspaceLeaseMutationPort {
	readonly #leases = new Map<WorkspaceId, WorkspaceLeaseSecret>();

	public async read(workspaceId: WorkspaceId): Promise<WorkspaceLeaseSecret | undefined> {
		const value = this.#leases.get(workspaceId);
		return value ? structuredClone(value) : undefined;
	}

	public async create(secret: WorkspaceLeaseSecret): Promise<"applied" | "conflict"> {
		if (this.#leases.has(secret.record.workspaceId)) return "conflict";
		this.#leases.set(secret.record.workspaceId, structuredClone(secret));
		return "applied";
	}

	public async compareAndSwap(
		workspaceId: WorkspaceId,
		expectedRevision: number,
		next: WorkspaceLeaseSecret,
	): Promise<"applied" | "conflict"> {
		const current = this.#leases.get(workspaceId);
		if (!current || current.record.leaseRevision !== expectedRevision || next.record.workspaceId !== workspaceId) return "conflict";
		this.#leases.set(workspaceId, structuredClone(next));
		return "applied";
	}

	public async remove(workspaceId: WorkspaceId, expectedRevision: number): Promise<"applied" | "conflict" | "not_found"> {
		const current = this.#leases.get(workspaceId);
		if (!current) return "not_found";
		if (current.record.leaseRevision !== expectedRevision) return "conflict";
		this.#leases.delete(workspaceId);
		return "applied";
	}
}
