#!/usr/bin/env zsh
#
# Things to do before publishing frugal-iot-logger:
#
#   npm run prerelease
#
# The examples here each carry their own copy of the sensor schema. That schema is maintained in
# frugal-iot-server, so this brings the copies up to date and then checks one of them for the
# mistakes that are expensive - a sensor that says nothing about whether it is recorded, or one
# recorded with no rule about how often. It is the logger that acts on those settings, which is why
# the check runs here as well as there.
#
# The tests run first, and a failure there stops everything else.
#
# The two schema steps need frugal-iot-server as a sibling checkout, which is how these are
# developed. Without it they are skipped with a note, rather than failing.

set -euo pipefail

HERE="${0:A:h:h}"                     # The frugal-iot-logger checkout this script is in
SERVER="${HERE:h}/frugal-iot-server"
CHECKER="${SERVER}/scripts/check-schema.js"
COPIER="${SERVER}/scripts/copy-schema-to-examples.zsh"

cd "$HERE"

echo "=== Running the tests ==="
# set -e above, so a failure here stops the rest - nothing below is worth doing if the logger is
# broken. They need no broker, no Firebase and no network.
npm test

echo
echo "=== Bringing the examples' schema up to date from frugal-iot-server ==="
if [[ ! -f "$COPIER" ]]; then
  echo "  No ${COPIER}, so the examples were left as they are."
  echo "  Clone frugal-iot-server beside this checkout to have them updated."
else
  zsh "$COPIER" "$HERE"
fi

echo
echo "=== Checking that schema ==="
if [[ ! -f "$CHECKER" ]]; then
  echo "  No ${CHECKER}, so the schema was not checked."
  echo "  Clone frugal-iot-server beside this checkout to have it looked at."
else
  # One example is enough: they all hold the same file, copied above. Checking every one would just
  # repeat the same warnings, which trains you to skim past them.
  DIRS=(examples/*/config.d/schema(N/))
  if (( ${#DIRS} )); then
    node "$CHECKER" "${DIRS[1]}" || true
    if (( ${#DIRS} > 1 )); then
      echo "  (${#DIRS} examples hold this schema; they are all the same file, so only one was checked)"
    fi
  else
    echo "  No examples/*/config.d/schema directories here"
  fi
fi

echo
echo "=== Reminders ==="
echo "  - Is the version in package.json the one you mean to publish?  $(node -e 'console.log(require("./package.json").version)')"
echo "  - frugal-iot-server depends on this package, so if you have changed anything it calls"
echo "    (flush, start, schemaField ...), publish this first and require the new version there."
echo "  - Nothing here is committed or published - do that yourself."
