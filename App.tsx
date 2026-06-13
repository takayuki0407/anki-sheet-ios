// Root: mounts the app-wide headless detection engine and switches between screens based on
// the zustand view store. A subscription Gate wraps the router: with no active subscription the
// app is locked to the paywall, and a Standard subscriber over the book limit must trim down.
import { useEffect, useState } from "react";
import { BackHandler, SafeAreaView, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { EngineProvider } from "./src/engine/EngineProvider";
import { initPurchases } from "./src/iap/purchases";
import { useEntitlements } from "./src/iap/entitlements";
import { useApp } from "./src/store/session";
import { DeckList } from "./src/screens/DeckList";
import { ImportWizard } from "./src/screens/ImportWizard";
import { PageViewer } from "./src/screens/PageViewer";
import { Settings } from "./src/screens/Settings";
import { Quiz } from "./src/screens/Quiz";
import { Review } from "./src/screens/Review";
import { Paywall } from "./src/screens/Paywall";
import { Info } from "./src/screens/Info";
import { Login } from "./src/screens/Login";
import { DowngradeSelect } from "./src/screens/DowngradeSelect";
import { EngineTest } from "./src/screens/EngineTest";
import { Onboarding } from "./src/screens/Onboarding";
import { getMeta, setMeta } from "./src/db/repo";
import { loadDeviceName } from "./src/sync/device";
import { listBooks } from "./src/sync/api";
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
      return <Settings key={view.deckId} deckId={view.deckId} from={view.from} />;
    case "quiz":
      return <Quiz key={view.deckId} deckId={view.deckId} from={view.from} />;
    case "review":
      return <Review />;
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

// Account gate. Renders above the router so it can't be navigated around. Account-wide model:
// Free is a USABLE tier (1 book) — no hard paywall lock. The only forced screen is the downgrade
// trim, driven by the SERVER (trim_required when a downgrade left the account over its cap).
function Gate() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const decksVersion = useApp((s) => s.decksVersion);
  const ready = useEntitlements((s) => s.ready);
  const user = useAccount((s) => s.user);
  const userReady = useAccount((s) => s.ready);
  const [trimRequired, setTrimRequired] = useState(false);
  const [cap, setCap] = useState(1);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!user) {
      setTrimRequired(false);
      return;
    }
    let live = true;
    void listBooks()
      .then((u) => {
        if (!live) return;
        setTrimRequired(!!u.trimRequired);
        setCap(u.cap ?? u.limit ?? 1);
      })
      .catch(() => live && setTrimRequired(false)); // fail open — never trap on a network error
    return () => {
      live = false;
    };
  }, [user, view.name, decksVersion, tick]);

  // Android hardware/gesture back: walk the single-stack view back instead of killing the app.
  // Mirrors each screen's in-app back (settings/quiz return to their `from`). Forced screens
  // (sign-in wall, downgrade trim) have nowhere to go, so we let the system exit. No-op on iOS
  // (the event never fires there).
  useEffect(() => {
    const onBack = (): boolean => {
      if (isAuthConfigured && !user) return false; // sign-in wall → let Android exit
      const v = useApp.getState().view;
      if (trimRequired) {
        // Info/paywall/login float over the forced trim → back returns to the trim screen.
        if (v.name === "info" || v.name === "paywall" || v.name === "login") {
          setView({ name: "decks" });
          return true;
        }
        return false; // on the trim itself → exit
      }
      if (v.name === "decks") return false; // bookshelf (home) → exit
      if ((v.name === "settings" || v.name === "quiz") && v.from) {
        setView(v.from); // back to where it was opened from (e.g. the viewer)
        return true;
      }
      setView({ name: "decks" });
      return true;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => sub.remove();
  }, [user, trimRequired, setView]);

  if (!ready || !userReady) return null; // brief splash
  // Sign-in is REQUIRED (when auth is configured): the app is for signed-in accounts only.
  if (isAuthConfigured && !user) return <Login />;
  // Forced trim after a downgrade. Keep Info/login/paywall reachable (Apple 5.1.1(v) + upgrade escape).
  if (trimRequired) {
    if (view.name === "login") return <Login />;
    if (view.name === "info") return <Info />;
    if (view.name === "paywall") return <Paywall />;
    return <DowngradeSelect keepLimit={cap} onResolved={() => setTick((n) => n + 1)} />;
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
