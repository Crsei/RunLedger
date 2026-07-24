export interface MarketplaceLocator {
	schemaVersion: 1;
	packageName: string;
	version: string;
	publisherId: string;
	sourceUrl: string;
	format: "tgz";
	expectedDigest: string;
	signature: {
		algorithm: "Ed25519";
		value: string;
	};
}

export interface MarketplaceDownloadReceipt {
	stagedRoot: string;
	bytes: number;
	digest: string;
	sourceUrl: string;
	downloadReceiptId: string;
}

export interface MarketplaceVerificationReceipt {
	signatureValid: boolean;
	publisherTrusted: boolean;
	publisherRevision: number;
	verificationReceiptId: string;
}

export interface MarketplaceProbeReceipt {
	ok: boolean;
	manifestDigest: string;
	capabilityDigest: string;
	containsExecutableResources: boolean;
	packageName?: string;
	version?: string;
	fileCount?: number;
	totalBytes?: number;
	probeReceiptId: string;
}

export interface MarketplaceActivationReceipt {
	packageName: string;
	version: string;
	digest: string;
	previousVersion?: string;
	activationReceiptId: string;
}

export interface MarketplaceDownloadPort {
	downloadToStaging(locator: MarketplaceLocator, options: { maxBytes: number; requireHttps: true }, signal?: AbortSignal): Promise<MarketplaceDownloadReceipt>;
	cleanupStaging?(stagedRoot: string): Promise<void>;
}

export interface MarketplaceNetworkReceipt {
	body: Uint8Array;
	finalUrl: string;
	redirectChain: readonly string[];
	networkReceiptId: string;
}

export interface MarketplaceNetworkPort {
	download(input: {
		url: string;
		maxBytes: number;
		allowedHost: string;
		maxRedirects: number;
	}, signal?: AbortSignal): Promise<MarketplaceNetworkReceipt>;
}

export interface PublisherTrustEntry {
	publisherId: string;
	publicKeyPem: string;
	revision: number;
	trustedAt: string;
	revokedAt?: string;
}

export interface PublisherTrustPort {
	resolve(publisherId: string): Promise<PublisherTrustEntry | undefined>;
}

export interface MarketplaceSignaturePort {
	verify(locator: MarketplaceLocator, download: MarketplaceDownloadReceipt, signal?: AbortSignal): Promise<MarketplaceVerificationReceipt>;
}

export interface MarketplaceProbePort {
	probe(stagedRoot: string, options: { maxFiles: number; maxBytes: number; sandboxProfile: "strict" }, signal?: AbortSignal): Promise<MarketplaceProbeReceipt>;
}

export interface PluginVersionStorePort {
	stageVerified(input: { locator: MarketplaceLocator; download: MarketplaceDownloadReceipt; verification: MarketplaceVerificationReceipt; probe: MarketplaceProbeReceipt }, signal?: AbortSignal): Promise<string>;
	activate(packageName: string, version: string, digest: string, signal?: AbortSignal): Promise<MarketplaceActivationReceipt>;
	active(packageName: string): Promise<MarketplaceActivationReceipt | undefined>;
	uninstall(packageName: string, expectedVersion: string, signal?: AbortSignal): Promise<boolean>;
	rollback(packageName: string, expectedCurrentVersion: string, signal?: AbortSignal): Promise<MarketplaceActivationReceipt | undefined>;
}

export interface MarketplaceApprovalReceipt {
	receiptId: string;
	packageName: string;
	version: string;
	digest: string;
	capabilityDigest: string;
	profile: "metadata-only" | "execute-enabled";
	approvedAt: string;
	expiresAt: string;
}

export interface MarketplaceApprovalPort {
	authorize(input: { locator: MarketplaceLocator; probe: MarketplaceProbeReceipt; operation: "install" | "update" }, signal?: AbortSignal): Promise<MarketplaceApprovalReceipt | undefined>;
}
