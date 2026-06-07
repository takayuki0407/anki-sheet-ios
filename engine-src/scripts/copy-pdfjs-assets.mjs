// Copies pdf.js cMaps + standard fonts into public/ so the Vite build emits them to
// dist/pdfjs. These are REQUIRED to render CJK (CID) fonts — without them, pdf.js
// silently fails to draw the glyphs and getTextContent() returns nothing.
// Runs on prebuild so node_modules stays the source of truth (public/pdfjs is gitignored).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "node_modules/pdfjs-dist");
const dst = resolve(root, "public/pdfjs");

if (!existsSync(src)) {
  console.warn("[copy-pdfjs-assets] pdfjs-dist not installed yet; skipping.");
  process.exit(0);
}

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const dir of ["cmaps", "standard_fonts"]) {
  cpSync(resolve(src, dir), resolve(dst, dir), { recursive: true });
}
console.log("[copy-pdfjs-assets] copied cmaps + standard_fonts -> public/pdfjs");
