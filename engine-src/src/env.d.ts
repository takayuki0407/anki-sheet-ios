/// <reference types="vite/client" />

// Stamped at build time (see vite.config.ts) so a device can report which engine
// bundle it is actually running — invaluable for diagnosing stale WebView caches.
declare const __BUILD_ID__: string;

// Main-thread worker fallback import (no bundled types on the worker entry).
declare module "pdfjs-dist/build/pdf.worker.min.mjs";
