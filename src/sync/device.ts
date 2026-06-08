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
let cached: string | null = null; // custom name, loaded once at startup via loadDeviceName()

function platformDefault(): string {
  if (Platform.OS === "ios")
    return (Platform as unknown as { isPad?: boolean }).isPad ? "iPad" : "iPhone";
  if (Platform.OS === "android") return "Android";
  return "iOS";
}

/** Load the saved custom name into the in-memory cache (call once at app start). */
export async function loadDeviceName(): Promise<void> {
  const v = await getMeta(KEY);
  cached = v && v.trim() ? v.trim() : null;
}

/** The custom name if set, else the platform default. Synchronous (reads the cache). */
export function getDeviceName(): string {
  return cached ?? platformDefault();
}

/** Save (or clear, when blank → revert to the platform default) the custom name. Updates the cache
 * immediately so deviceLabel() reflects it without a reload. */
export async function setDeviceName(name: string): Promise<void> {
  const v = name.trim();
  cached = v || null;
  await setMeta(KEY, v);
}

/** The label sent to the backend for this device. */
export function deviceLabel(): string {
  return getDeviceName();
}
