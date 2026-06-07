// Extracts the bundled WebView engine (assets/engine.zip) into <documents>/engine on
// first launch (and whenever the bundled ENGINE_VERSION changes), then hands the
// WebView a file:// URL to its index.html. Keeping the engine in the document directory
// — alongside imported PDFs — lets one allowingReadAccessToURL grant cover everything.
import { Asset } from "expo-asset";
import { File, Directory, Paths } from "expo-file-system";
import { unzipSync } from "fflate";
import { ENGINE_VERSION } from "./engineVersion";

const DIR = "engine";

let cachedIndexUri: string | null = null;

/** file:// URI of the app's document directory (granted to the WebView for read access). */
export function documentDirUri(): string {
  return new Directory(Paths.document).uri;
}

/**
 * Ensure the engine bundle is extracted and return the file:// URI of its index.html.
 * Re-extracts only when the content-hash version changes, so normal launches are cheap.
 */
export async function ensureEngine(): Promise<string> {
  if (cachedIndexUri) return cachedIndexUri;

  const engineDir = new Directory(Paths.document, DIR);
  const indexFile = new File(Paths.document, DIR, "index.html");
  const versionFile = new File(Paths.document, DIR, ".version");

  let current: string | null = null;
  try {
    if (versionFile.exists) current = versionFile.textSync().trim();
  } catch {
    current = null;
  }

  if (!indexFile.exists || current !== ENGINE_VERSION) {
    if (engineDir.exists) engineDir.delete();
    engineDir.create({ intermediates: true, idempotent: true });

    const asset = Asset.fromModule(require("../../assets/engine.zip"));
    await asset.downloadAsync();
    const zipUri = asset.localUri ?? asset.uri;
    const zipBytes = new File(zipUri).bytesSync();
    const entries = unzipSync(zipBytes);

    for (const rel of Object.keys(entries)) {
      if (rel.endsWith("/")) continue;
      const bytes = entries[rel];
      const segments = rel.split("/");
      const name = segments.pop() as string;
      if (segments.length > 0) {
        new Directory(Paths.document, DIR, ...segments).create({
          intermediates: true,
          idempotent: true,
        });
      }
      const f = new File(Paths.document, DIR, ...segments, name);
      f.create({ overwrite: true });
      f.write(bytes);
    }

    versionFile.create({ overwrite: true });
    versionFile.write(ENGINE_VERSION);
  }

  cachedIndexUri = indexFile.uri;
  return cachedIndexUri;
}

/**
 * Copy a picked PDF into the document directory (the WebView's read-access scope) so the
 * engine can load it by file:// URL. Returns that URL. Replaces any previous import.pdf.
 */
export function stagePdf(srcUri: string, name = "import.pdf"): string {
  const dest = new File(Paths.document, name);
  if (dest.exists) dest.delete();
  // Sync copy: File.copy() is async in SDK 56, and the engine reads the URI immediately.
  new File(srcUri).copySync(dest);
  return dest.uri;
}

/**
 * Write an object as JSON into the document directory and return its file:// URL. Used to
 * hand the viewer its (potentially large) answer rects via a file the engine fetches,
 * instead of pushing them through injectJavaScript.
 */
export function stageJson(obj: unknown, name = "viewer-cards.json"): string {
  const dest = new File(Paths.document, name);
  if (dest.exists) dest.delete();
  dest.create();
  dest.write(JSON.stringify(obj));
  return dest.uri;
}
