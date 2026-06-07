// Premium entitlement + free-tier gate. The actual purchase state is wired to
// RevenueCat in M5 (setPremium is called from the purchases listener); until then it
// defaults to free so the gate is exercised. Free users may keep up to FREE_DECK_LIMIT
// books; Premium unlocks unlimited.
import { create } from "zustand";

export const FREE_DECK_LIMIT = 3;

interface EntitlementState {
  isPremium: boolean;
  setPremium: (v: boolean) => void;
}

export const useEntitlements = create<EntitlementState>((set) => ({
  isPremium: false,
  setPremium: (isPremium) => set({ isPremium }),
}));

/** Whether another deck may be added given the current count and premium status. */
export function canAddDeck(currentCount: number, isPremium: boolean): boolean {
  return isPremium || currentCount < FREE_DECK_LIMIT;
}
