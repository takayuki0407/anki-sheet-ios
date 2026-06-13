// A user-editable, friendly name for THIS device, sent with each book registration / cloud sync and
// shown in the account's cloud list so you can tell which device holds each book.
//
// iOS 16+ does NOT expose the user-assigned device name ("Takayuki の iPhone") without a special
// entitlement — UIDevice.name returns a generic "iPhone". So we default to a platform label and let
// the user override it with their own name in 情報・ヘルプ. The custom name is persisted in the meta
// table and cached in memory so deviceLabel() stays synchronous (loadDeviceName() runs at startup).
import { Platform } from "react-native";
import { getMeta, setMeta } from "../db/repo";

const KEY = "deviceName";
const PREV_KEY = "deviceNamePrev";
let cached: string | null = null; // custom name, loaded once at startup via loadDeviceName()
// The PREVIOUS label while its re-stamp to the account registry is still pending. Until every
// cloud row carries the new name, the reconcile must keep treating books stamped with the OLD
// name as "held by me" — otherwise an offline rename makes the next sync see every local book as
// held-elsewhere and delete it (single-home rule misfire).
let cachedPrev: string | null = null;

function platformDefault(): string {
  if (Platform.OS === "ios")
    return (Platform as unknown as { isPad?: boolean }).isPad ? "iPad" : "iPhone";
  if (Platform.OS === "android") return "Android";
  return "iOS";
}

/** Load the saved custom name into the in-memory cache (call once at app start — and again after a
 * local wipe, so the next account doesn't inherit the previous user's device name). */
export async function loadDeviceName(): Promise<void> {
  const v = await getMeta(KEY);
  cached = v && v.trim() ? v.trim() : null;
  const p = await getMeta(PREV_KEY);
  cachedPrev = p && p.trim() ? p.trim() : null;
}

/** The custom name if set, else the platform default. Synchronous (reads the cache). */
export function getDeviceName(): string {
  return cached ?? platformDefault();
}

/** Save (or clear, when blank → revert to the platform default) the custom name. Updates the cache
 * immediately so deviceLabel() reflects it without a reload. Remembers the outgoing label until
 * applyDeviceNameToLocalBooks confirms every registry row was re-stamped (an EXISTING pending
 * label is kept — that is the one still on the server after repeated offline renames). */
export async function setDeviceName(name: string): Promise<void> {
  const v = name.trim();
  const old = getDeviceName();
  cached = v || null;
  await setMeta(KEY, v);
  if (old !== getDeviceName() && !cachedPrev) {
    cachedPrev = old;
    await setMeta(PREV_KEY, old);
  }
}

/** The not-yet-re-stamped previous label, or null once the rename fully propagated. */
export function previousDeviceLabel(): string | null {
  return cachedPrev;
}

/** Called once every registry row this device holds carries the current label. */
export async function clearPreviousDeviceLabel(): Promise<void> {
  cachedPrev = null;
  await setMeta(PREV_KEY, "");
}

/** The label sent to the backend for this device. */
export function deviceLabel(): string {
  return getDeviceName();
}
