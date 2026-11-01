#!/usr/bin/env node
// Load the CSV archive into OpenSearch, for history from before the forwarder was switched on, or
// to fill a gap after OpenSearch was down (the forwarder drops a batch it cannot send).
//
//   node scripts/backfill-opensearch.js --config <config dir> --org <org> --data <data dir> [--since 2026-01-01] [--dry-run]
//
// The connection details are read from the organization's first "type: opensearch" entry under
// "forwarders:", so credentials stay out of the shell history. Its "topics:" list is honoured.
// Safe to repeat or to run while the logger is live: a reading's id comes from its topic and time,
// so one that is already there is replaced, not doubled.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import nodepath from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MqttLogger, _test } from '../index.js';

const { OpenSearch, openSearchDoc, openSearchBulkBody } = _test;
const BATCH = 1000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const configDir = arg('config');
const org = arg('org');
const dataDir = arg('data');
const since = arg('since', '0000-00-00'); // file names are dates, so string comparison works
const dryRun = process.argv.includes('--dry-run');
if (!configDir || !org || !dataDir) {
  console.error('usage: node scripts/backfill-opensearch.js --config <dir> --org <org> --data <dir> [--since YYYY-MM-DD] [--dry-run]');
  process.exit(2);
}

// Every csv under data/<org>, as { topic, file }. The directory path below the data dir is the topic.
function* csvFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = nodepath.join(dir, entry.name);
    if (entry.isDirectory()) { yield* csvFiles(p); }
    else if (/^\d{4}-\d{2}-\d{2}\.csv(\.gz)?$/.test(entry.name) && entry.name.substring(0, 10) >= since) {
      yield { topic: nodepath.relative(dataDir, dir).split(nodepath.sep).join('/'), file: p };
    }
  }
}

// Lines are:  1703318400000,"25.3"   Numbers come back as numbers, as the live forwarder would send.
function* readings(file) {
  const raw = readFileSync(file);
  const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
  for (const line of text.split('\n')) {
    const m = /^(\d+),"(.*)"$/.exec(line);
    if (!m) continue;
    const n = m[2] === '' ? NaN : Number(m[2]);
    yield { date: new Date(Number(m[1])), value: Number.isNaN(n) ? m[2] : n };
  }
}

const logger = new MqttLogger();
logger.readYamlConfig(configDir, async (err, config) => {
  if (err) { console.error('Config error:', err); process.exit(1); }
  const fconfig = ((config.organizations || {})[org] || {}).forwarders?.find((f) => f.type === 'opensearch');
  if (!fconfig) { console.error(`No "type: opensearch" forwarder under organizations/${org}.yaml`); process.exit(1); }
  const f = new OpenSearch(fconfig, { id: org });
  if (!dryRun) { f.start(); f.stop(); } // builds the client; the flush timer is not wanted
  f.initialized = true;
  if (!dryRun) await f.ready; // the index template, so the types are right
  if (!statSync(nodepath.join(dataDir, org), { throwIfNoEntry: false })) {
    console.error(`No ${nodepath.join(dataDir, org)}`); process.exit(1);
  }
  let docs = [], sent = 0, skipped = 0;
  const send = async () => {
    if (docs.length === 0) return;
    if (!dryRun) {
      const res = await f.client.bulk({ body: openSearchBulkBody(f.indexPrefix, docs) });
      const body = res.body || res;
      if (body.errors) { console.error('Some readings were rejected, first:', JSON.stringify(body.items.find((i) => i.index?.error)?.index.error)); }
    }
    sent += docs.length;
    docs = [];
    process.stdout.write(`\r${sent} readings`);
  };
  for (const { topic, file } of csvFiles(nodepath.join(dataDir, org))) {
    if (!f.wanted(topic)) { skipped++; continue; }
    for (const { date, value } of readings(file)) {
      const doc = openSearchDoc(date, topic, value);
      if (doc) docs.push(doc);
      if (docs.length >= BATCH) await send();
    }
  }
  await send();
  console.log(`\n${dryRun ? 'Would send' : 'Sent'} ${sent} readings; ${skipped} files skipped by "topics:"`);
  process.exit(0);
});
