// Root: mounts the app-wide headless detection engine and switches between screens
// based on the zustand view store (mirrors the original web app's single-stack model).
import { useEffect, useState } from "react";
import { SafeAreaView, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { EngineProvider } from "./src/engine/EngineProvider";
import { initPurchases } from "./src/iap/purchases";
import { useApp } from "./src/store/session";
import { DeckList } from "./src/screens/DeckList";
import { ImportWizard } from "./src/screens/ImportWizard";
import { PageViewer } from "./src/screens/PageViewer";
import { Settings } from "./src/screens/Settings";
import { Paywall } from "./src/screens/Paywall";
import { Info } from "./src/screens/Info";
import { Login } from "./src/screens/Login";
import { EngineTest } from "./src/screens/EngineTest";
import { Onboarding } from "./src/screens/Onboarding";
import { getMeta, setMeta } from "./src/db/repo";
import { initAuthListener } from "./src/auth/account";
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

export default function App() {
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    void initPurchases();
    initAuthListener();
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
          <Router />
        )}
      </SafeAreaView>
    </EngineProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
