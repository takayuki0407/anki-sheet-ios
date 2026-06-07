// Subscription tier + book-count gate. Three states:
//   pro      – unlimited books
//   standard – up to STANDARD_DECK_LIMIT books
//   none     – no active subscription (e.g. after the 7-day trial) -> locked behind the paywall
// `setTier`/`billingActive` are driven by the RevenueCat listener (see iap/purchases.ts).
import { create } from "zustand";

export type Tier = "none" | "standard" | "pro";

export const STANDARD_DECK_LIMIT = 3;

interface EntitlementState {
  tier: Tier;
  // True once RevenueCat is configured and reporting. When false (Expo Go, placeholder key,
  // or a transient RC error) the app is intentionally UNGATED so it stays usable and
  // dev-testable — the gates below then behave as full "pro" access (fail-open).
  billingActive: boolean;
  ready: boolean; // RC has reported once, or we determined it isn't configured
  set: (p: Partial<EntitlementState>) => void;
}

export const useEntitlements = create<EntitlementState>((set) => ({
  tier: "none",
  billingActive: false,
  ready: false,
  set: (p) => set(p),
}));

/** Tier used for gating: ungated environments behave as "pro" so dev/Expo Go isn't locked out. */
export function effectiveTier(s: { tier: Tier; billingActive: boolean }): Tier {
  return s.billingActive ? s.tier : "pro";
}

/** Hook: the effective (gating) tier. */
export function useEffectiveTier(): Tier {
  return useEntitlements((s) => effectiveTier(s));
}

/** Max books for a tier (Infinity for pro / ungated). */
export function deckLimit(tier: Tier): number {
  return tier === "pro" ? Infinity : tier === "standard" ? STANDARD_DECK_LIMIT : 0;
}

/** Whether another deck may be added given the current count and (effective) tier. */
export function canAddDeck(currentCount: number, tier: Tier): boolean {
  return currentCount < deckLimit(tier);
}
