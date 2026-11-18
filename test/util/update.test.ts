/**
 * 文件功能：版本比较（isNewer）与版本检查端到端——只查一次、写缓存、未过期不联网、失败静默。
 */

import { tmpRoot } from "../helpers/tmp-config.js"; // 先于 src：update.ts 在 import 时取 configDir
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkUpdate, isNewer } from "../../src/util/update.js";

const cacheFile = path.join(tmpRoot, "update-check.json");

test("isNewer 按 semver 三段比较", () => {
  assert.equal(isNewer("0.3.0", "0.2.9"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.2.0", "0.2.0"), false);
  assert.equal(isNewer("0.2.0", "0.3.0"), false);
  assert.equal(isNewer("0.2", "0.1.9"), true);
});

async function registry(body: unknown, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/latest`, close: () => new Promise((r) => server.close(() => r())) };
}

test("checkUpdate fetches, caches, and then trusts the cache", async () => {
  const reg = await registry({ version: "9.9.9" });
  try {
    assert.equal(await checkUpdate("0.0.0", reg.url), "9.9.9");
  } finally {
    await reg.close();
  }
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).latest, "9.9.9");

  // 缓存有效时不再联网：指向一个必然失败的地址也不会报错，也不会重新写缓存
  assert.equal(await checkUpdate("9.9.9", "http://127.0.0.1:1/latest"), undefined);
});

test("an expired cache is refreshed, and a failing registry stays silent", async () => {
  writeFileSync(cacheFile, JSON.stringify({ at: Date.now() - 48 * 60 * 60 * 1000, latest: "8.8.8" }));
  assert.equal(await checkUpdate("0.0.0", "http://127.0.0.1:1/latest"), undefined);

  const broken = await registry({}, 500);
  try {
    assert.equal(await checkUpdate("0.0.0", broken.url), undefined);
  } finally {
    await broken.close();
  }
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).latest, "8.8.8", "失败不该污染缓存");

  const reg = await registry({ version: "7.7.7" });
  try {
    assert.equal(await checkUpdate("0.0.0", reg.url), "7.7.7");
  } finally {
    await reg.close();
  }
});
