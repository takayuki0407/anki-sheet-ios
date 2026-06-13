// Account / auth state. Wires Firebase Auth sign-in (Apple, email) to RevenueCat so the
// `premium` entitlement follows the user across iOS and web (Purchases.logIn(uid)).
// All functions no-op or throw a friendly error when auth isn't configured yet.
import { create } from "zustand";
import {
  OAuthProvider,
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import Purchases from "react-native-purchases";
import { getFirebaseAuth, isAuthConfigured } from "./firebase";
import { initPurchases, syncCustomerInfo } from "../iap/purchases";
import { deleteAccountData } from "../sync/api";
import { getMeta, setMeta } from "../db/repo";
import { clearAllLocalData } from "../db/backup";
import { loadDeviceName } from "../sync/device";
import { useApp } from "../store/session";

export interface AccountUser {
  uid: string;
  email: string | null;
}

interface AccountState {
  user: AccountUser | null;
  ready: boolean;
  set: (p: Partial<AccountState>) => void;
}

export const useAccount = create<AccountState>((set) => ({
  user: null,
  ready: !isAuthConfigured, // if auth isn't set up, we're "ready" with no user
  set: (p) => set(p),
}));

export { isAuthConfigured };

let started = false;
/** Start listening to auth state and keep RevenueCat's user id in sync. Call once at start. */
export function initAuthListener(): void {
  if (started) return;
  started = true;
  const auth = getFirebaseAuth();
  if (!auth) {
    useAccount.getState().set({ ready: true });
    return;
  }
  onAuthStateChanged(auth, (u: User | null) => {
    useAccount.getState().set({
      user: u ? { uid: u.uid, email: u.email } : null,
      ready: true,
    });
    // Different-account guard: if a DIFFERENT account signs in on this device, wipe the previous
    // account's local data (it's owned by / locked to that account). Same account or a first
    // sign-in keeps the data (adopts ownership). Sign-out keeps the data (the gate locks it).
    if (u) {
      void (async () => {
        const prev = await getMeta("ownerUid");
        if (prev && prev !== u.uid) {
          await clearAllLocalData();
          // The wipe emptied the meta table — reload the in-memory device-name cache so the new
          // account doesn't keep registering books under the previous user's custom device name.
          await loadDeviceName();
          // Force the bookshelf to re-query the (now empty) DB — without this the previous account's
          // books linger on screen until the next navigation (the wipe doesn't re-render on its own).
          useApp.getState().bumpDecks();
        }
        await setMeta("ownerUid", u.uid);
      })();
    }
    // Tie the RevenueCat user to the Firebase uid so entitlements sync across platforms, and
    // apply the returned CustomerInfo immediately (don't rely on the async listener) so the gate
    // can't briefly lock a subscriber out on logout or miss a web entitlement on login.
    (async () => {
      try {
        // Wait for configure() — at cold start this listener can fire before RC is configured,
        // and a thrown logIn here would leave purchases attributed to an anonymous id.
        if (!(await initPurchases())) return; // RC not configured (Expo Go / placeholder key)
        if (u) {
          const { customerInfo } = await Purchases.logIn(u.uid);
          syncCustomerInfo(customerInfo);
        } else {
          const customerInfo = await Purchases.logOut();
          syncCustomerInfo(customerInfo);
        }
      } catch {
        /* offline / already-anonymous logOut — the update listener resyncs later */
      }
    })();
  });
}

function requireAuth() {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error("ログイン機能はまだ設定されていません（Firebase未設定）。");
  return auth;
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(requireAuth(), email.trim(), password);
}

export async function signUpWithEmail(email: string, password: string): Promise<void> {
  await createUserWithEmailAndPassword(requireAuth(), email.trim(), password);
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(requireAuth(), email.trim());
}

/** Native Sign in with Apple (works on a dev build / TestFlight, not in Expo Go). */
export async function signInWithApple(): Promise<void> {
  const auth = requireAuth();
  const rawNonce = `${Crypto.randomUUID()}${Crypto.randomUUID()}`;
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );
  const cred = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    nonce: hashedNonce,
  });
  if (!cred.identityToken) throw new Error("Apple認証に失敗しました。");
  const provider = new OAuthProvider("apple.com");
  const credential = provider.credential({ idToken: cred.identityToken, rawNonce });
  await signInWithCredential(auth, credential);
}

export async function appleAvailable(): Promise<boolean> {
  return AppleAuthentication.isAvailableAsync().catch(() => false);
}

export async function signOut(): Promise<void> {
  const auth = getFirebaseAuth();
  if (auth) await fbSignOut(auth);
}

/** Delete the account (App Store requires in-app deletion). Order matters: remove the auth user
 * FIRST (this is what fails with requires-recent-login — and it touches no data, so a failure is a
 * clean abort), THEN purge cloud data with the token captured beforehand. A Firebase ID token stays
 * signature-valid for ~1h after the user is gone, so the server still accepts the purge call. This
 * avoids the "cloud data deleted but account still exists" state of purging first. */
export async function deleteAccount(): Promise<void> {
  const auth = getFirebaseAuth();
  const u = auth?.currentUser;
  if (!u) throw new Error("ログインしていません。"); // never silently report "deleted"
  const token = await u.getIdToken(); // capture BEFORE deleteUser — valid for the purge afterwards
  await deleteUser(u); // throws auth/requires-recent-login here, before any data is touched
  await deleteAccountData(token); // erase R2 + D1 data for this account
}
