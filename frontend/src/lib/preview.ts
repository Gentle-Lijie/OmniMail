import { message, i18n, type Locale } from "./i18n";

export interface PreviewSnapshot {
  subject: string;
  html: string;
  sample?: number;
  dark?: boolean;
  locale: Locale;
}

const previews = new Map<
  string,
  { channel: BroadcastChannel; timer: ReturnType<typeof setTimeout> }
>();
const lifetime = 60 * 60 * 1000;

function release(id: string) {
  const preview = previews.get(id);
  if (!preview) return;
  clearTimeout(preview.timer);
  preview.channel.close();
  previews.delete(id);
}

export function openMailPreview(content: Omit<PreviewSnapshot, "locale">) {
  if (typeof BroadcastChannel === "undefined")
    throw Error(message("mailPreview.unavailable"));
  const id = crypto.randomUUID();
  const channel = new BroadcastChannel(`omnimail-preview:${id}`);
  const snapshot: PreviewSnapshot = {
    ...content,
    locale: i18n.global.locale.value,
  };
  channel.onmessage = (event) => {
    if (event.data?.type === "request")
      channel.postMessage({ type: "snapshot", snapshot });
  };
  previews.set(id, { channel, timer: setTimeout(() => release(id), lifetime) });
  // Open synchronously in the user's click handler so popup blockers allow it.
  const tab = window.open(`/preview.html#${id}`, "_blank");
  if (!tab) {
    release(id);
    throw Error(message("mailPreview.blocked"));
  }
  tab.opener = null;
  // Bound retained content when users repeatedly open previews.
  if (previews.size > 20) release(previews.keys().next().value!);
}

export function receiveMailPreview(
  onSnapshot: (snapshot: PreviewSnapshot) => void,
  onExpired: () => void,
) {
  const id = window.location.hash.slice(1);
  if (!/^[\da-f-]{36}$/i.test(id) || typeof BroadcastChannel === "undefined") {
    onExpired();
    return () => {};
  }
  const channel = new BroadcastChannel(`omnimail-preview:${id}`);
  const timeout = setTimeout(() => {
    channel.close();
    onExpired();
  }, 5000);
  channel.onmessage = (event) => {
    const snapshot = event.data?.snapshot;
    if (
      event.data?.type !== "snapshot" ||
      typeof snapshot?.subject !== "string" ||
      typeof snapshot?.html !== "string"
    )
      return;
    clearTimeout(timeout);
    onSnapshot(snapshot);
    channel.close();
  };
  channel.postMessage({ type: "request" });
  return () => {
    clearTimeout(timeout);
    channel.close();
  };
}
