#!/bin/sh
# Xcode Cloud runs this straight after cloning, before it resolves the Swift
# package graph. Without it a cloud build cannot succeed, because three of the
# App target's Resources build inputs are generated rather than committed
# (ios/.gitignore):
#
#   App/App/public              the Vite bundle, a FOLDER reference in the
#                               project — a missing folder reference is a hard
#                               "Build input file cannot be found", not a blank app
#   App/App/capacitor.config.json
#   App/App/config.xml
#
# and because ios/App/CapApp-SPM/Package.swift resolves seven plugins through
# ../../../node_modules, so `npm ci` has to run before package resolution, not
# after it. A local Xcode build never notices any of this: the working tree
# already has dist/, the config files and node_modules from the last
# `npm run build:ios`.
#
# Keep this in step with .github/workflows/ci.yml (the Node line) and with
# package.json's build:ios (the build itself).
set -e

# Neither package.json nor package-lock.json declares an engines field, so the
# version CI pins is the one this matches.
export HOMEBREW_NO_AUTO_UPDATE=1
brew install node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

cd "$CI_PRIMARY_REPOSITORY_PATH"

node --version
npm --version

npm ci

# tsc --noEmit && vite build --mode ios && cap sync ios.
# --mode ios loads the committed .env.ios (VITE_API_BASE). VITE_SUPABASE_URL
# and VITE_SUPABASE_ANON_KEY are inlined here too, and they come from the
# workflow's environment variables in App Store Connect — without them the
# build succeeds and ships an app in local-only mode, with no sync and no
# sign-in, which is a far worse failure than a red build.
npm run build:ios

# Say which input is missing here, rather than leaving Xcode to fail several
# minutes later with a path and no reason.
test -f ios/App/App/public/index.html || { echo "ci_post_clone: no web assets after cap sync — did vite build run?"; exit 1; }
test -f ios/App/App/capacitor.config.json || { echo "ci_post_clone: capacitor.config.json missing after cap sync"; exit 1; }
test -f ios/App/App/config.xml || { echo "ci_post_clone: config.xml missing after cap sync"; exit 1; }

# The app is signed in as the account that built it only if these were set; say
# so in the log, because the symptom otherwise appears days later on a phone.
if grep -rqs "supabase.co" ios/App/App/public/assets; then
  echo "ci_post_clone: Supabase is configured in this bundle"
else
  echo "ci_post_clone: WARNING — no Supabase URL in the bundle. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY"
  echo "ci_post_clone: on the Xcode Cloud workflow, or this build ships in local-only mode."
fi
