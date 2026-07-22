import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.listenpage.epubtts",
  appName: "听页 ListenPage",
  webDir: "out",
  server: {
    // IndexedDB、fetch 等 Web API 需要安全上下文
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#0f1419",
  },
};

export default config;
