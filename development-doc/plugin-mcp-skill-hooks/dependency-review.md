# Extension runtime dependency review

Review date: 2026-07-24

The extension implementation pins the following direct runtime dependencies. The versions are intentionally exact so parser and transport behavior cannot drift through a lockfile refresh.

| Package | Version | License | Registry integrity |
|---|---:|---|---|
| `@modelcontextprotocol/sdk` | `1.29.0` | MIT | `sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==` |
| `@opentelemetry/api` | `1.9.0` | Apache-2.0 | `sha512-3giAOQvZiH5F9bMlMiv8+GSPMeqg0dbaeo58/0SlA9sxSqZhnUtxzX9/2FzyhS9sWQf5S0GJE0AKBrFqjpeYcg==` |
| `yaml` | `2.8.3` | ISC | `sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==` |
| `semver` | `7.7.4` | ISC | `sha512-vFKC2IEtQnVhpT78h1Yp8wzwrf8CM+MzKMHGJZfBtzhZNycRFnXsHk6E5TxIkkMsgNS7mdX3AGB7x2QM2di4lA==` |
| `@types/semver` | `7.7.1` | MIT | `sha512-FmgJfu+MOcQ370SD0ev7EI8TlCAfKYU+B4m5T3yXc1CiRN94g/SZPtsCkk506aUDtlMnFZvasDwHHUcZUEaYuA==` |

Selection notes:

- `@modelcontextprotocol/sdk` is the official TypeScript SDK and matches the inspected `claude-code-bun` snapshot's current major/minor line. RunLedger uses its stdio and Streamable HTTP clients, not an ad-hoc MCP protocol implementation.
- `yaml` is used for bounded `SKILL.md` frontmatter parsing. Parsing remains schema-validated and does not execute tags or source code.
- `semver` validates Plugin manifests with strict SemVer; no best-effort or coercing fallback is allowed.
- `@opentelemetry/api` only emits bounded counters/histograms. It is not an audit sink and cannot replace canonical Runtime v3 events.

`npm audit` after installation reports eight advisories. Two groups are relevant to this dependency change:

- `@modelcontextprotocol/sdk@1.29.0` currently resolves `@hono/node-server@1.19.14`, whose advisory concerns the Hono static-file server on Windows. RunLedger does not import or register that server adapter; MCP HTTP support is client-only and loopback/allowlist constrained. This remains a tracked upstream risk rather than being hidden by a forced incompatible major override.
- The SDK is also present through the pre-existing `@google/genai` dependency, which npm reports as a moderate dependency relationship rather than a concrete `@google/genai` advisory.

The remaining Vitest/Vite findings are pre-existing development-server advisories. The repository invokes `vitest run` and does not expose Vitest UI or a Vite development server. They are not silently auto-fixed here because npm proposes a major Vitest upgrade; that upgrade requires its own compatibility review and full-suite evidence.
