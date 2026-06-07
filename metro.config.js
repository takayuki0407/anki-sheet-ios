// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The WebView PDF engine ships as a single bundled archive (assets/engine.zip),
// extracted to the document directory on first launch. Metro must treat .zip as an
// asset so require("./assets/engine.zip") resolves.
config.resolver.assetExts.push("zip");

module.exports = config;
