#!/usr/bin/env zsh
#
# Things to do before publishing frugal-iot-logger:
#
#   npm run prerelease              # says what it is doing at each step
#   zsh scripts/prerelease.zsh -q   # says nothing unless something is wrong
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
#
# Exit status, which is what the release script in frugal-iot-demo goes on:
#   0  nothing wrong - and under -q, nothing printed either
#   1  the tests failed, or the schema has an error in it (a devices.yaml entry naming a module or
#      a leaf that does not exist - never deliberate, and it silently loses a row from a card)
# Schema warnings are judgement calls, so they are printed but do not fail the run. The ones that
# were always going to be there - the topics that are dimensionless on purpose - are listed in
# UNITS_EXEMPT in frugal-iot-server/scripts/check-schema.js and are not mentioned at all, so
# anything a quiet run does print is new.
#
# Nothing here is committed and nothing is published - that is still yours.

set -euo pipefail

QUIET=0
for arg in "$@"; do
  case "$arg" in
    -q|--quiet) QUIET=1 ;;
    -h|--help)  sed -n '2,27p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)          print -u2 "Unknown option: $arg (try -q, or -h)"; exit 2 ;;
  esac
done

# Progress, as opposed to a problem: silent under -q. Problems print either way, so a quiet run
# that prints anything is a quiet run that found something.
say() { (( QUIET )) || print -r -- "$@" }

HERE="${0:A:h:h}"                     # The frugal-iot-logger checkout this script is in
SERVER="${HERE:h}/frugal-iot-server"
CHECKER="${SERVER}/scripts/check-schema.js"
COPIER="${SERVER}/scripts/copy-schema-to-examples.zsh"

cd "$HERE"

# Passed on to the scripts in frugal-iot-server, which take the same flag
QARG=()
(( QUIET )) && QARG=(-q)

say "=== Running the tests ==="
# Nothing below is worth doing if the logger is broken. They need no broker, no Firebase and no
# network. Quiet keeps npm's own noise out of the way but still shows everything on a failure,
# which is the one time you want all of it.
if (( QUIET )); then
  if ! TESTOUT=$(npm test 2>&1); then
    print -r -- "$TESTOUT"
    print -u2 "npm test failed in ${HERE}"
    exit 1
  fi
else
  npm test                            # set -e above, so a failure here stops the rest
fi

say
say "=== Bringing the examples' schema up to date from frugal-iot-server ==="
if [[ ! -f "$COPIER" ]]; then
  say "  No ${COPIER}, so the examples were left as they are."
  say "  Clone frugal-iot-server beside this checkout to have them updated."
else
  zsh "$COPIER" "${QARG[@]}" "$HERE"
fi

say
say "=== Checking that schema ==="
SCHEMA_ERRORS=0
if [[ ! -f "$CHECKER" ]]; then
  say "  No ${CHECKER}, so the schema was not checked."
  say "  Clone frugal-iot-server beside this checkout to have it looked at."
else
  # One example is enough: they all hold the same file, copied above. Checking every one would just
  # repeat the same warnings, which trains you to skim past them.
  DIRS=(examples/*/config.d/schema(N/))
  if (( ${#DIRS} )); then
    # An error exit means something that cannot be right, and that is worth failing the release
    # for; a warning prints and exits 0, so this only fails on the former.
    node "$CHECKER" "${QARG[@]}" "${DIRS[1]}" || SCHEMA_ERRORS=1
    if (( ${#DIRS} > 1 )); then
      say "  (${#DIRS} examples hold this schema; they are all the same file, so only one was checked)"
    fi
  else
    say "  No examples/*/config.d/schema directories here"
  fi
fi

say
say "=== Reminders ==="
say "  - Is the version in package.json the one you mean to publish?  $(node -e 'console.log(require("./package.json").version)')"
say "  - frugal-iot-server depends on this package, so if you have changed anything it calls"
say "    (flush, start, schemaField ...), publish this first and require the new version there."
say "  - Nothing here is committed or published - do that yourself."

if (( SCHEMA_ERRORS )); then
  print -u2 "Schema errors above - a card will silently lose a row until these are fixed."
  exit 1
fi
