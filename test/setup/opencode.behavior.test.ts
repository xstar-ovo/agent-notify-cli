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
