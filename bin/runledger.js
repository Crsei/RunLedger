#!/usr/bin/env node
/**
 * `runledger` CLI shim —— 加载 TypeScript 编译后的 dist/cli/cli.js。
 *
 * npm link / npm install -g 只注册这个稳定入口;运行时不依赖 tsx 或 src/。
 * 发布或重新链接前必须先执行 npm run build。
 */

import "../dist/cli/cli.js";
