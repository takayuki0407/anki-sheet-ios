import { defineConfig } from "vite";

// Short build id (YYMMDD-HHMM) stamped into the bundle so a device can report which
// engine build it is actually running.
const d = new Date();
const p = (n: number) => String(n).padStart(2, "0");
const BUILD_ID = `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;

// Builds the self-contained WebView engine (HTML + JS + pdf.worker). cMaps and
// standard_fonts are copied into public/pdfjs (scripts/copy-pdfjs-assets.mjs) and
// emitted to dist/pdfjs, where pdfEngine.ts loads them relative to document.baseURI.
// base "./" makes every URL relative so the bundle works when loaded from a file://
// directory inside react-native-webview.
export default defineConfig({
  base: "./",
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: {
    outDir: "dist",
    target: "es2020",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
