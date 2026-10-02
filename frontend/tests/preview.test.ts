import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openMailPreview, receiveMailPreview } from "../src/lib/preview.ts";
import { setLocale } from "../src/lib/i18n.ts";

function browser(t: TestContext, blocked = false) {
  const channels: Channel[] = [];
  class Channel {
    closed = false;
    onmessage?: (event: { data: unknown }) => void;
    constructor(public name: string) {
      channels.push(this);
    }
    postMessage(data: unknown) {
      for (const channel of channels)
        if (channel !== this && !channel.closed && channel.name === this.name)
          queueMicrotask(() => {
            if (!channel.closed)
              channel.onmessage?.({ data: structuredClone(data) });
          });
    }
    close() {
      this.closed = true;
    }
  }
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalChannel = globalThis.BroadcastChannel;
  const tab = { opener: {} as unknown };
  const urls: string[] = [];
  const fakeWindow = {
    location: { hash: "" },
    open: (url: string) => {
      urls.push(url);
      return blocked ? null : tab;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  globalThis.BroadcastChannel = Channel as unknown as typeof BroadcastChannel;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.tick(60 * 60 * 1000);
    globalThis.BroadcastChannel = originalChannel;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return { channels, tab, urls, window: fakeWindow };
}

test("a preview tab receives an opening snapshot without including email content in its URL and can refresh it", async (t) => {
  setLocale("en");
  const state = browser(t);
  const content = {
    subject: "Private subject",
    html: "<p>Private body</p>",
    sample: 3,
    dark: true,
  };
  openMailPreview(content);
  assert.match(state.urls[0], /^\/preview\.html#[\da-f-]{36}$/i);
  assert.equal(state.tab.opener, null);
  state.window.location.hash = "#" + state.urls[0].split("#")[1];
  content.html = "Changed after opening";
  for (let refresh = 0; refresh < 2; refresh++) {
    const received = await new Promise((resolve, reject) => {
      receiveMailPreview(resolve, () => reject(Error("Unexpected expiry")));
    });
    assert.deepEqual(received, {
      subject: "Private subject",
      html: "<p>Private body</p>",
      sample: 3,
      dark: true,
      locale: "en",
    });
  }
});

test("blocked tabs release their content channel and show a recoverable error", (t) => {
  const state = browser(t, true);
  assert.throws(
    () => openMailPreview({ subject: "Test", html: "Body" }),
    /blocked/,
  );
  assert.equal(state.channels[0].closed, true);
});

test("missing source channels and invalid preview IDs resolve to expiry", (t) => {
  const state = browser(t);
  let expired = 0;
  receiveMailPreview(
    () => assert.fail("Unexpected content"),
    () => expired++,
  );
  assert.equal(expired, 1);
  state.window.location.hash = "#" + crypto.randomUUID();
  receiveMailPreview(
    () => assert.fail("Unexpected content"),
    () => expired++,
  );
  t.mock.timers.tick(5000);
  assert.equal(expired, 2);
  assert.equal(state.channels[0].closed, true);
});
