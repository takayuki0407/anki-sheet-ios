import { create } from "zustand";

// Single-stack view switch (mirrors the original web app's session store). Screens are
// rendered conditionally by App.tsx based on `view` — no native navigator needed.
export type View =
  | { name: "decks" }
  | { name: "import" }
  | { name: "viewer"; deckId: number }
  | { name: "settings"; deckId: number }
  | { name: "paywall" }
  | { name: "info" }
  | { name: "engineTest" };

interface AppState {
  view: View;
  setView: (v: View) => void;
}

export const useApp = create<AppState>((set) => ({
  view: { name: "decks" },
  setView: (view) => set({ view }),
}));
