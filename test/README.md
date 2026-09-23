# Tests

```bash
npm test                              # everything
node --test test/organization.test.js # one file
node --test --test-name-pattern=dedup 'test/*.test.js'
node --test --watch 'test/*.test.js'  # while working on something
```

They use Node's built-in test runner (`node:test` and `node:assert/strict`), so there is nothing to
install beyond what the logger already needs, and nothing to keep up to date. `npm run prerelease`
runs them first and stops if they fail.

Nothing here touches a broker, Firebase, Google Sheets or the network, and nothing writes outside a
temporary directory that is removed again. A run takes well under a second.

## What is where

| File | Covers |
|------|--------|
| `pure.test.js` | `valueFromText`, `significantlyDifferent`, `isDuplicate`, `topicToDir` |
| `subscription.test.js` | Which subscription a delivered message belongs to (`+`, `#`, exact) |
| `flush.test.js` | Collecting readings in memory and writing them out a batch at a time |
| `organization.test.js` | Resolving a topic against the schema, `shouldLog`, what reaches the CSV |
| `logger.test.js` | Reading the config, the W3C Thing Descriptor, `sendAction` |
| `forwarder.test.js` | Firebase and Google Sheets forwarding, with the SDK and `fetch` stood in for |
| `support.js` | The schema fixture, an organization built on it, temp directories |
| `fixtures/config/` | A small `config.yaml` + `config.d/` tree for the config reader |

## Conventions

The schema in `support.js` is a cut-down stand-in for `config.d/schema/{topics,modules}.yaml`. It is
deliberately small, but carries one example of each thing the resolution code has to get right - a
plain topic, a `leaf_from` redirect, a module-level override of a topic-level setting, a writable
topic, and two module names where one is a prefix of the other. Extend it rather than building a
second schema in a test file, so there is one place to look.

The tests were written against the logger as it already behaved, so they describe what it does
rather than what it was specified to do. Where a test names a reason ("a retained message is the
broker replaying its store, not a new reading"), that reason comes from a comment in `index.js`
next to the code.

`index.js` exports `_test` alongside `MqttLogger` and `MqttOrganization`. It exists only for these
tests - it reaches the module-private helpers and lets a test set the two module-level settings
(`dataDir`, `flushseconds`) that `MqttLogger.start()` would otherwise take from a config. Nothing in
the logger itself reads it, and nothing outside `test/` should.

Anything that writes files calls `resetModuleState(dir)` in `beforeEach` and flushes in
`afterEach`: the batching state is module-level, so a test that leaves rows queued would otherwise
have them written during the next one.

## Known gaps

- `MqttOrganization.startClient` and `Firebase.start`, which need a broker and the Firebase SDK
  respectively. The message handling below them is covered by calling `dispatch`/`writeData`
  directly.
- `MqttLogger.start` and `catchSignals` - they install process-wide signal handlers.
- Malformed yaml in the config: `js-yaml` throws from inside the `readFile` callback rather than
  handing the error to the waterfall, so it escapes `readYamlConfig` as an uncaught exception
  instead of reaching the caller's `cb(err)`. There is no test asserting either the crash or the
  error it does not produce; see the note in `logger.test.js`.
