// The forwarders. Neither the Firebase SDK nor Google's endpoint is reachable from a test, so the
// database handle and fetch are stood in for - what is being tested is the logger's own decisions:
// which nodes are forwarded, which values are fit to send, and how a topic is flattened.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../index.js';
import { makeOrg } from './support.js';

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
});
