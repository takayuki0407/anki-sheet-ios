// App-wide config. Public-facing URLs point at the custom domain kiokumate.tkdevlab.com
// (Cloudflare Pages). ⚠ That domain must be ACTIVE in Cloudflare (custom-domain set up + cert
// issued) before shipping a build that uses these URLs — until then the *.pages.dev URLs are the
// only working ones, and a build pointing here would 404 / fail every API call.

/** Support / contact email (opened from the help screen's お問い合わせ). */
export const SUPPORT_EMAIL = "kiokumate@tkdevlab.com";

/** Public URLs for the legal docs (required by App Store review). Served from the Cloudflare
 * Pages deployment via the custom domain (the *.pages.dev URL also stays valid as a fallback). */
export const PRIVACY_URL = "https://kiokumate.tkdevlab.com/privacy.html";
export const TERMS_URL = "https://kiokumate.tkdevlab.com/terms.html";

/** App Store numeric id (from App Store Connect once the app exists) — for the rate prompt. */
export const APP_STORE_ID = ""; // e.g. "1234567890"

/** Shown in the About screen. Keep in sync with app.json version. */
export const APP_VERSION = "1.0.0";

/** Opens the user's App Store subscription management page. */
export const MANAGE_SUBSCRIPTIONS_URL = "https://apps.apple.com/account/subscriptions";
