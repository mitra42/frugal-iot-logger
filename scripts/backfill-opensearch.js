#!/usr/bin/env node
// Load the CSV archive into OpenSearch, from the "type: opensearch" forwarder in an organization's
// YAML file - for a standalone logger. Under frugal-iot-server the forwarders live in its database
// instead, and it has its own command: npx --no frugal-iot-backfill-opensearch <org>
//
//   node scripts/backfill-opensearch.js --config <config dir> --org <org> --data <data dir> [--since 2026-01-01] [--dry-run]
//
// What it does, and why it is safe to repeat, is described at backfillOpenSearch in index.js.

import { MqttLogger, backfillOpenSearch } from '../index.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const configDir = arg('config');
const org = arg('org');
const dataDir = arg('data');
if (!configDir || !org || !dataDir) {
  console.error('usage: node scripts/backfill-opensearch.js --config <dir> --org <org> --data <dir> [--since YYYY-MM-DD] [--dry-run]');
  process.exit(2);
}

new MqttLogger().readYamlConfig(configDir, async (err, config) => {
  if (err) { console.error('Config error:', err); process.exit(1); }
  const fconfig = ((config.organizations || {})[org] || {}).forwarders?.find((f) => f.type === 'opensearch');
  if (!fconfig) { console.error(`No "type: opensearch" forwarder under organizations/${org}.yaml`); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  try {
    const { sent, skippedFiles } = await backfillOpenSearch({
      config: fconfig, org, dataDir, since: arg('since'), dryRun,
      progress: (n) => process.stdout.write(`\r${n} readings`),
    });
    console.log(`\n${dryRun ? 'Would send' : 'Sent'} ${sent} readings; ${skippedFiles} files skipped by "topics:"`);
    process.exit(0);
  } catch (e) { console.error(e.message); process.exit(1); }
});
