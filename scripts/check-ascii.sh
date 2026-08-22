#!/bin/sh
# Presubmit: every tracked file is 7-bit ASCII.  Tab and LF are the
# only control characters allowed; everything else must be in the
# space..tilde range.  Run from the repository root.
#
# Scans the index (what will be committed), not the working tree, so
# the result is the same on a Windows checkout with core.autocrlf as
# on the CI runner: the committed blobs are LF either way.
#
# Exempt, and nothing else: the vendored Gradle wrapper (script and
# jar), and the vendored web fonts and favicon -- binary bytes
# preserved verbatim.  A new binary asset is added here deliberately,
# not skipped silently.
set -eu

TAB=$(printf '\t')
if LC_ALL=C git grep --cached -n -e "[^${TAB} -~]" -- . \
    ':(exclude)gradlew' \
    ':(exclude)gradle/wrapper/gradle-wrapper.jar' \
    ':(exclude)web-app/public/favicon.ico' \
    ':(exclude)web-app/public/fonts/*.woff2'; then
  echo "check-ascii: non-ASCII or control bytes found (listed above)" >&2
  exit 1
fi
echo "check-ascii: OK"
