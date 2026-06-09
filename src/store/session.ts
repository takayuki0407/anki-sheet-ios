import { create } from "zustand";

// Single-stack view switch (mirrors the original web app's session store). Screens are
// rendered conditionally by App.tsx based on `view` — no native navigator needed.
export type View =
  | { name: "decks" }
  | { name: "import" }
  | { name: "viewer"; deckId: number }
  // `from` remembers where the screen was opened from so its back button returns there (e.g. opened
  // from the viewer → back goes to the book, not the bookshelf). Defaults to the bookshelf.
  | { name: "settings"; deckId: number; from?: View }
  | { name: "quiz"; deckId: number; from?: View }
  | { name: "paywall" }
  | { name: "info" }
  | { name: "login" }
  | { name: "engineTest" };

interface AppState {
  view: View;
  setView: (v: View) => void;
  // Bumped on any deck insert/delete/import so the subscription Gate re-counts deterministically
  // (e.g. a backup-restore that pushes a Standard user over the limit triggers DowngradeSelect).
  decksVersion: number;
  bumpDecks: () => void;
}

export const useApp = create<AppState>((set) => ({
  view: { name: "decks" },
  setView: (view) => set({ view }),
  decksVersion: 0,
  bumpDecks: () => set((s) => ({ decksVersion: s.decksVersion + 1 })),
}));
