/**
 * 文件功能：脱敏测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../../src/util/redact.js";

test("redact 遮掉 URL 里的 key、bot token、device_key", () => {
  assert.equal(redact("https://api.day.app/abcdefghijklmnopqrstuv"), "https://api.day.app/***");
  assert.equal(redact("https://api.telegram.org/bot123456:ABCdefGhIJKlmnOPQrStUvWxYz012345678/sendMessage"), "https://api.telegram.org/bot***/sendMessage");
  assert.equal(redact('{"deviceKey": "abcdef123456"}'), '{"deviceKey":"***"}');
  assert.equal(redact("https://x.dev/push?device_key=abc123&x=1"), "https://x.dev/push?device_key=***&x=1");
});
