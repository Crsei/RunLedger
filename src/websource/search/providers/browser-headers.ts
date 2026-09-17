// A fallback desktop Mac Chrome navigation fingerprint matching
// the previous static default setup for deterministic or non-randomized calls.
const CHROME_FALLBACK_HEADERS: Record<string, string> = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "max-age=0",
	Priority: "u=0, i",
	"Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"macOS"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

/**
 * Build a desktop navigation fingerprint for one HTTP request.
 *
 * 上游用 `HeaderGenerator` 在多个浏览器画像间随机化。RunLedger 未移植该生成器
 * (它属 pi-utils 的指纹伪装面),因此统一返回稳定的 Mac Chrome 画像:凭据无关的
 * HTML 引擎仍带完整导航头,但不再随机化。`randomized` 参数保留以维持调用方签名。
 */
export function buildBrowserNavigationHeaders(_options?: { randomized?: boolean }): Record<string, string> {
	return { ...CHROME_FALLBACK_HEADERS };
}
