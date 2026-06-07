/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// The detection pipeline is pure (PagePixels + RunCandidate in, DetectedCloze out),
// so the unit tests run in a plain Node environment with no DOM. The optional real-PDF
// integration test (detect.integration.test.ts) is skipped unless ANKI_SHEET_TEST_PDF
// is set and pdfjs-dist + @napi-rs/canvas are installed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
