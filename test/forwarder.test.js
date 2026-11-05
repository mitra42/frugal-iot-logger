// The forwarders. Neither the Firebase SDK nor Google's endpoint is reachable from a test, so the
// database handle and fetch are stood in for - what is being tested is the logger's own decisions:
// which nodes are forwarded, which values are fit to send, and how a topic is flattened.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../index.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import nodepath from 'node:path';
import { gzipSync } from 'node:zlib';
import { backfillOpenSearch } from '../index.js';
import { makeOrg, makeTempDir } from './support.js';

const { Forwarder, Firebase, Gsheet } = _test;

describe('Forwarder', () => {
  test('makeRow reads the configured topics in order', () => {
    const org = makeOrg();
    org.currentValue = {
      'dev/lotus/n1/sht/temperature': 25.3,
      'dev/lotus/n1/sht/humidity': 65,
    };
    const f = new Forwarder({
      topics: ['dev/lotus/n1/sht/humidity', 'dev/lotus/n1/sht/temperature'],
    }, org);
    assert.deepEqual(f.makeRow(), [65, 25.3]);
  });

  test('a topic never seen leaves a gap rather than shifting the row', () => {
    const org = makeOrg();
    org.currentValue = { 'dev/lotus/n1/sht/temperature': 25.3 };
    const f = new Forwarder({
      topics: ['dev/lotus/n1/sht/temperature', 'dev/lotus/n99/sht/temperature'],
    }, org);
    assert.deepEqual(f.makeRow(), [25.3, undefined]);
  });

  test('start only sets a timer when an interval is configured', () => {
    const org = makeOrg();
    const without = new Forwarder({}, org);
    without.start();
    assert.equal(without.periodicTimer, null);
    assert.equal(without.initialized, true);

    // tick() comes from the subclass - the base class has none, so supply one
    const withInterval = new Forwarder({ intervalSeconds: 3600 }, org);
    withInterval.tick = () => {};
    withInterval.start();
    assert.notEqual(withInterval.periodicTimer, null);
    withInterval.stop();
    assert.equal(withInterval.periodicTimer, null);
    assert.equal(withInterval.initialized, false);
  });
});

describe('Firebase.writeData', () => {
  let fb, writes;

  // Stands in for admin.database() - records what would have been written
  const fakeDb = (writes) => ({
    ref: (path) => ({
      update: (data, cb) => { writes.push({ op: 'update', path, data }); cb(null); },
      push: (data, cb) => { writes.push({ op: 'push', path, data }); cb(null); },
    }),
  });

  const makeFirebase = (config = {}) => {
    const f = new Firebase(config, makeOrg());
    f.db = fakeDb(writes);
    f.initialized = true; // start() would do this, but it needs the real SDK
    return f;
  };

  beforeEach(() => { writes = []; });

  test('updates the node latest under a flattened key', () => {
    fb = makeFirebase();
    fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', 25.3);

    assert.equal(writes.length, 1);
    assert.equal(writes[0].op, 'update');
    assert.equal(writes[0].path, 'nodes/n1/latest');
    assert.deepEqual(writes[0].data, { sht_temperature: 25.3, timestamp: 1000 });
  });

  test('a single-level topic keeps its name', () => {
    fb = makeFirebase();
    fb.writeData(new Date(1000), 'dev/lotus/n1/battery', 3.7);
    assert.deepEqual(writes[0].data, { battery: 3.7, timestamp: 1000 });
  });

  test('nothing is written before start', () => {
    fb = makeFirebase();
    fb.initialized = false;
    fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', 25.3);
    assert.equal(writes.length, 0);
  });

  test('a topic with too few levels is not a reading', () => {
    fb = makeFirebase();
    fb.writeData(new Date(1000), 'dev/lotus/n1', 'something');
    assert.equal(writes.length, 0);
  });

  describe('values Firebase cannot store', () => {
    test('are skipped rather than sent and rejected', () => {
      fb = makeFirebase();
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', undefined);
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', null); // A "nan" reading
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', NaN);
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', Infinity);
      assert.equal(writes.length, 0);
    });

    test('zero, false and the empty string are stored - they are real readings', () => {
      fb = makeFirebase();
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', 0);
      fb.writeData(new Date(1000), 'dev/lotus/n1/relay/on', false);
      fb.writeData(new Date(1000), 'dev/lotus/n1/frugal_iot/description', '');
      assert.equal(writes.length, 3);
      assert.equal(writes[0].data.sht_temperature, 0);
      assert.equal(writes[1].data.relay_on, false);
      assert.equal(writes[2].data.frugal_iot_description, '');
    });
  });

  describe('allowedNodes', () => {
    test('with none configured everything is forwarded', () => {
      fb = makeFirebase({});
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', 25.3);
      fb.writeData(new Date(1000), 'other/field/n9/sht/temperature', 19.0);
      assert.equal(writes.length, 2);
    });

    test('a full path is matched as a prefix', () => {
      fb = makeFirebase({ allowedNodes: ['dev/lotus/esp32'] });
      fb.writeData(new Date(1000), 'dev/lotus/esp32-6c5e0e/sht/temperature', 25.3);
      fb.writeData(new Date(1000), 'dev/lotus/esp8266-fb94bb/sht/temperature', 19.0);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].path, 'nodes/esp32-6c5e0e/latest');
    });

    test('a bare node id is matched exactly', () => {
      fb = makeFirebase({ allowedNodes: ['esp32-6c5e0e'] });
      fb.writeData(new Date(1000), 'dev/lotus/esp32-6c5e0e/sht/temperature', 25.3);
      fb.writeData(new Date(1000), 'dev/lotus/esp32-6c5e0f/sht/temperature', 19.0);
      assert.equal(writes.length, 1);
    });

    test('a whole project can be allowed', () => {
      fb = makeFirebase({ allowedNodes: ['dev/lotus'] });
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', 25.3);
      fb.writeData(new Date(1000), 'dev/other/n2/sht/temperature', 19.0);
      assert.equal(writes.length, 1);
    });
  });

  test('handleMessage is what MqttOrganization calls, and writes', () => {
    fb = makeFirebase();
    fb.handleMessage(new Date(1000), 'dev/lotus/n1/sht/temperature', 25.3);
    assert.equal(writes.length, 1);
  });

  describe('history snapshots', () => {
    test('push one row per node holding every value seen', () => {
      fb = makeFirebase();
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', 25.3);
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/humidity', 65);
      fb.writeData(new Date(1000), 'dev/lotus/n2/sht/temperature', 19.0);
      writes.length = 0;

      fb.tick();

      assert.equal(writes.length, 2);
      const n1 = writes.find((w) => w.path === 'nodes/n1/history');
      assert.equal(n1.op, 'push');
      assert.equal(n1.data.sht_temperature, 25.3);
      assert.equal(n1.data.sht_humidity, 65);
      assert.ok(typeof n1.data.timestamp === 'number');
    });

    test('a node whose values have not changed is not written again', () => {
      // A node in deep sleep would otherwise push an identical row every interval
      fb = makeFirebase();
      fb.writeData(new Date(1000), 'dev/lotus/n1/sht/temperature', 25.3);
      fb.tick();
      writes.length = 0;

      fb.tick();
      assert.equal(writes.length, 0);

      fb.writeData(new Date(2000), 'dev/lotus/n1/sht/temperature', 25.4);
      writes.length = 0; // writeData updates "latest" too - only the history push is of interest
      fb.tick();
      assert.equal(writes.length, 1);
      assert.equal(writes[0].path, 'nodes/n1/history');
    });

    test('a node with nothing recorded is skipped', () => {
      fb = makeFirebase();
      fb.nodeLatestValues['dev/lotus/n1'] = {};
      fb.tick();
      assert.equal(writes.length, 0);
    });
  });
});

describe('Gsheet', () => {
  let org, posts, realFetch;

  beforeEach(() => {
    org = makeOrg();
    org.currentValue = {
      'dev/lotus/n1/sht/temperature': 25.3,
      'dev/lotus/n1/sht/humidity': 65,
    };
    posts = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      posts.push({ url, body: JSON.parse(opts.body), method: opts.method });
      return Promise.resolve({ ok: true });
    };
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  test('posts the sheet name and a row led by the date', () => {
    const gs = new Gsheet({
      url: 'https://script.example.org/exec',
      sheet: 'Sheet1',
      topics: ['dev/lotus/n1/sht/temperature', 'dev/lotus/n1/sht/humidity'],
    }, org);

    gs.tick();

    assert.equal(posts.length, 1);
    assert.equal(posts[0].method, 'POST');
    assert.equal(posts[0].url, 'https://script.example.org/exec');
    assert.equal(posts[0].body.sheet, 'Sheet1');

    const [date, ...values] = posts[0].body.row;
    assert.deepEqual(values, [25.3, 65]);
    // Google Sheets rejects the trailing Z, so the date is sent without it
    assert.match(date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  test('a failed post is reported rather than thrown', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 500 });
    const gs = new Gsheet({ url: 'https://script.example.org/exec', sheet: 'S', topics: [] }, org);

    const lines = [];
    const realError = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      gs.tick();
      await new Promise((r) => setImmediate(r)); // Let the rejection settle
    } finally {
      console.error = realError;
    }
    assert.match(lines.join('\n'), /Failed to append/);
  });

  const captureErrors = async (fn) => {
    const lines = [];
    const realError = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try { fn(); await new Promise((r) => setImmediate(r)); } finally { console.error = realError; }
    return lines.join('\n');
  };
  const SECRET = 'https://script.google.com/macros/s/SECRETWEBHOOKID/exec';

  test('never follows a redirect, since the address is whatever an administrator typed', () => {
    let seen;
    globalThis.fetch = (url, opts) => { seen = opts; return Promise.resolve({ ok: true }); };
    new Gsheet({ url: SECRET, sheet: 'S', topics: [] }, org).tick();
    assert.equal(seen.redirect, 'manual');
  });

  test('a redirect is not a failure - Apps Script runs the script and then redirects to the result', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 302 });
    const logged = await captureErrors(() => new Gsheet({ url: SECRET, sheet: 'S', topics: [] }, org).tick());
    assert.equal(logged, '');
  });

  test('the address is a secret, so a failure names only its host', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 500 });
    const logged = await captureErrors(() => new Gsheet({ url: SECRET, sheet: 'S', topics: [] }, org).tick());
    assert.match(logged, /script\.google\.com/);
    assert.ok(!logged.includes('SECRETWEBHOOKID'));
  });

  test('nor does a network error give it away', async () => {
    globalThis.fetch = () => Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const logged = await captureErrors(() => new Gsheet({ url: SECRET, sheet: 'S', topics: [] }, org).tick());
    assert.match(logged, /fetch failed ECONNREFUSED/);
    assert.ok(!logged.includes('SECRETWEBHOOKID'));
  });
});

describe('topicMatchesPattern', () => {
  const { topicMatchesPattern: m } = _test;
  test('an exact topic matches only itself', () => {
    assert.ok(m('dev/lotus/n1/sht/temperature', 'dev/lotus/n1/sht/temperature'));
    assert.ok(!m('dev/lotus/n1/sht/temperature', 'dev/lotus/n1/sht/humidity'));
    assert.ok(!m('dev/lotus/n1/sht', 'dev/lotus/n1/sht/temperature'));
  });
  test('+ is exactly one level, at any depth', () => {
    assert.ok(m('dev/lotus/+/sht/temperature', 'dev/lotus/n2/sht/temperature'));
    assert.ok(m('dev/+/+/+/temperature', 'dev/lotus/n2/sht/temperature'));
    assert.ok(!m('dev/lotus/+/temperature', 'dev/lotus/n2/sht/temperature'));
  });
  test('a trailing # is everything below', () => {
    assert.ok(m('dev/lotus/#', 'dev/lotus/n1/sht/temperature'));
    assert.ok(m('dev/lotus/+/sht/#', 'dev/lotus/n1/sht/temperature'));
    assert.ok(!m('dev/lotus/+/soil/#', 'dev/lotus/n1/sht/temperature'));
    assert.ok(!m('dev/other/#', 'dev/lotus/n1/sht/temperature'));
  });
});

describe('OpenSearch', () => {
  const { OpenSearch, openSearchDoc, openSearchIndex, openSearchBulkBody } = _test;
  const T = 'dev/lotus/n1/sht/temperature';
  const D = new Date('2026-11-01T10:20:30.000Z');

  // Stands in for the client - records what would have been sent
  const makeOs = (config = {}, bulk) => {
    const sent = [];
    const f = new OpenSearch(config, makeOrg());
    f.client = { bulk: bulk || (async (req) => { sent.push(req.body); return { body: { errors: false } }; }) };
    f.initialized = true; // start() would do this, but it builds a real client
    return { f, sent };
  };

  test('a number goes in value, anything else in value_text', () => {
    assert.deepEqual(openSearchDoc(D, T, 25.3), {
      '@timestamp': '2026-11-01T10:20:30.000Z', org: 'dev', project: 'lotus', node: 'n1',
      module: 'sht', leaf: 'temperature', topic: T, value: 25.3,
    });
    assert.equal(openSearchDoc(D, T, 0).value, 0);
    assert.equal(openSearchDoc(D, T, 'hi').value_text, 'hi');
    assert.equal(openSearchDoc(D, T, { a: 1 }).value_text, '{"a":1}');
  });

  test('a missing reading makes no document', () => {
    assert.equal(openSearchDoc(D, T, null), null);
    assert.equal(openSearchDoc(D, T, undefined), null);
  });

  test('the index is per org and month, in lower case', () => {
    assert.equal(openSearchIndex('frugaliot', openSearchDoc(D, T, 1)), 'frugaliot-dev-2026.11');
  });

  test('the same reading always gets the same id', () => {
    const [a] = openSearchBulkBody('p', [openSearchDoc(D, T, 1)]);
    const [b] = openSearchBulkBody('p', [openSearchDoc(D, T, 2)]);
    assert.equal(a.index._id, `${T}@${D.valueOf()}`);
    assert.equal(a.index._id, b.index._id);
  });

  test('sends buffered readings, many topics in one request, on flush', async () => {
    const { f, sent } = makeOs();
    f.handleMessage(D, T, 25.3, true);
    f.handleMessage(D, 'dev/lotus/n2/sht/humidity', 60, true);
    assert.equal(sent.length, 0);   // buffered, not sent per message
    await f.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 4); // action + doc, twice
    assert.equal(f.buffer.length, 0);
  });

  test('only sends topics that match the configured patterns', async () => {
    const { f, sent } = makeOs({ topics: ['dev/lotus/+/sht/temperature'] });
    f.handleMessage(D, T, 25.3, true);
    f.handleMessage(D, 'dev/lotus/n1/sht/humidity', 60, true);
    f.handleMessage(D, 'dev/lotus/n1/soil/moisture', 10, true);
    await f.flush();
    assert.equal(sent[0].filter((x) => x.topic).length, 1);
    assert.equal(sent[0][1].topic, T);
  });

  test('sends everything when no topics are configured', async () => {
    const { f, sent } = makeOs();
    f.handleMessage(D, T, 1, true);
    f.handleMessage(D, 'dev/lotus/n1/soil/moisture', 2, true);
    await f.flush();
    assert.equal(sent[0].length, 4);
  });

  test('ignores a message that was not logged', async () => {
    const { f, sent } = makeOs();
    f.handleMessage(D, T, 1, false);
    await f.flush();
    assert.equal(sent.length, 0);
  });

  test('does nothing before it has started', () => {
    const { f } = makeOs();
    f.initialized = false;
    f.handleMessage(D, T, 1, true);
    assert.equal(f.buffer.length, 0);
  });

  test('a failed send is reported and dropped, and the next one still goes', async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
    let calls = 0;
    const { f } = makeOs({}, async () => { if (calls++ === 0) throw new Error('down'); return { body: {} }; });
    f.handleMessage(D, T, 1, true);
    await f.flush();
    assert.match(errors[0], /could not send 1 readings: down/);
    assert.equal(f.sending, false);
    f.handleMessage(D, T, 2, true);
    await f.flush();
    assert.equal(calls, 2);
  });

  test('says how many readings the server rejected', async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
    const { f } = makeOs({}, async () => ({ body: { errors: true, items: [{ index: { error: { type: 'mapper_parsing_exception' } } }] } }));
    f.handleMessage(D, T, 1, true);
    await f.flush();
    assert.match(errors[0], /1 of 1 readings rejected/);
  });

  test('installs an index template that makes value a double, before the first write', async () => {
    const calls = [];
    const f = new OpenSearch({}, makeOrg());
    f.initialized = true;
    f.client = {
      indices: { putIndexTemplate: async (req) => { calls.push('template'); f.templateReq = req; } },
      bulk: async () => { calls.push('bulk'); return { body: {} }; },
    };
    f.ready = f.ensureTemplate();
    f.handleMessage(D, T, 0, true);
    await f.flush();
    assert.deepEqual(calls, ['template', 'bulk']);
    assert.equal(f.templateReq.body.template.mappings.properties.value.type, 'double');
    assert.deepEqual(f.templateReq.body.index_patterns, ['frugaliot-*']);
    assert.equal(f.templateReq.body.template.settings.number_of_replicas, 0);
  });

  test('says what OpenSearch answered, not just "Response Error"', async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
    const { f } = makeOs({}, async () => {
      const err = new Error('Response Error');
      err.meta = { statusCode: 401, body: { error: { type: 'security_exception', reason: 'no permissions for [indices:data/write/bulk]' } } };
      throw err;
    });
    f.handleMessage(D, T, 1, true);
    await f.flush();
    assert.match(errors[0], /could not send 1 readings: HTTP 401: no permissions for \[indices:data\/write\/bulk\]/);
  });

  test('carries on, with a message, if the template cannot be installed', async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
    const f = new OpenSearch({}, makeOrg());
    f.client = { indices: { putIndexTemplate: async () => { throw new Error('no'); } } };
    await f.ensureTemplate();
    assert.match(errors[0], /could not install the index template/);
  });

  test('an apiKey is sent as an Authorization header (the client ignores an apiKey option)', () => {
    const f = new OpenSearch({ node: 'https://es.example:9200', apiKey: 'abc123' }, makeOrg());
    f.start();
    f.stop();
    const sent = f.client.transport.headers;
    assert.equal(sent.authorization, 'ApiKey abc123');
    f.client.close();
  });

  test('flushSeconds sets the timer', () => {
    const f = new OpenSearch({ flushSeconds: 3 }, makeOrg());
    assert.equal(f.config.intervalSeconds, 3);
    assert.equal(new OpenSearch({}, makeOrg()).config.intervalSeconds, 10);
  });

  test('is a known forwarder type', () => {
    assert.equal(_test.FORWARDER_TYPES.opensearch, OpenSearch);
  });
});

describe('backfillOpenSearch', () => {
  let dir, cleanup, sent;
  const client = { bulk: async (req) => { sent.push(req.body); return { body: { errors: false } }; } };
  const put = (topic, file, text, gz = false) => {
    const d = nodepath.join(dir, ...topic.split('/'));
    mkdirSync(d, { recursive: true });
    writeFileSync(nodepath.join(d, file), gz ? gzipSync(text) : text);
  };
  const T = 'dev/lotus/n1/sht/temperature';
  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    sent = [];
    put(T, '2026-09-23.csv.gz', '1790000000000,"20.5"\n', true);
    put(T, '2026-09-24.csv', '1790100000000,"21"\n1790100001000,"hello"\n1790100002000,""\nnot a line\n');
    put('dev/lotus/n1/soil/moisture', '2026-09-24.csv', '1790100000000,"0"\n');
    put('winam/p/n/m/l', '2026-09-24.csv', '1790100000000,"9"\n'); // another organization
  });
  afterEach(() => cleanup());
  const docs = () => sent.flat().filter((x) => x.topic);

  test('sends every reading of the organization, plain and compressed, numbers as numbers', async () => {
    const r = await backfillOpenSearch({ config: {}, org: 'dev', dataDir: dir, client });
    assert.equal(r.sent, 4); // 20.5, 21, "hello", 0 - the blank and the garbage line are skipped
    const byTopic = docs();
    assert.deepEqual(byTopic.filter((d) => d.leaf === 'temperature').map((d) => d.value ?? d.value_text), [20.5, 21, 'hello'].sort(() => 0));
    assert.equal(docs().find((d) => d.leaf === 'moisture').value, 0);
    assert.ok(!docs().some((d) => d.org === 'winam'));
  });

  test('honours the forwarder topics list and says how many files that skipped', async () => {
    const r = await backfillOpenSearch({ config: { topics: ['dev/lotus/+/sht/#'] }, org: 'dev', dataDir: dir, client });
    assert.equal(r.skippedFiles, 1);
    assert.ok(docs().every((d) => d.module === 'sht'));
  });

  test('skips files older than since', async () => {
    const r = await backfillOpenSearch({ config: {}, org: 'dev', dataDir: dir, client, since: '2026-09-24' });
    assert.ok(!docs().some((d) => d.value === 20.5));
    assert.equal(r.sent, 3);
  });

  test('a dry run counts and sends nothing', async () => {
    const r = await backfillOpenSearch({ config: {}, org: 'dev', dataDir: dir, dryRun: true });
    assert.equal(r.sent, 4);
    assert.equal(sent.length, 0);
  });

  test('says so when the organization has no data', async () => {
    await assert.rejects(backfillOpenSearch({ config: {}, org: 'ghost', dataDir: dir, client }), /No .*ghost/);
  });

  test('sending twice gives every reading the same id both times', async () => {
    await backfillOpenSearch({ config: {}, org: 'dev', dataDir: dir, client });
    const first = sent.flat().filter((x) => x.index).map((x) => x.index._id);
    sent = [];
    await backfillOpenSearch({ config: {}, org: 'dev', dataDir: dir, client });
    assert.deepEqual(sent.flat().filter((x) => x.index).map((x) => x.index._id), first);
  });
});
