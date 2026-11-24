"use client";

import { useCallback, useEffect, useState } from "react";
import { BellIcon, BellRingingIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

type Permission = "unsupported" | "default" | "granted" | "denied";

const base64ToBytes = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = (text + "=".repeat((4 - (text.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

/** Registers the service worker, and tells the daemon whether this page is visible, so a tab left open does not stop the phone's pushes. */
export function PushClient() {
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    const clientId = (() => {
      try {
        return localStorage.getItem("client-id") ?? (localStorage.setItem("client-id", crypto.randomUUID()), localStorage.getItem("client-id")!);
      } catch {
        return crypto.randomUUID();
      }
    })();
    const report = () => void api("/push/visibility", { method: "POST", body: { clientId, visible: document.visibilityState === "visible" && document.hasFocus() } }).catch(() => undefined);
    report();
    const timer = setInterval(report, 45_000);
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, []);
  return null;
}

/**
 * The phone's one-time prompt to turn on notifications, and what state they are in afterwards. Permission is asked only from the
 * Turn on button (iOS refuses it otherwise), and only in the installed app. A test notification checks the whole path.
 */
export function NotificationsRow() {
  const [permission, setPermission] = useState<Permission>("default");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPermission(typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) ? "unsupported" : (Notification.permission as Permission));
  }, []);

  const turnOn = useCallback(async () => {
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result as Permission);
      if (result !== "granted") return;
      const registration = await navigator.serviceWorker.ready;
      const { key } = await api<{ key: string }>("/push/key");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(key) });
      await api("/push/subscribe", { method: "POST", body: subscription.toJSON() });
      toast("Notifications are on");
    } catch {
      toast("Notifications could not be turned on");
    } finally {
      setBusy(false);
    }
  }, []);

  const test = async () => {
    try {
      const res = await api<{ sent: number }>("/push/test", { method: "POST", body: {} });
      toast(res.sent > 0 ? "Sent a test notification" : "No device is subscribed yet");
    } catch {
      toast("The test could not be sent");
    }
  };

  if (permission === "unsupported") return null;
  if (permission === "granted") {
    return (
      <div className="mx-5 my-2 flex items-center gap-3 text-body text-muted-foreground" data-notifications="on">
        <BellRingingIcon size={18} aria-hidden /> Notifications are on.
        <Button variant="ghost" size="sm" onClick={() => void test()}>
          Send a test notification
        </Button>
      </div>
    );
  }
  if (permission === "denied") {
    return (
      <p className="mx-4 mt-1 mb-2 rounded-card bg-muted px-3.5 py-3 text-body text-muted-foreground" data-notifications="denied">
        Notifications are blocked for Clots. Turn them on for the app in your phone&apos;s Settings, under Notifications.
      </p>
    );
  }
  return (
    <div className="mx-4 mt-1 mb-2 flex items-center gap-3 rounded-card bg-highlight-soft px-3.5 py-3 text-highlight-ink" data-notifications="ask">
      <BellIcon size={20} className="shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-body">Get a notification when a Clot needs you</p>
      <Button variant="highlight" className="h-[34px]" disabled={busy} onClick={() => void turnOn()}>
        Turn on
      </Button>
    </div>
  );
}
