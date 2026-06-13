// SecureStore-backed storage adapter for Firebase Auth persistence.
//
// Why: Firebase persists the long-lived refresh token. The default React Native
// persistence (AsyncStorage) keeps it in plaintext, readable from a device backup or a
// jailbroken app sandbox. Routing persistence through the iOS Keychain (expo-secure-store)
// makes it hardware-encrypted and — with THIS_DEVICE_ONLY — excluded from iCloud sync and
// encrypted backups. See docs/research/security-audit.md, finding A.
//
// Two Keychain constraints shape the indirection below:
//   - Keys may only contain [A-Za-z0-9._-]; Firebase keys contain ':' → we sanitize.
//   - Values above ~2048 bytes can be rejected by iOS; the auth blob can exceed that, so we
//     split values into chunks and keep a tiny chunk-count manifest at the base key.
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

const OPTS = {
  keychainService: "kiokumate.auth",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// A UTF-16 unit is at most 3 UTF-8 bytes, so 640 units ≤ 1920 bytes < the ~2048 limit,
// with margin. splitChunks never cuts between a surrogate pair.
const CHUNK = 640;

const sanitize = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, "_");

function splitChunks(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    let end = Math.min(i + CHUNK, value.length);
    if (end < value.length) {
      const c = value.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1; // keep surrogate pairs intact
    }
    out.push(value.slice(i, end));
    i = end;
  }
  return out.length ? out : [""];
}

async function manifestCount(base: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(base, OPTS);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function setItem(key: string, value: string): Promise<void> {
  const base = sanitize(key);
  const prev = await manifestCount(base);
  const chunks = splitChunks(value);
  await Promise.all(chunks.map((c, i) => SecureStore.setItemAsync(`${base}.${i}`, c, OPTS)));
  // Drop chunks left over from a previously larger value.
  const stale: Promise<void>[] = [];
  for (let i = chunks.length; i < prev; i++) {
    stale.push(SecureStore.deleteItemAsync(`${base}.${i}`, OPTS));
  }
  await Promise.all(stale);
  // Manifest written last, so an interrupted write degrades to "missing" (re-auth), not
  // "corrupt" (a half-updated blob).
  await SecureStore.setItemAsync(base, String(chunks.length), OPTS);
}

async function getItem(key: string): Promise<string | null> {
  const base = sanitize(key);
  const n = await manifestCount(base);
  if (n > 0) {
    const parts = await Promise.all(
      Array.from({ length: n }, (_, i) => SecureStore.getItemAsync(`${base}.${i}`, OPTS)),
    );
    if (parts.some((p) => p == null)) return null; // partial write → treat as absent
    return parts.join("");
  }
  // One-time migration of an existing plaintext session, then scrub the old copy.
  const legacy = await AsyncStorage.getItem(key);
  if (legacy != null) {
    await setItem(key, legacy);
    await AsyncStorage.removeItem(key);
    return legacy;
  }
  return null;
}

async function removeItem(key: string): Promise<void> {
  const base = sanitize(key);
  const n = await manifestCount(base);
  const ops: Promise<void>[] = [];
  for (let i = 0; i < n; i++) ops.push(SecureStore.deleteItemAsync(`${base}.${i}`, OPTS));
  ops.push(SecureStore.deleteItemAsync(base, OPTS));
  await Promise.all(ops);
}

/** AsyncStorage-compatible shape consumed by firebase's getReactNativePersistence. */
export const secureStorePersistence = { getItem, setItem, removeItem };
