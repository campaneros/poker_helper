import type { CapacitorConfig } from "@capacitor/cli";

// WebView remote debugging lets anyone with a USB cable read the app's data (hands, players), so it stays OFF
// unless a test build asks for it: `POKER_DEBUG_WEBVIEW=1 npx cap sync android` (see "android:debug").
// check-apk.sh --release fails if the packaged config has it on.
const config: CapacitorConfig = {
  appId: "com.mcampana.pokeradvisor",
  appName: "Poker Advisor",
  webDir: "www",
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: process.env.POKER_DEBUG_WEBVIEW === "1",
  },
};

export default config;
