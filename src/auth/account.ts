// Account / auth state. Wires Firebase Auth sign-in (Apple, email) to RevenueCat so the
// `premium` entitlement follows the user across iOS and web (Purchases.logIn(uid)).
// All functions no-op or throw a friendly error when auth isn't configured yet.
import { create } from "zustand";
import {
  OAuthProvider,
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import Purchases from "react-native-purchases";
import { getFirebaseAuth, isAuthConfigured } from "./firebase";
import { syncCustomerInfo } from "../iap/purchases";

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
    // Tie the RevenueCat user to the Firebase uid so entitlements sync across platforms, and
    // apply the returned CustomerInfo immediately (don't rely on the async listener) so the gate
    // can't briefly lock a subscriber out on logout or miss a web entitlement on login.
    (async () => {
      try {
        if (u) {
          const { customerInfo } = await Purchases.logIn(u.uid);
          syncCustomerInfo(customerInfo);
        } else {
          const customerInfo = await Purchases.logOut();
          syncCustomerInfo(customerInfo);
        }
      } catch {
        /* RevenueCat not configured yet */
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

/** Delete the account (App Store requires in-app deletion). May need a recent re-login. */
export async function deleteAccount(): Promise<void> {
  const auth = getFirebaseAuth();
  const u = auth?.currentUser;
  if (!u) return;
  await deleteUser(u);
}
