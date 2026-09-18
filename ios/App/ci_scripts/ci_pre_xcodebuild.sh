#!/bin/sh
# Xcode Cloud runs this before it runs xcodebuild, which is the last moment the
# build number can still be changed.
#
# CURRENT_PROJECT_VERSION is committed (build 5 at the time of writing) because
# `npm run release:ios` raises it by one on the machine that archives. Xcode
# Cloud never runs that script, so every cloud build would carry whatever
# number happens to be committed — and App Store Connect refuses a build number
# it has already seen for this MARKETING_VERSION. It refuses it AFTER the
# archive, the export and the upload have all run, which is the exact waste
# scripts/ios-build-number.mjs was written to prevent.
#
# CI_BUILD_NUMBER is the cloud's own counter and it only ever goes up, so it is
# the right source here. The working copy is thrown away after the build; this
# never reaches a commit.
#
# IT IS THE CLOUD'S COUNTER, NOT THE REPOSITORY'S, and it starts at 1 for a new
# workflow. So the two ways of shipping do not mix by themselves: upload a build
# by hand from Xcode (`npm run release:ios` raises the committed number, 5 -> 6
# -> 7) and the cloud's first build is still 1, which App Store Connect has
# already seen for this MARKETING_VERSION and refuses — after the archive and
# the upload, as ever. Running on your own device is not an upload and collides
# with nothing.
#
# Pick one: let the cloud do the uploading, or raise the workflow's build number
# in App Store Connect above the highest you have uploaded by hand. This script
# cannot tell which builds App Store Connect has seen, so it cannot pick for you.
set -eu

: "${CI_PRIMARY_REPOSITORY_PATH:?ci_pre_xcodebuild: CI_PRIMARY_REPOSITORY_PATH is unset — this script only runs under Xcode Cloud}"
cd "$CI_PRIMARY_REPOSITORY_PATH"

if [ -z "${CI_BUILD_NUMBER:-}" ]; then
  echo "ci_pre_xcodebuild: no CI_BUILD_NUMBER — leaving the committed build number alone"
  exit 0
fi

# --- Node. Keep this block identical to the one in ci_post_clone.sh. ---
# This runs in a shell of its own, so the PATH ci_post_clone.sh exported is gone
# and the image has no node of its own. That is not hypothetical: the first
# version of this file inherited nothing and died with "node: command not found"
# at exit 127. Usually ci_post_clone.sh has already put a node here and the `if`
# is a no-op; it reinstalls rather than failing if Apple has swept the
# directory, because a red build at this point costs everything before it.
NODE_VERSION=v22.23.2
case "$(uname -m)" in
  arm64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *) echo "ci_pre_xcodebuild: no node tarball for $(uname -m)" >&2; exit 1 ;;
esac
NODE_DIR="$CI_PRIMARY_REPOSITORY_PATH/.drafter-ci/node-$NODE_VERSION-darwin-$NODE_ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  NODE_TGZ="node-$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
  rm -rf "$NODE_DIR" "$NODE_DIR.tmp"
  mkdir -p "$NODE_DIR.tmp"
  (
    cd "$NODE_DIR.tmp"
    curl -fsSL --retry 5 --retry-connrefused -O "https://nodejs.org/dist/$NODE_VERSION/$NODE_TGZ"
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

# Duplicated rather than sourced: a shared helper would be one more assumption
# about what Xcode Cloud stages and how $0 reads there. The duplicate assumes
# nothing, and apple-links.test.ts holds the two NODE_VERSIONs equal.
node scripts/ios-build-number.mjs --set "$CI_BUILD_NUMBER"
