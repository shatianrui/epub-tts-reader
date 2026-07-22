"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

function detectDeviceClasses(): string[] {
  const classes: string[] = [];
  if (typeof window === "undefined") return classes;

  const ua = navigator.userAgent || "";
  const width = Math.min(window.innerWidth, window.screen.width || window.innerWidth);
  const height = Math.max(window.innerHeight, window.screen.height || window.innerHeight);
  const ratio = height / Math.max(width, 1);
  const dpr = window.devicePixelRatio || 1;

  if (/SamsungBrowser|SM-S9|SM-S8|Galaxy/i.test(ua) || /Samsung/i.test(ua)) {
    classes.push("device-samsung");
  }

  // Galaxy S24 Ultra class: tall 6.7"+ phone, high DPR, ~380–520 CSS px wide
  if (
    width >= 360 &&
    width <= 540 &&
    height >= 780 &&
    ratio >= 1.9 &&
    dpr >= 2.5
  ) {
    classes.push("device-large-phone");
  }

  if (ratio >= 2.05) {
    classes.push("device-tall");
  }

  if (dpr >= 3) {
    classes.push("device-hires");
  }

  return classes;
}

export function PlatformBody({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const platform = Capacitor.getPlatform();
    const root = document.documentElement;
    const classes = [
      `platform-${platform}`,
      ...(Capacitor.isNativePlatform() ? ["platform-native"] : []),
      ...detectDeviceClasses(),
    ];

    root.classList.add(...classes);

    const syncViewport = () => {
      const vv = window.visualViewport;
      const height = vv?.height ?? window.innerHeight;
      root.style.setProperty("--app-vh", `${height}px`);
      root.style.setProperty(
        "--safe-bottom",
        `max(env(safe-area-inset-bottom), 12px)`,
      );
      root.style.setProperty(
        "--safe-top",
        `max(env(safe-area-inset-top), 12px)`,
      );
    };

    syncViewport();
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.addEventListener("resize", syncViewport);
    window.addEventListener("orientationchange", syncViewport);

    return () => {
      root.classList.remove(...classes);
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.removeEventListener("resize", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
    };
  }, []);

  return <>{children}</>;
}
