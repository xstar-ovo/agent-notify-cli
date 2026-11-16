#!/usr/bin/env node
/**
 * 文件功能：npm bin 入口：转去执行编译后的 dist/cli.js。
 */
import("../dist/cli.js")
  .then((m) => m.main())
  .catch(() => process.exit(0));
