/**
 * 文件功能：Bark 请求体、图标优先级与错误处理的测试（本地 stub 服务）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AgentNotifyConfig } from "../../src/config/schema.js";
import { normalize } from "../../src/config/schema.js";
import { sendBark } from "../../src/notify/bark.js";

async function withStub(
  handler: (body: any, url: string) => { status: number; json: unknown },
  fn: (cfg: AgentNotifyConfig) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { status, json } = handler(JSON.parse(raw || "{}"), req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const cfg = normalize({
    bark: { endpoint: `http://127.0.0.1:${port}/{device_key}`, deviceKey: "KEY123" },
    delayMs: { stop: 0 },
  });
  try {
    await fn(cfg);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("bark posts json to endpoint with key substituted", async () => {
  let seen: { url?: string; body?: any } = {};
  await withStub(
    (body, url) => {
      seen = { url, body };
      return { status: 200, json: { code: 200, message: "success" } };
    },
    async (cfg) => {
      await sendBark({ title: "任务完成", subtitle: "pi · demo", body: "改了 3 个文件" }, cfg);
    },
  );
  assert.equal(seen.url, "/KEY123");
  assert.deepEqual(seen.body, {
    title: "任务完成",
    subtitle: "pi · demo",
    body: "改了 3 个文件",
    group: "agent-notify",
    level: "active",
  });
});

test("bark omits subtitle when empty", async () => {
  const bodies: any[] = [];
  await withStub(
    (body) => {
      bodies.push(body);
      return { status: 200, json: { code: 200 } };
    },
    async (cfg) => {
      await sendBark({ title: "t", subtitle: "", body: "b" }, cfg);
    },
  );
  assert.equal("subtitle" in bodies[0], false);
});

test("bark adds icon: record icon wins over config icon", async () => {
  const bodies: any[] = [];
  await withStub(
    (body) => {
      bodies.push(body);
      return { status: 200, json: { code: 200 } };
    },
    async (cfg) => {
      const msg = { title: "t", subtitle: "s", body: "b" };
      const withIcon = { ...cfg, bark: { ...cfg.bark, icon: "https://example.com/cfg.png" } };
      await sendBark(msg, withIcon, "https://example.com/pi.png");
      await sendBark(msg, withIcon);
      await sendBark(msg, cfg);
    },
  );
  assert.equal(bodies[0].icon, "https://example.com/pi.png");
  assert.equal(bodies[1].icon, "https://example.com/cfg.png");
  assert.equal("icon" in bodies[2], false);
});

test("bark throws on non-200 body code", async () => {
  await withStub(
    () => ({ status: 200, json: { code: 400, message: "bad key" } }),
    async (cfg) => {
      await assert.rejects(() => sendBark({ title: "t", subtitle: "s", body: "b" }, cfg), /code=400/);
    },
  );
});

test("bark throws on http error", async () => {
  await withStub(
    () => ({ status: 500, json: {} }),
    async (cfg) => {
      await assert.rejects(() => sendBark({ title: "t", subtitle: "s", body: "b" }, cfg), /status=500/);
    },
  );
});
