// Root: mounts the app-wide headless detection engine and switches between screens
// based on the zustand view store (mirrors the original web app's single-stack model).
import { useEffect } from "react";
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
import { EngineTest } from "./src/screens/EngineTest";
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
    case "engineTest":
      return <EngineTest />;
  }
}

export default function App() {
  useEffect(() => {
    void initPurchases();
  }, []);
  return (
    <EngineProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        <Router />
      </SafeAreaView>
    </EngineProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
