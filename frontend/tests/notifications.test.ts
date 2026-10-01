import test from "node:test";
import assert from "node:assert/strict";
import { effectScope, ref } from "vue";
import type { Push, PushOptions, PushParameter } from "notivue";
import { useFeedback } from "../src/lib/notifications.ts";

function harness() {
  const calls: {
    type: string;
    options: PushOptions;
    cleared: number;
    destroyed: number;
  }[] = [];
  function send(type: string, parameter: PushParameter) {
    const entry = {
      type,
      options:
        typeof parameter === "string"
          ? { message: parameter }
          : (parameter as PushOptions),
      cleared: 0,
      destroyed: 0,
    };
    calls.push(entry);
    return { clear: () => entry.cleared++, destroy: () => entry.destroyed++ };
  }
  const dispatcher: Pick<Push, "error" | "success" | "warning" | "promise"> = {
    error: (parameter) => send("error", parameter),
    success: (parameter) => send("success", parameter),
    warning: (parameter) => send("warning", parameter),
    promise: (parameter) => ({
      ...send("promise", parameter),
      resolve: (parameter) => send("success", parameter),
      success: (parameter) => send("success", parameter),
      reject: (parameter) => send("error", parameter),
      error: (parameter) => send("error", parameter),
    }),
  };
  return { calls, dispatcher, scope: effectScope() };
}

test("notifications dispatch one scoped message instead of duplicated inline errors", () => {
  const { scope, dispatcher, calls } = harness();
  const error = ref("");
  scope.run(() => useFeedback({ error }, dispatcher));
  error.value = "保存失败";
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.type, "error");
  error.value = "";
  assert.equal(calls[0]!.cleared, 1);
  error.value = "保存失败";
  assert.equal(calls.length, 2);
  scope.stop();
  assert.equal(calls[1]!.cleared, 1);
});

test("pending notifications are destroyed on completion and view disposal", () => {
  const { scope, dispatcher, calls } = harness();
  const pending = ref("正在导入");
  scope.run(() => useFeedback({ pending }, dispatcher));
  assert.equal(calls[0]!.type, "promise");
  pending.value = "";
  assert.equal(calls[0]!.destroyed, 1);
  pending.value = "正在保存";
  scope.stop();
  assert.equal(calls[1]!.destroyed, 1);
  pending.value = "卸载后不应提醒";
  assert.equal(calls.length, 2);
});

test("warnings are separate from success messages and clear when their context ends", () => {
  const { scope, dispatcher, calls } = harness();
  const success = ref(""),
    warning = ref("");
  scope.run(() => useFeedback({ success, warning }, dispatcher));
  success.value = "已保存";
  success.value = "";
  warning.value = "授权前请核对";
  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["success", "warning"],
  );
  scope.stop();
  assert.equal(calls[0]!.cleared, 0);
  assert.equal(calls[1]!.cleared, 1);
});

test("error notifications preserve retry actions without executing them automatically", async () => {
  const { scope, dispatcher, calls } = harness();
  const error = ref("加载失败");
  let retries = 0;
  scope.run(() =>
    useFeedback(
      {
        error,
        errorAction: () => ({
          label: "重试",
          run: () => {
            retries++;
          },
        }),
      },
      dispatcher,
    ),
  );
  assert.equal(retries, 0);
  const action = calls[0]!.options.props!.action;
  assert.equal(action.label, "重试");
  await action.run();
  assert.equal(retries, 1);
  scope.stop();
});
