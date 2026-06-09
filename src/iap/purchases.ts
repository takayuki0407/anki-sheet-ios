// RevenueCat integration. Configures the SDK lazily, keeps the subscription tier (pro /
// standard / none) synced into the entitlements store, and exposes purchase/restore for the
// paywall. Products + entitlements ("pro", "standard") are configured in App Store Connect +
// the RevenueCat dashboard; set the public SDK key via EXPO_PUBLIC_RC_IOS_KEY.
import { Platform } from "react-native";
import Purchases, {
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesPackage,
} from "react-native-purchases";
import { useEntitlements, type Tier } from "./entitlements";

// Entitlement identifiers as configured in RevenueCat. "premium" > "pro" > "standard"; none = free.
export const ENTITLEMENTS = { premium: "premium", pro: "pro", standard: "standard" } as const;

const RC_KEYS = {
  ios: process.env.EXPO_PUBLIC_RC_IOS_KEY ?? "appl_REPLACE_WITH_YOUR_IOS_KEY",
  android: process.env.EXPO_PUBLIC_RC_ANDROID_KEY ?? "goog_REPLACE_WITH_YOUR_ANDROID_KEY",
};

let ready = false;

function tierOf(info: CustomerInfo): Tier {
  const active = info.entitlements.active;
  if (active[ENTITLEMENTS.premium]) return "premium";
  if (active[ENTITLEMENTS.pro]) return "pro";
  if (active[ENTITLEMENTS.standard]) return "standard";
  return "free"; // no active subscription = Free (1 book, no hard lock)
}

/** Apply a RevenueCat CustomerInfo snapshot to the entitlement store (tier + billingActive). */
export function syncCustomerInfo(info: CustomerInfo): void {
  useEntitlements.getState().set({ tier: tierOf(info), billingActive: true, ready: true });
}

/** Mark billing unavailable but ready, so the app runs UNGATED (Expo Go / missing key). */
function markUngated(): void {
  useEntitlements.getState().set({ billingActive: false, ready: true });
}

/**
 * Configure RevenueCat once and start syncing the subscription tier. Safe to call repeatedly —
 * every IAP entry point awaits it. Returns true once configured.
 *
 * Failure handling is split so a transient outage on a configured build can't hand out Pro:
 *  - placeholder key OR native module absent (Expo Go) -> UNGATE (app fully usable for dev)
 *  - configured but the first fetch fails (e.g. first launch offline) -> FAIL CLOSED (locked);
 *    the update listener recovers the real tier once the network returns.
 */
export async function initPurchases(): Promise<boolean> {
  if (ready) return true;
  const apiKey = Platform.OS === "android" ? RC_KEYS.android : RC_KEYS.ios;
  if (apiKey.includes("REPLACE_WITH")) {
    markUngated();
    return false; // not configured yet
  }
  // configure() needs no network; if it throws, the native module is absent (Expo Go with a
  // real key) — ungate rather than lock the dev build out.
  try {
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.WARN);
    Purchases.configure({ apiKey });
    Purchases.addCustomerInfoUpdateListener(syncCustomerInfo);
  } catch {
    markUngated();
    return false;
  }
  // SDK is configured. A failed first fetch must NOT grant access (closes the "kill the network
  // to get free Pro" hole) — lock until the listener delivers the real entitlements.
  try {
    syncCustomerInfo(await Purchases.getCustomerInfo());
    ready = true;
    return true;
  } catch {
    useEntitlements.getState().set({ tier: "free", billingActive: true, ready: true });
    return false;
  }
}

export async function getCurrentOffering(): Promise<PurchasesOffering | null> {
  if (!(await initPurchases())) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current ?? null;
  } catch {
    return null;
  }
}

/** Purchase a package. Returns the resulting tier ("free" if cancelled or not granted). */
export async function purchase(pkg: PurchasesPackage): Promise<Tier> {
  if (!(await initPurchases())) throw new Error("購入を利用できません（設定が必要です）");
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    syncCustomerInfo(customerInfo);
    return tierOf(customerInfo);
  } catch (e) {
    if ((e as { userCancelled?: boolean }).userCancelled) return "free";
    throw e;
  }
}

/** Restore purchases. Returns the resulting tier ("free" if nothing to restore). */
export async function restore(): Promise<Tier> {
  if (!(await initPurchases())) return "free";
  const info = await Purchases.restorePurchases();
  syncCustomerInfo(info);
  return tierOf(info);
}
