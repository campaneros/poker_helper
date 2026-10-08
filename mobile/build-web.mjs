// Bundles shim + shared UI (app/static) + TS core into www/ (the folder Capacitor ships inside the APK).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("www", { recursive: true });
await build({
  // import order = execution order: the fetch shim must exist before the UI starts calling /api/*
  stdin: { contents: 'import "./src/main.ts"; import "../app/static/app.js";', resolveDir: ".", loader: "ts" },
  bundle: true,
  format: "iife",
  target: "chrome100",
  outfile: "www/app.js",
  loader: { ".json": "json" },
  minify: true,
  logLevel: "info",
});
for (const f of ["index.html", "style.css", "manifest.webmanifest", "icon-192.png", "icon-512.png"]) {
  copyFileSync(`../app/static/${f}`, `www/${f}`);
}
