/**
 * electron-builder afterPack hook: ad-hoc sign the macOS app bundle.
 *
 * Without a Developer ID certificate electron-builder skips signing and ships
 * Electron's bare per-binary signatures (arm64: linker-signed, x64: none) with
 * no bundle seal. macOS rejects a downloaded copy of that bundle as "ByTune is
 * damaged and can't be opened. You should move it to the Trash." — a dead end
 * with no Open Anyway button. A complete ad-hoc signature (identity "-") turns
 * it into an ordinary unnotarized app the user can allow once in
 * System Settings → Privacy & Security.
 *
 * Hardened runtime stays off: an ad-hoc signature has no Team ID, so library
 * validation would refuse to load Electron Framework and the app would crash
 * at launch. When a Developer ID is configured, electron-builder's own signing
 * pass runs after this hook and re-signs everything with --force.
 */
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  // electron-builder's own signer; it signs inside-out and ends with
  // `codesign --verify --deep --strict`, throwing (failing the build) if the
  // seal is not valid.
  const { signApp } = require("@electron/osx-sign");
  await signApp({
    app: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    identity: "-",
    identityValidation: false,
    platform: "darwin",
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      hardenedRuntime: false,
      timestamp: "none",
      entitlements: path.join(__dirname, "..", "build", "entitlements.mac.plist"),
    }),
  });
};
