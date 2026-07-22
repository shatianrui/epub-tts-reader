"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

export function PlatformBody({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const platform = Capacitor.getPlatform();
    const root = document.documentElement;
    root.classList.add(`platform-${platform}`);
    if (Capacitor.isNativePlatform()) {
      root.classList.add("platform-native");
    }
    return () => {
      root.classList.remove(`platform-${platform}`, "platform-native");
    };
  }, []);

  return <>{children}</>;
}
