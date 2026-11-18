/**
 * 文件功能：真正执行生成的 OpenCode 服务端插件，验证事件分支的实际行为。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import * as ts from "typescript";
import { openCodePluginContent } from "../../src/setup/opencode.js";

function loadPlugin() {
  const source =
    openCodePluginContent() +
    "\nexport const __test = { handle, waitAt, children };\n";
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const calls: string[][] = [];
  const spawn = (_command: string, args: string[]) => {
    calls.push(args);
    return { on() {}, unref() {} };
  };
  const exports: Record<string, any> = {};
  const context = vm.createContext({
    exports,
    module: { exports },
    require: (id: string) => {
      if (id === "node:child_process") return { spawn };
      if (id === "node:fs") return { appendFileSync() {}, existsSync: () => true };
      if (id === "node:os") return os;
      if (id === "node:path") return path;
      throw new Error(`unexpected require: ${id}`);
    },
    process,
    console,
  });
  vm.runInContext(js, context);
  return { plugin: exports.__test, calls };
}

function event(type: string, data: Record<string, unknown>, base: string) {
  return { type, data, location: { directory: base } };
}

test("succeeded cancels a pending wait notification before pushing completion", () => {
  const { plugin, calls } = loadPlugin();
  const base = process.cwd();
  plugin.handle(event("permission.asked", { sessionID: "s" }, base), base);
  calls.length = 0;
  plugin.handle(event("session.execution.succeeded", { sessionID: "s" }, base), base);

  assert.ok(calls.some((args) => args.includes("oc:s:wait") && args.includes("cancel")));
  assert.ok(calls.some((args) => args.includes("settled")));
  assert.equal(plugin.waitAt.has("s"), false);
});

test("a subagent session is ignored even without session.created", () => {
  const { plugin, calls } = loadPlugin();
  const base = process.cwd();
  plugin.handle(event("session.created", { sessionID: "child", parentID: "parent" }, base), base);
  calls.length = 0;
  plugin.handle(event("permission.asked", { sessionID: "child" }, base), base);
  assert.equal(calls.length, 0);
});

test("failed does not send the provider error text", () => {
  const { plugin, calls } = loadPlugin();
  const base = process.cwd();
  plugin.handle(
    event("session.execution.failed", { sessionID: "s", error: { message: "sk-secret-key" } }, base),
    base,
  );
  assert.ok(!calls.flat().join(" ").includes("sk-secret-key"));
});

test("completed notification uses the session title, falling back to the reply text", () => {
  const { plugin, calls } = loadPlugin();
  const base = process.cwd();
  plugin.handle(event("session.execution.started", { sessionID: "s" }, base), base);
  plugin.handle(event("session.updated", { info: { sessionID: "s", title: "Refactor auth" } }, base), base);
  plugin.handle(event("session.text.ended", { sessionID: "s", text: "reply first sentence。" }, base), base);
  calls.length = 0;
  plugin.handle(event("session.execution.succeeded", { sessionID: "s" }, base), base);
  const titled = calls.find((args) => args.includes("settled"));
  assert.ok(titled, "发出完成通知");
  assert.match(titled![titled!.indexOf("--message") + 1], /Refactor auth/);
  assert.ok(!titled!.includes("reply first sentence。"));

  // 标题在空闲时异步到达（state 被 succeeded 删掉后又建回来），下一轮不能丢
  calls.length = 0;
  plugin.handle(event("session.updated", { info: { sessionID: "s", title: "Ship docs" } }, base), base);
  plugin.handle(event("session.execution.started", { sessionID: "s" }, base), base);
  plugin.handle(event("session.execution.succeeded", { sessionID: "s" }, base), base);
  const next = calls.find((args) => args.includes("settled"));
  assert.match(next![next!.indexOf("--message") + 1], /Ship docs/);

  // 标题异步晚到时退回回复首句
  calls.length = 0;
  plugin.handle(event("session.execution.started", { sessionID: "t" }, base), base);
  plugin.handle(event("session.text.ended", { sessionID: "t", text: "reply fallback。" }, base), base);
  plugin.handle(event("session.execution.succeeded", { sessionID: "t" }, base), base);
  const fallback = calls.find((args) => args.includes("settled"));
  assert.ok(fallback);
  assert.match(fallback![fallback!.indexOf("--message") + 1], /reply fallback/);
});
