#!/usr/bin/env zsh
#
# Things to do before publishing frugal-iot-logger:
#
#   npm run prerelease
#
# The examples here each carry their own copy of the sensor schema, and it is the logger that acts on
# "log" and "duplicates", so this checks those copies for the mistakes that are expensive - a sensor
# that says nothing about whether it is recorded, or one recorded with no rule about how often.
#
# The check itself lives in frugal-iot-server, which is where the schema is maintained, and is
# expected as a sibling checkout. frugal-iot-server's own prerelease script copies the schema into
# the examples here, so run that one first if the two have drifted.

set -euo pipefail

HERE="${0:A:h:h}"                     # The frugal-iot-logger checkout this script is in
SERVER="${HERE:h}/frugal-iot-server"
CHECKER="${SERVER}/scripts/check-schema.js"

cd "$HERE"

echo "=== Checking the schema in the examples ==="
if [[ ! -f "$CHECKER" ]]; then
  echo "  No ${CHECKER}, so the schema was not checked."
  echo "  Clone frugal-iot-server beside this checkout to have it looked at."
else
  DIRS=(examples/*/config.d/schema(N/))
  if (( ${#DIRS} )); then
    node "$CHECKER" $DIRS || true
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
