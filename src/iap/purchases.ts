// RevenueCat integration. Configures the SDK lazily, keeps the `premium` entitlement
// synced into the entitlements store, and exposes purchase/restore for the paywall. The
// product catalog + entitlement are configured in App Store Connect + the RevenueCat
// dashboard; set the public SDK key via EXPO_PUBLIC_RC_IOS_KEY (or replace the placeholder).
import { Platform } from "react-native";
import Purchases, {
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesPackage,
} from "react-native-purchases";
import { useEntitlements } from "./entitlements";

export const ENTITLEMENT_ID = "premium";

const RC_KEYS = {
  ios: process.env.EXPO_PUBLIC_RC_IOS_KEY ?? "appl_REPLACE_WITH_YOUR_IOS_KEY",
  android: process.env.EXPO_PUBLIC_RC_ANDROID_KEY ?? "goog_REPLACE_WITH_YOUR_ANDROID_KEY",
};

let ready = false;

function applyEntitlement(info: CustomerInfo): void {
  useEntitlements.getState().setPremium(!!info.entitlements.active[ENTITLEMENT_ID]);
}

/**
 * Configure RevenueCat once and start syncing the premium entitlement. Returns false (and
 * leaves the app on the free tier) when the key is a placeholder or the native module is
 * absent (Expo Go / web). Safe to call repeatedly — every IAP entry point awaits it.
 */
export async function initPurchases(): Promise<boolean> {
  if (ready) return true;
  try {
    const apiKey = Platform.OS === "android" ? RC_KEYS.android : RC_KEYS.ios;
    if (apiKey.includes("REPLACE_WITH")) return false; // not configured yet
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.WARN);
    Purchases.configure({ apiKey });
    Purchases.addCustomerInfoUpdateListener(applyEntitlement);
    applyEntitlement(await Purchases.getCustomerInfo());
    ready = true;
    return true;
  } catch {
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

/** Purchase a package. Returns true if premium was granted; false if the user cancelled. */
export async function purchase(pkg: PurchasesPackage): Promise<boolean> {
  if (!(await initPurchases())) throw new Error("購入を利用できません（設定が必要です）");
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    applyEntitlement(customerInfo);
    return !!customerInfo.entitlements.active[ENTITLEMENT_ID];
  } catch (e) {
    if ((e as { userCancelled?: boolean }).userCancelled) return false;
    throw e;
  }
}

export async function restore(): Promise<boolean> {
  if (!(await initPurchases())) return false;
  try {
    const info = await Purchases.restorePurchases();
    applyEntitlement(info);
    return !!info.entitlements.active[ENTITLEMENT_ID];
  } catch (e) {
    if ((e as { userCancelled?: boolean }).userCancelled) return false;
    throw e;
  }
}
