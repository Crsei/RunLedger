import type { TraceEvent, TraceTreeNode } from "./types.ts";

interface MutableNode {
	readonly traceId: string;
	readonly nodeId: string;
	readonly parentNodeId: string | null;
	firstEvent: TraceEvent;
	lastEvent: TraceEvent;
}

function key(traceId: string, nodeId: string): string {
	return `${traceId}\u0000${nodeId}`;
}

export class TraceTreeProjection {
	readonly #nodes = new Map<string, MutableNode>();
	readonly #events = new Map<string, TraceEvent>();

	public apply(event: TraceEvent): void {
		const prior = this.#events.get(event.eventId);
		if (prior) {
			if (prior.eventHash !== event.eventHash) throw new Error(`event id ${event.eventId} has conflicting content`);
			return;
		}
		if (event.nodeId === event.parentNodeId) throw new Error("trace node cannot parent itself");
		this.#events.set(event.eventId, event);
		const nodeKey = key(event.traceId, event.nodeId);
		const current = this.#nodes.get(nodeKey);
		if (!current) {
			this.#nodes.set(nodeKey, {
				traceId: event.traceId,
				nodeId: event.nodeId,
				parentNodeId: event.parentNodeId,
				firstEvent: event,
				lastEvent: event,
			});
			return;
		}
		if (current.parentNodeId !== event.parentNodeId) throw new Error(`trace node ${event.nodeId} changed parent`);
		if (event.sequence >= current.lastEvent.sequence) current.lastEvent = event;
	}

	public tree(traceId: string): TraceTreeNode | undefined {
		const roots = this.#nodesFor(traceId).filter((node) => node.parentNodeId === null);
		if (roots.length !== 1) return undefined;
		return this.#materialize(roots[0]!, traceId, new Set<string>());
	}

	public orphans(traceId: string): readonly TraceTreeNode[] {
		const nodes = this.#nodesFor(traceId);
		return nodes
			.filter((node) => node.parentNodeId !== null && !this.#nodes.has(key(traceId, node.parentNodeId)))
			.sort((left, right) => left.firstEvent.sequence - right.firstEvent.sequence)
			.map((node) => this.#materialize(node, traceId, new Set<string>()));
	}

	#nodesFor(traceId: string): MutableNode[] {
		return [...this.#nodes.values()].filter((node) => node.traceId === traceId);
	}

	#materialize(node: MutableNode, traceId: string, pathNodes: Set<string>): TraceTreeNode {
		if (pathNodes.has(node.nodeId)) throw new Error(`trace tree contains a cycle at ${node.nodeId}`);
		const nextPath = new Set(pathNodes).add(node.nodeId);
		const children = this.#nodesFor(traceId)
			.filter((candidate) => candidate.parentNodeId === node.nodeId)
			.sort((left, right) => left.firstEvent.sequence - right.firstEvent.sequence)
			.map((candidate) => this.#materialize(candidate, traceId, nextPath));
		const event = node.lastEvent;
		return {
			traceId,
			nodeId: node.nodeId,
			parentNodeId: node.parentNodeId,
			kind: event.kind,
			name: event.name,
			phase: event.phase,
			timestamp: node.firstEvent.timestamp,
			...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			...(event.inputContent === undefined ? {} : { inputContent: event.inputContent }),
			...(event.outputContent === undefined ? {} : { outputContent: event.outputContent }),
			...(event.usage === undefined ? {} : { usage: event.usage }),
			...(event.cost === undefined ? {} : { cost: event.cost }),
			...(event.error === undefined ? {} : { error: event.error }),
			...(event.metadata === undefined ? {} : { metadata: event.metadata }),
			...(event.observation === undefined ? {} : { observation: event.observation }),
			children,
		};
	}
}
