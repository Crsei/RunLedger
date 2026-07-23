/**
 * 动态资源 adapter ports。
 *
 * 所有参数均为可序列化合同；实现方式可以是内存 adapter、扩展控制面或远程
 * 服务，但本层不规定文件扫描、transport、runner、安装或进程生命周期。
 */

import type {
	ResourceCancellationRequest,
	ResourceCancellationResult,
	ResourceClaimDerivationResult,
	ResourceEventEmissionRequest,
	ResourceEventEmissionResult,
	ResourceFacetReadRequest,
	ResourceFacetReadResult,
	ResourceHookTransformRequest,
	ResourceHookTransformResult,
	ResourceResolveRequest,
	ResourceResolveResult,
	ResourceSearchRequest,
	ResourceSearchResult,
	ResourceSnapshotAcquireRequest,
	ResourceSnapshotAcquireResult,
	ResourceSnapshotReleaseRequest,
	ResourceSnapshotReleaseResult,
	RuntimeToolInvocation,
	RuntimeResourceInvocationFrame,
	RuntimeToolInvocationRequest,
} from "./types.ts";

export interface RuntimeResourceCatalogPort {
	validateLocator(request: ResourceLocatorValidationRequest): Promise<ResourceLocatorValidationResult>;
	resolveExact(request: ResourceResolveRequest): Promise<ResourceResolveResult>;
	search(request: ResourceSearchRequest): Promise<ResourceSearchResult>;
}

export interface ResourceLocatorValidationRequest {
	canonicalLocator: string;
	sourceRoot: string;
}

export type ResourceLocatorValidationResult =
	| { status: "valid"; canonicalLocator: string; containmentDigest: string }
	| { status: "rejected"; reasonDigest: string };

export interface RuntimeResourceFacetReadPort {
	readFacet(request: ResourceFacetReadRequest, signal?: AbortSignal): Promise<ResourceFacetReadResult>;
}

/** raw input 到 canonical input/trusted claims 的唯一中立切点。 */
export interface RuntimeResourceClaimDerivationPort {
	canonicalizeAndDerive(
		request: RuntimeToolInvocationRequest,
		signal?: AbortSignal,
	): Promise<ResourceClaimDerivationResult>;
}

export interface RuntimeResourceHookTransformPort {
	transform(
		request: ResourceHookTransformRequest,
		signal?: AbortSignal,
	): Promise<ResourceHookTransformResult>;
}

/** invoke 不接受 raw input，也不接受调用者自报 claims。 */
export interface RuntimeResourceInvocationPort {
	invoke(invocation: RuntimeToolInvocation, signal?: AbortSignal): AsyncIterable<RuntimeResourceInvocationFrame>;
	cancel(request: ResourceCancellationRequest): Promise<ResourceCancellationResult>;
}

export interface RuntimeResourceEventSink {
	emit(request: ResourceEventEmissionRequest): Promise<ResourceEventEmissionResult>;
}

export interface RuntimeResourceSnapshotProvider {
	acquire(request: ResourceSnapshotAcquireRequest): Promise<ResourceSnapshotAcquireResult>;
	release(request: ResourceSnapshotReleaseRequest): Promise<ResourceSnapshotReleaseResult>;
}
