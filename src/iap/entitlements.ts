// Subscription tier (mirrors the server's account tier; the actual book cap is enforced
// account-wide by the server, this local copy drives display + the dev switcher):
//   premium  – unlimited + (Phase 2) adaptive SRS
//   pro      – unlimited books + cloud sync
//   standard – up to STANDARD_DECK_LIMIT books
//   free     – 1 book (no subscription; the app stays usable — NO paywall hard-lock)
// `tier`/`billingActive` are driven by the RevenueCat listener (see iap/purchases.ts).
import { create } from "zustand";

export type Tier = "free" | "standard" | "pro" | "premium";

export const STANDARD_DECK_LIMIT = 10;
export const FREE_DECK_LIMIT = 1;

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
  tier: "free",
  billingActive: false,
  ready: false,
  set: (p) => set(p),
}));

/** Tier used for display: ungated environments behave as "pro" so dev/Expo Go isn't limited. */
export function effectiveTier(s: { tier: Tier; billingActive: boolean }): Tier {
  return s.billingActive ? s.tier : "pro";
}

/** Hook: the effective (display) tier. */
export function useEffectiveTier(): Tier {
  return useEntitlements((s) => effectiveTier(s));
}

/** Max books for a tier (the server enforces the real account-wide cap; this is for local display). */
export function deckLimit(tier: Tier): number {
  return tier === "pro" || tier === "premium"
    ? Infinity
    : tier === "standard"
      ? STANDARD_DECK_LIMIT
      : FREE_DECK_LIMIT;
}

/** Whether another deck may be added given the current count and (effective) tier. */
export function canAddDeck(currentCount: number, tier: Tier): boolean {
  return currentCount < deckLimit(tier);
}
