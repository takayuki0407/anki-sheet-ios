// Root: mounts the app-wide headless detection engine and switches between screens based on
// the zustand view store. A subscription Gate wraps the router: with no active subscription the
// app is locked to the paywall, and a Standard subscriber over the book limit must trim down.
import { useCallback, useEffect, useState } from "react";
import { SafeAreaView, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { EngineProvider } from "./src/engine/EngineProvider";
import { initPurchases } from "./src/iap/purchases";
import { effectiveTier, STANDARD_DECK_LIMIT, useEntitlements } from "./src/iap/entitlements";
import { useApp } from "./src/store/session";
import { DeckList } from "./src/screens/DeckList";
import { ImportWizard } from "./src/screens/ImportWizard";
import { PageViewer } from "./src/screens/PageViewer";
import { Settings } from "./src/screens/Settings";
import { Quiz } from "./src/screens/Quiz";
import { Paywall } from "./src/screens/Paywall";
import { Info } from "./src/screens/Info";
import { Login } from "./src/screens/Login";
import { DowngradeSelect } from "./src/screens/DowngradeSelect";
import { EngineTest } from "./src/screens/EngineTest";
import { Onboarding } from "./src/screens/Onboarding";
import { deckCountTotal, getMeta, setMeta } from "./src/db/repo";
import { loadDeviceName } from "./src/sync/device";
import { initAuthListener, isAuthConfigured, useAccount } from "./src/auth/account";
import { colors } from "./src/ui/theme";

function Router() {
  const view = useApp((s) => s.view);
  switch (view.name) {
    case "decks":
      return <DeckList />;
    case "import":
      return <ImportWizard />;
    case "viewer":
      return <PageViewer key={view.deckId} deckId={view.deckId} />;
    case "settings":
      return <Settings key={view.deckId} deckId={view.deckId} />;
    case "quiz":
      return <Quiz key={view.deckId} deckId={view.deckId} />;
    case "paywall":
      return <Paywall />;
    case "info":
      return <Info />;
    case "login":
      return <Login />;
    case "engineTest":
      return <EngineTest />;
  }
}

// Subscription gate. Renders above the router so it can't be navigated around.
function Gate() {
  const view = useApp((s) => s.view);
  const decksVersion = useApp((s) => s.decksVersion);
  const tier = useEntitlements((s) => s.tier);
  const billingActive = useEntitlements((s) => s.billingActive);
  const ready = useEntitlements((s) => s.ready);
  const user = useAccount((s) => s.user);
  const userReady = useAccount((s) => s.ready);
  const [deckCount, setDeckCount] = useState<number | null>(null);
  const refreshCount = useCallback(() => deckCountTotal().then(setDeckCount), []);
  useEffect(() => {
    void refreshCount();
  }, [refreshCount, tier, billingActive, view.name, decksVersion]);

  const eff = effectiveTier({ tier, billingActive });

  if (!ready || deckCount === null || !userReady) return null; // brief splash
  // Sign-in is REQUIRED (when auth is configured): the app is for signed-in accounts only, so the
  // bookshelf can't be used (or freely accessed) without an account. Dev/unconfigured stays open.
  if (isAuthConfigured && !user) return <Login />;
  if (eff === "none") {
    // Locked: reachable only the paywall, login (to restore a subscription), and Info — Info
    // must stay reachable so a logged-in user can still delete their account (Apple 5.1.1(v)).
    if (view.name === "login") return <Login />;
    if (view.name === "info") return <Info />;
    return <Paywall locked />;
  }
  if (eff === "standard" && deckCount > STANDARD_DECK_LIMIT) {
    if (view.name === "paywall") return <Paywall />; // upgrade-to-Pro escape
    if (view.name === "login") return <Login />;
    if (view.name === "info") return <Info />;
    return <DowngradeSelect keepLimit={STANDARD_DECK_LIMIT} onResolved={refreshCount} />;
  }
  return <Router />;
}

export default function App() {
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    void initPurchases();
    initAuthListener();
    void loadDeviceName(); // populate the device-name cache before any cloud registration/sync
    getMeta("onboarded").then((v) => setOnboarded(v === "1"));
  }, []);
  return (
    <EngineProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        {onboarded === false ? (
          <Onboarding
            onDone={() => {
              setOnboarded(true);
              void setMeta("onboarded", "1");
            }}
          />
        ) : onboarded === null ? null : (
          <Gate />
        )}
      </SafeAreaView>
    </EngineProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
