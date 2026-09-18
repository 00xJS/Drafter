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
# THIS FILE ONLY RUNS IF IT SITS IN ci_scripts NEXT TO App.xcodeproj — that is
# ios/App/ci_scripts/, not the repository root. Apple: "Custom build scripts
# reside in a directory named ci_scripts that's located in the same directory
# as your Xcode project or workspace." Xcode Cloud says NOTHING when it cannot
# find the directory: the build goes straight on to package resolution, finds
# no node_modules, and fails there — which reads like a package problem and is
# not one. That is exactly what the first cloud build did.
#
# Keep this in step with .github/workflows/ci.yml (the Node line) and with
# package.json's build:ios (the build itself).
set -eu

# The scripts run with their own directory as the working directory, so nothing
# below may be relative to the checkout without this. Xcode Cloud sets the
# variable for every script; `cd ../../..` would work today and break the day
# the project moves.
: "${CI_PRIMARY_REPOSITORY_PATH:?ci_post_clone: CI_PRIMARY_REPOSITORY_PATH is unset — this script only runs under Xcode Cloud}"
cd "$CI_PRIMARY_REPOSITORY_PATH"

# npm and the Capacitor CLI both read CI; neither should wait on a prompt.
export CI=true
export npm_config_audit=false
export npm_config_fund=false
export npm_config_fetch_retries=5

# Checked BEFORE the build, not after it. Vite inlines these two into the
# bundle, and .env.ios does not carry them — it only has VITE_API_BASE. Without
# them the build SUCCEEDS and ships an app in local-only mode, with no sync and
# no sign-in, which is a far worse failure than a red build. They come from the
# workflow's environment variables in App Store Connect.
: "${VITE_SUPABASE_URL:?ci_post_clone: set VITE_SUPABASE_URL on the Xcode Cloud workflow, or this build ships in local-only mode}"
: "${VITE_SUPABASE_ANON_KEY:?ci_post_clone: set VITE_SUPABASE_ANON_KEY on the Xcode Cloud workflow, or this build ships in local-only mode}"

# --- Node. Keep this block identical to the one in ci_pre_xcodebuild.sh. ---
# From the official tarball, not Homebrew. The image ships no node, and brew is
# no longer a way to get one here: node@22 is keg-only so it never lands on
# PATH, /opt/homebrew is the Apple-silicon prefix only, and Homebrew moved macOS
# Intel to tier 3 in September 2026 and stopped publishing x86_64 bottles — so
# on an Intel runner every install compiles from source. The tarball needs no
# compiler and reads the same on both architectures.
#
# Neither package.json nor package-lock.json declares an engines field, so this
# matches the version CI pins (.github/workflows/ci.yml: node-version 22).
NODE_VERSION=v22.23.2
case "$(uname -m)" in
  arm64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *) echo "ci_post_clone: no node tarball for $(uname -m)" >&2; exit 1 ;;
esac
# Inside the clone on purpose: Apple deletes files a custom build script creates
# elsewhere, and what one script writes is not otherwise available to another.
NODE_DIR="$CI_PRIMARY_REPOSITORY_PATH/.drafter-ci/node-$NODE_VERSION-darwin-$NODE_ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  NODE_TGZ="node-$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
  rm -rf "$NODE_DIR" "$NODE_DIR.tmp"
  mkdir -p "$NODE_DIR.tmp"
  (
    cd "$NODE_DIR.tmp"
    curl -fsSL --retry 5 --retry-connrefused -O "https://nodejs.org/dist/$NODE_VERSION/$NODE_TGZ"
    # A truncated download is otherwise a baffling tar error.
    curl -fsSL --retry 5 --retry-connrefused "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" \
      | grep " $NODE_TGZ$" | shasum -a 256 -c -
    tar -xzf "$NODE_TGZ"
  )
  mv "$NODE_DIR.tmp/node-$NODE_VERSION-darwin-$NODE_ARCH" "$NODE_DIR"
  rm -rf "$NODE_DIR.tmp"
fi
PATH="$NODE_DIR/bin:$PATH"
export PATH
# --- end Node ---

node --version
npm --version

npm ci

# tsc --noEmit && vite build --mode ios && cap sync ios.
# --mode ios loads the committed .env.ios (VITE_API_BASE); the two Supabase
# values checked above are inlined from this environment.
npm run build:ios

# Say which input is missing here, rather than leaving Xcode to fail several
# minutes later with a path and no reason.
test -f ios/App/App/public/index.html || { echo "ci_post_clone: no web assets after cap sync — did vite build run?" >&2; exit 1; }
test -f ios/App/App/capacitor.config.json || { echo "ci_post_clone: capacitor.config.json missing after cap sync" >&2; exit 1; }
test -f ios/App/App/config.xml || { echo "ci_post_clone: config.xml missing after cap sync" >&2; exit 1; }

# The variables were set; this says the value actually reached the bundle.
if grep -rqs "supabase.co" ios/App/App/public/assets; then
  echo "ci_post_clone: Supabase is configured in this bundle"
else
  echo "ci_post_clone: WARNING — VITE_SUPABASE_URL was set but no Supabase URL is in the bundle" >&2
fi

echo "ci_post_clone: web assets, capacitor.config.json and config.xml are in place"
