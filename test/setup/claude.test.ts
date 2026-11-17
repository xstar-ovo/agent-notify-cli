/**
 * 文件功能：Claude Code hooks 合并、幂等、卸载和配置保护测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_STATUSLINE_PATH, claudeAckContent, claudeHooksPreview, claudeHooksStatus, claudeStatuslineContent, isOurStatuslineCommand, mergeClaudeHooks, stripClaudeHooks } from "../../src/setup/claude.js";

function hooksOf(settings: any): any {
  return settings.hooks;
}

function commandsOf(settings: any, event: string): string[] {
  return (hooksOf(settings)[event] ?? []).flatMap((group: any) =>
    (group.hooks ?? []).map((hook: any) => hook.command));
}

test("claude hooks cover stop, permission prompt and prompt submit", () => {
  const merged = mergeClaudeHooks({});
  assert.deepEqual(Object.keys(hooksOf(merged)), ["Stop", "Notification", "UserPromptSubmit"]);

  assert.equal(commandsOf(merged, "Stop").length, 1);
  assert.match(commandsOf(merged, "Stop")[0], /--agent claude notify stop --stdin-json/);
  assert.equal(hooksOf(merged).Notification[0].matcher, "permission_prompt");
  assert.match(commandsOf(merged, "Notification")[0], /notify notification/);
  // --icon 是签名的一部分：缺了会让 doctor 报 outdated，测试必须锁住。
  for (const event of ["Stop", "Notification"]) {
    assert.match(commandsOf(merged, event)[0], /--icon "?https:\/\/img\.cdn1\.vip\/i\/[^"\s]+/);
  }
  assert.match(commandsOf(merged, "UserPromptSubmit")[0], /--agent claude cancel --stdin-json/);
});

test("merge drops hooks written with the old CLI syntax", () => {
  const merged = mergeClaudeHooks({
    hooks: {
      SessionEnd: [{ hooks: [{ type: "command", command: '"node" "cli.js" --agent claude --cancel --stdin-json' }] }],
    },
  });
  assert.equal(merged.hooks.SessionEnd, undefined);
});

test("merge keeps hooks that are not ours", () => {
  const custom = 'agent-notify --agent claude notify settled --stdin-json';
  const foreign = 'my-other-tool --agent claude --stdin-json';
  const merged = mergeClaudeHooks({
    hooks: { SessionEnd: [{ hooks: [{ type: "command", command: custom }, { type: "command", command: foreign }] }] },
  });
  assert.deepEqual(commandsOf(merged, "SessionEnd"), [custom, foreign]);
  assert.deepEqual(commandsOf(stripClaudeHooks(merged).settings, "SessionEnd"), [custom, foreign]);
});

test("hooks status tells current from outdated and missing", () => {
  assert.equal(claudeHooksStatus({}), "missing");
  assert.equal(claudeHooksStatus(mergeClaudeHooks({})), "current");
  assert.equal(claudeHooksStatus({
    hooks: { Stop: [{ hooks: [{ type: "command", command: '"node" "cli.js" --agent claude --event stop --stdin-json' }] }] },
  }), "outdated");
  // 全局卸载 / 移动安装目录后 hooks 指向不存在的 cli.js：必须报 broken，而不是 current。
  assert.equal(claudeHooksStatus({
    hooks: { Stop: [{ hooks: [{ type: "command", command: '"node" "/nope/dist/cli.js" --agent claude notify stop --stdin-json' }] }] },
  }), "broken");
});

test("claude hook commands quote node and cli paths", () => {
  const command = commandsOf(mergeClaudeHooks({}), "Stop")[0];
  assert.match(command, /^".*node(\.exe)?" ".*cli\.js"/i);
  assert.match(command, /--agent claude/);
});

test("merge keeps user settings and existing hooks, and is idempotent", () => {
  const original = {
    model: "sonnet",
    env: { TOKEN: "secret" },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
      Custom: [{ hooks: [{ type: "command", command: "echo custom" }] }],
    },
  };
  const once = mergeClaudeHooks(original);
  const twice = mergeClaudeHooks(once);

  assert.equal(once.model, "sonnet");
  assert.deepEqual(once.env, { TOKEN: "secret" });
  assert.equal(commandsOf(once, "Stop").length, 2);
  assert.ok(commandsOf(once, "Stop").includes("echo user-hook"));
  assert.deepEqual(commandsOf(once, "Custom"), ["echo custom"]);
  assert.deepEqual(twice, once);
  assert.equal(original.hooks.Stop.length, 1, "input object must not be mutated");
});

test("merge refreshes our hook command when node or repo path changes", () => {
  const oldCommand = '"old-node" "old/dist/cli.js" --agent claude notify stop --stdin-json';
  const merged = mergeClaudeHooks({
    hooks: { Stop: [{ hooks: [{ type: "command", command: oldCommand, timeout: 30 }] }] },
  });
  const commands = commandsOf(merged, "Stop");
  assert.equal(commands.length, 1);
  assert.notEqual(commands[0], oldCommand);
  assert.match(commands[0], /cli\.js/);
  assert.equal(merged.hooks.Stop[0].hooks[0].timeout, 10);

  const oldNotification = '"old-node" "old/dist/cli.js" --agent claude notify notification --stdin-json';
  const withMatcher = mergeClaudeHooks({
    hooks: { Notification: [{ hooks: [{ type: "command", command: oldNotification }] }] },
  });
  assert.equal(withMatcher.hooks.Notification[0].matcher, "permission_prompt");
});

test("strip removes only our hooks and keeps user hooks", () => {
  const original = {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: "echo user-hook" },
            { type: "command", command: '"node" "cli.js" --agent claude notify stop --stdin-json' },
          ],
        },
      ],
      Notification: [
        { matcher: "permission_prompt", hooks: [{ type: "command", command: '"node" "cli.js" --agent claude --event notification --stdin-json' }] },
        { matcher: "idle_prompt", hooks: [{ type: "command", command: "echo idle" }] },
      ],
    },
  };
  const result = stripClaudeHooks(original);
  assert.equal(result.changed, true);
  assert.deepEqual(commandsOf(result.settings, "Stop"), ["echo user-hook"]);
  assert.deepEqual(commandsOf(result.settings, "Notification"), ["echo idle"]);
  assert.equal(result.settings.hooks.Notification[0].matcher, "idle_prompt");
  assert.equal(result.settings.hooks.Stop.length, 1);
});

test("strip removes empty event keys and reports no-op", () => {
  const onlyOurs = mergeClaudeHooks({});
  const removed = stripClaudeHooks(onlyOurs);
  assert.equal(removed.changed, true);
  assert.equal(removed.settings.hooks, undefined);

  const absent = stripClaudeHooks({ model: "sonnet" });
  assert.equal(absent.changed, false);
  assert.deepEqual(absent.settings, { model: "sonnet" });

  const empty = stripClaudeHooks({ hooks: { Stop: [] } });
  assert.equal(empty.changed, false);
  assert.deepEqual(empty.settings, { hooks: { Stop: [] } });
});

test("invalid settings shapes fail closed", () => {
  assert.throws(() => mergeClaudeHooks(null));
  assert.throws(() => mergeClaudeHooks({ hooks: [] }));
  assert.throws(() => mergeClaudeHooks({ hooks: { Stop: {} } }));
});

test("claude statusline is recognized after the node path changes", () => {
  assert.equal(isOurStatuslineCommand(`"old-node" "${CLAUDE_STATUSLINE_PATH}"`), true);
  assert.equal(isOurStatuslineCommand('"node" "other-statusline.cjs"'), false);
});

test("claude statusline keeps the original command and appends ours", () => {
  const src = claudeStatuslineContent('bash "old-statusline.sh"');
  assert.match(src, /ORIGINAL/);
  assert.match(src, /bash/);
  assert.match(src, /"_statusline"/);
  assert.match(src, /spawnSync/);
  assert.match(src, /original\?\.stdout/);
});

test("claude /ack is a stub intercepted by the user-prompt hook", () => {
  const src = claudeAckContent();
  assert.match(src, /disable-model-invocation: true/);
  assert.match(src, /取消待发通知/);
  assert.doesNotMatch(src, /CLAUDE_SESSION_ID|--stdin-json/);
});

test("preview contains hooks but not user settings", () => {
  const preview = claudeHooksPreview();
  assert.match(preview, /"hooks"/);
  assert.match(preview, /permission_prompt/);
  assert.doesNotMatch(preview, /env|secret|model/i);
});
