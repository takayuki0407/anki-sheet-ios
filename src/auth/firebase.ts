// Firebase app + Auth. Fully guarded: when the config isn't set (no env vars), auth is
// "disabled" and the rest of the app still runs (incl. Expo Go). Fill these from your
// Firebase project (Project settings → your Web/iOS app), via EXPO_PUBLIC_FIREBASE_*.
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import * as fbAuth from "firebase/auth";
import { secureStorePersistence } from "./secureStorage";

const cfg = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? "",
};

export const isAuthConfigured = !!cfg.apiKey && !!cfg.appId;

let auth: fbAuth.Auth | null = null;

/** Firebase Auth instance, or null when not configured (auth features disabled). */
export function getFirebaseAuth(): fbAuth.Auth | null {
  if (!isAuthConfigured) return null;
  if (!auth) {
    const app: FirebaseApp = getApps().length ? getApp() : initializeApp(cfg);
    // Keychain-backed persistence so the session (incl. the long-lived refresh token)
    // survives restarts without sitting in plaintext — see ./secureStorage. The
    // persistence API shape varies across firebase versions, so resolve it defensively.
    const getRNP = (
      fbAuth as unknown as { getReactNativePersistence?: (s: unknown) => fbAuth.Persistence }
    ).getReactNativePersistence;
    try {
      auth = getRNP
        ? fbAuth.initializeAuth(app, { persistence: getRNP(secureStorePersistence) })
        : fbAuth.getAuth(app);
    } catch {
      auth = fbAuth.getAuth(app); // already initialized
    }
  }
  return auth;
}
