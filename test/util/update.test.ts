/**
 * 文件功能：版本比较测试（新版本提示的判定核心）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer } from "../../src/util/update.js";

test("isNewer 按 semver 三段比较", () => {
  assert.equal(isNewer("0.3.0", "0.2.9"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.2.0", "0.2.0"), false);
  assert.equal(isNewer("0.2.0", "0.3.0"), false);
  assert.equal(isNewer("0.2", "0.1.9"), true);
});
