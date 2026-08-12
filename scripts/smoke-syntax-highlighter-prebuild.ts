/** Node/Bun/clean-consumer 共同调用的 installed optional-package smoke。 */

import { loadNativeSyntaxAddon } from "../src/tui/highlight/native-loader.ts";

const availability = loadNativeSyntaxAddon();
if (!availability.ok) throw new Error(availability.reason);
const result = await availability.addon.highlightAsync("const audit = true;", "javascript", "catppuccin-mocha");
if (!result.ok || result.lines.length !== 1) throw new Error(result.ok ? "invalid smoke result" : result.reason);
process.stdout.write(`syntax-highlighter-smoke:${availability.info.engineBuildId}\n`);
