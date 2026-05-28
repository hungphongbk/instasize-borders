"use client";

import { useEffect } from "react";

export default function PWARegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const register = async () => {
      try {
        if (process.env.NODE_ENV !== "production") {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));

          if (typeof caches !== "undefined") {
            const cacheKeys = await caches.keys();
            await Promise.all(
              cacheKeys
                .filter((key) => key.startsWith("instasize-borders-"))
                .map((key) => caches.delete(key)),
            );
          }

          return;
        }

        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        await registration.update();
      } catch {
        // Service worker registration is optional enhancement.
      }
    };

    register();
  }, []);

  return null;
}
