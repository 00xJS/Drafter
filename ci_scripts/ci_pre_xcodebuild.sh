#!/bin/sh
# Xcode Cloud runs this after the package graph is resolved and before it
# builds, which is the last moment the build number can still be changed.
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
set -e

cd "$CI_PRIMARY_REPOSITORY_PATH"

if [ -z "$CI_BUILD_NUMBER" ]; then
  echo "ci_pre_xcodebuild: no CI_BUILD_NUMBER — leaving the committed build number alone"
  exit 0
fi

node scripts/ios-build-number.mjs --set "$CI_BUILD_NUMBER"
