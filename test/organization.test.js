// MqttOrganization: resolving a topic against the schema, deciding whether a message is worth
// recording, and what ends up in the CSV. This is the part of the logger that decides what gets
// kept, so it is where most of the tests are.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import nodepath from 'node:path';
import { _test } from '../index.js';
import { makeOrg, makeTempDir, resetModuleState, captureConsole } from './support.js';

const flush = () => new Promise((resolve) => _test.flushPending(resolve));

let org, dir, cleanup;

beforeEach(() => {
  ({ dir, cleanup } = makeTempDir());
  resetModuleState(dir);
  org = makeOrg();
});

afterEach(async () => {
  await flush();
  resetModuleState();
  cleanup();
});

describe('moduleBaseId', () => {
  test('an exact match is itself', () => {
    assert.equal(org.moduleBaseId('sht'), 'sht');
    assert.equal(org.moduleBaseId('soil'), 'soil');
  });

  test('a numbered instance falls back to its base module', () => {
    // A node with several probes publishes soil1, soil2... and modules.yaml carries only "soil"
    assert.equal(org.moduleBaseId('soil1'), 'soil');
    assert.equal(org.moduleBaseId('soil12'), 'soil');
  });

  test('a separator-prefixed suffix falls back too', () => {
    assert.equal(org.moduleBaseId('soil_north'), 'soil');
    assert.equal(org.moduleBaseId('soil-2'), 'soil');
  });

  test('the longest matching prefix wins', () => {
    assert.equal(org.moduleBaseId('soilmodbus1'), 'soilmodbus');
  });

  test('a bare-word suffix does not match', () => {
    // Otherwise a module genuinely called "door" would silently resolve to "do"
    assert.equal(org.moduleBaseId('door'), null);
    assert.equal(org.moduleBaseId('shtx'), null);
  });

  test('an unknown module is null', () => {
    assert.equal(org.moduleBaseId('nosuchmodule'), null);
  });

  test('the instance suffix strips the separator', () => {
    assert.equal(org.moduleInstanceSuffix('soil1'), '1');
    assert.equal(org.moduleInstanceSuffix('soil_north'), 'north');
    assert.equal(org.moduleInstanceSuffix('soil-2'), '2');
    assert.equal(org.moduleInstanceSuffix('soil'), '');
    assert.equal(org.moduleInstanceSuffix('nosuchmodule'), '');
  });
});

describe('schemaField', () => {
  test('takes the value from the topic when the module says nothing', () => {
    assert.equal(org.schemaField('sht', 'temperature', 'type'), 'float');
    assert.equal(org.schemaField('sht', 'temperature', 'units'), 'Cel');
    assert.equal(org.schemaField('sht', 'temperature', 'min'), -40);
  });

  test('a module-level setting overrides the topic', () => {
    assert.equal(org.schemaField('nolog', 'temperature', 'log'), false);
    assert.equal(org.schemaField('sht', 'temperature', 'log'), true);
  });

  test('a false or zero override is honoured, not stepped over', () => {
    // "log: false" and "min: 0" are settings somebody wrote deliberately
    assert.equal(org.schemaField('nolog', 'temperature', 'log'), false);
    assert.equal(org.schemaField('soil', 'moisture', 'min'), 0);
  });

  test('leaf_from redirects to a differently named topic', () => {
    assert.equal(org.schemaField('soil', 'moisture', 'type'), 'float');
    assert.equal(org.schemaField('soil', 'moisture', 'units'), '%');
  });

  test('an unknown field is undefined', () => {
    assert.equal(org.schemaField('sht', 'temperature', 'nosuchfield'), undefined);
  });

  test('an unknown module falls straight through to the topic', () => {
    assert.equal(org.schemaField('nosuchmodule', 'temperature', 'type'), 'float');
  });

  test('an unknown module and topic is undefined', () => {
    assert.equal(org.schemaField('nosuchmodule', 'nosuchleaf', 'type'), undefined);
  });

  test('findMostGranular uses the default only when the schema is silent', () => {
    assert.equal(org.findMostGranular(['lotus', 'n1', 'nolog', 'temperature'], 'log', true), false);
    assert.equal(org.findMostGranular(['lotus', 'n1', 'sht', 'nosuchleaf'], 'log', 'fallback'), 'fallback');
  });
});

describe('schemaModule', () => {
  test('expands each topic into a field', () => {
    const s = org.schemaModule('sht');
    assert.equal(s.name, 'SHT');
    assert.deepEqual(s.fields.map((f) => f.field), ['temperature', 'humidity']);
    const temp = s.fields[0];
    assert.equal(temp.name, 'Temperature');
    assert.equal(temp.type, 'float');
    assert.equal(temp.rw, 'r');
    assert.equal(temp.units, 'Cel');
    assert.equal(temp.min, -40);
    assert.equal(temp.max, 125);
  });

  test('an instance is named after its base plus the suffix', () => {
    assert.equal(org.schemaModule('soil1').name, 'Soil 1');
    assert.equal(org.schemaModule('soil_north').name, 'Soil north');
    assert.equal(org.schemaModule('soil').name, 'Soil');
  });

  test('an instance carries the base module fields', () => {
    assert.deepEqual(org.schemaModule('soil1').fields.map((f) => f.field), ['moisture']);
  });

  test('leaf_from supplies the type while the module supplies the name', () => {
    const moisture = org.schemaModule('soil').fields[0];
    assert.equal(moisture.field, 'moisture');
    assert.equal(moisture.name, 'Moisture');
    assert.equal(moisture.type, 'float');
    assert.equal(moisture.units, '%');
  });

  test('custom module properties are preserved', () => {
    assert.equal(org.schemaModule('soil').fields[0].color, '#00FF00');
  });

  test('a module that says only "- leaf: x" takes the topic name', () => {
    assert.equal(org.schemaModule('soilmodbus').fields[0].name, 'Percent');
  });

  test('an unknown module is an empty one rather than an error', () => {
    const s = org.schemaModule('nosuchmodule');
    assert.equal(s.name, 'nosuchmodule');
    assert.deepEqual(s.fields, []);
  });
});

describe('modulesNode', () => {
  beforeEach(() => {
    org.currentValue = {
      'dev/lotus/n1/sht/temperature': 25.3,
      'dev/lotus/n1/sht/humidity': 65,
      'dev/lotus/n1/soil1/moisture': 42,
      'dev/lotus/n2/sht/temperature': 19.0,
    };
  });

  test('lists the modules seen for that node, sorted', () => {
    assert.deepEqual(org.modulesNode('n1'), ['sht', 'soil1']);
  });

  test('does not leak modules from another node', () => {
    assert.deepEqual(org.modulesNode('n2'), ['sht']);
  });

  test('an unseen node has no modules', () => {
    assert.deepEqual(org.modulesNode('n99'), []);
  });

  test('schemaNode expands every module it found', () => {
    const s = org.schemaNode('n1');
    assert.deepEqual(Object.keys(s.modules).sort(), ['sht', 'soil1']);
    assert.equal(s.modules.soil1.name, 'Soil 1');
    assert.deepEqual(s.modules.sht.fields.map((f) => f.field), ['temperature', 'humidity']);
  });
});

describe('shouldLog', () => {
  const at = (ms) => new Date(ms);

  test('an ordinary sensor reading is logged', () => {
    assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/sht/temperature', '25.3', false), true);
  });

  test('the converted value is remembered whether logged or not', () => {
    org.shouldLog(at(1000), 'dev/lotus/n1/sht/temperature', '25.3', false);
    assert.equal(org.currentValue['dev/lotus/n1/sht/temperature'], 25.3);
    assert.equal(org.findLastValue('dev/lotus/n1/sht/temperature'), 25.3);
  });

  test('a module instance is logged', () => {
    assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/soil1/moisture', '42', false), true);
  });

  describe('topics that are not readings', () => {
    test('too few levels', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/sht', '25.3', false), false);
      assert.equal(org.shouldLog(at(1000), 'dev/lotus', 'n1', false), false);
    });

    test('a parameter below the leaf', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/sht/temperature/parm', '1', false), false);
    });

    test('a "set" command on its way to the device', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/set/relay/on', '1', false), false);
    });

    test('a legacy module or topic left in the broker', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/messages/x', 'hi', false), false);
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/sht/wifistrength', '-70', false), false);
    });

    test('a topic that is not in the schema', () => {
      let result;
      captureConsole(() => {
        result = org.shouldLog(at(1000), 'dev/lotus/n1/nosuchmod/nosuchleaf', '1', false);
      });
      assert.equal(result, false);
    });
  });

  describe('what the schema says to skip', () => {
    test('"log: false" on the module', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/nolog/temperature', '25.3', false), false);
    });

    test('"log: false" on the topic', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/frugal_iot/wifi', '-70', false), false);
    });

    test('a writable control, which the device is told rather than reports', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/relay/on', '1', false), false);
    });

    test('a text topic, since the default only covers float, int and bool', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/frugal_iot/description', 'A node', false), false);
    });

    test('but the value is still remembered for the dashboard', () => {
      org.shouldLog(at(1000), 'dev/lotus/n1/frugal_iot/description', 'A node', false);
      assert.equal(org.findLastValue('dev/lotus/n1/frugal_iot/description'), 'A node');
    });
  });

  describe('retained messages', () => {
    test('are not logged - they are the broker replaying its store, not a new reading', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/sht/temperature', '25.3', true), false);
    });

    test('still update the current value, so the dashboard shows the node state', () => {
      org.shouldLog(at(1000), 'dev/lotus/n1/sht/temperature', '25.3', true);
      assert.equal(org.findLastValue('dev/lotus/n1/sht/temperature'), 25.3);
    });

    test('do not count as the last logged reading', () => {
      // Otherwise the first real reading afterwards would be compared against a replayed one
      org.shouldLog(at(1000), 'dev/lotus/n1/sht/temperature', '25.3', true);
      assert.equal(org.lastValue['dev/lotus/n1/sht/temperature'], undefined);
      assert.equal(org.shouldLog(at(1100), 'dev/lotus/n1/sht/temperature', '25.3', false), true);
    });
  });

  describe('deduplication', () => {
    const topic = 'dev/lotus/n1/sht/temperature'; // significantdate 60000, significantvalue 0.5

    test('a reading that moved too little, too soon, is dropped', () => {
      assert.equal(org.shouldLog(at(1000), topic, '25.3', false), true);
      assert.equal(org.shouldLog(at(2000), topic, '25.4', false), false);
    });

    test('a big enough change is kept', () => {
      assert.equal(org.shouldLog(at(1000), topic, '25.3', false), true);
      assert.equal(org.shouldLog(at(2000), topic, '26.0', false), true);
    });

    test('a long enough gap is kept', () => {
      assert.equal(org.shouldLog(at(1000), topic, '25.3', false), true);
      assert.equal(org.shouldLog(at(70000), topic, '25.31', false), true);
    });

    test('the comparison is against the last reading kept, not the last one seen', () => {
      assert.equal(org.shouldLog(at(1000), topic, '25.0', false), true);
      assert.equal(org.shouldLog(at(2000), topic, '25.3', false), false); // Dropped
      // 25.4 is 0.1 from the dropped one but 0.4 from the one kept, so still not significant
      assert.equal(org.shouldLog(at(3000), topic, '25.4', false), false);
      assert.equal(org.shouldLog(at(4000), topic, '25.5', false), true); // 0.5 from the one kept
    });

    test('a topic with no duplicates rule keeps every reading', () => {
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n1/sht/humidity', '65', false), true);
      assert.equal(org.shouldLog(at(1001), 'dev/lotus/n1/sht/humidity', '65', false), true);
    });

    test('different topics do not interfere', () => {
      assert.equal(org.shouldLog(at(1000), topic, '25.3', false), true);
      assert.equal(org.shouldLog(at(1000), 'dev/lotus/n2/sht/temperature', '25.3', false), true);
    });
  });

  describe('a sensor with no reading', () => {
    const topic = 'dev/lotus/n1/sht/temperature';

    test('the first "nan" is recorded', () => {
      assert.equal(org.shouldLog(at(1000), topic, 'nan', false), true);
      assert.equal(org.findLastValue(topic), null);
    });

    test('a repeat of it is not', () => {
      org.shouldLog(at(1000), topic, 'nan', false);
      assert.equal(org.shouldLog(at(2000), topic, 'nan', false), false);
    });

    test('going invalid is recorded even if the value rule would not fire', () => {
      org.shouldLog(at(1000), topic, '25.3', false);
      assert.equal(org.shouldLog(at(2000), topic, 'nan', false), true);
    });

    test('coming back is recorded', () => {
      org.shouldLog(at(1000), topic, 'nan', false);
      assert.equal(org.shouldLog(at(2000), topic, '25.3', false), true);
    });
  });
});

describe('log', () => {
  test('writes a timestamp and a quoted value to a file named for the day', async () => {
    const date = new Date('2026-09-24T10:20:30.000Z');
    org.log(date, 'dev/lotus/n1/sht/temperature', '25.3');
    await flush();

    const file = nodepath.join(dir, 'dev/lotus/n1/sht/temperature/2026-09-24.csv');
    assert.equal(readFileSync(file, 'utf8'), `${date.valueOf()},"25.3"\n`);
  });

  test('a reading after midnight UTC goes to the next day file', async () => {
    org.log(new Date('2026-09-24T23:59:59.000Z'), 'dev/lotus/n1/sht/temperature', '25.3');
    org.log(new Date('2026-09-25T00:00:01.000Z'), 'dev/lotus/n1/sht/temperature', '25.4');
    await flush();

    const base = nodepath.join(dir, 'dev/lotus/n1/sht/temperature');
    assert.ok(existsSync(nodepath.join(base, '2026-09-24.csv')));
    assert.ok(existsSync(nodepath.join(base, '2026-09-25.csv')));
  });

  test('a topic resolving outside the data directory is refused, loudly', async () => {
    const lines = captureConsole(() => {
      org.log(new Date('2026-09-24T10:20:30.000Z'), '../../escape', '25.3');
    });
    await flush();
    assert.match(lines.join('\n'), /resolves outside/);
    assert.equal(_test.pendingRows(), 0);
  });
});

describe('messageReceived', () => {
  test('logs a reading it should keep', async () => {
    const date = new Date('2026-09-24T10:20:30.000Z');
    org.messageReceived(date, 'dev/lotus/n1/sht/temperature', '25.3', false);
    await flush();
    assert.ok(existsSync(nodepath.join(dir, 'dev/lotus/n1/sht/temperature/2026-09-24.csv')));
  });

  test('writes nothing for a reading it should not', async () => {
    org.messageReceived(new Date('2026-09-24T10:20:30.000Z'), 'dev/lotus/n1/set/relay/on', '1', false);
    await flush();
    assert.ok(!existsSync(nodepath.join(dir, 'dev/lotus/n1/set')));
  });

  test('hands the converted value to every forwarder, logged or not', () => {
    const seen = [];
    org.firebases = [{ handleMessage: (date, topic, value) => seen.push([topic, value]) }];

    org.messageReceived(new Date(1000), 'dev/lotus/n1/sht/temperature', '25.3', false);
    org.messageReceived(new Date(2000), 'dev/lotus/n1/frugal_iot/description', 'A node', false);

    assert.deepEqual(seen, [
      ['dev/lotus/n1/sht/temperature', 25.3],   // Number, not the raw string
      ['dev/lotus/n1/frugal_iot/description', 'A node'],
    ]);
  });
});

describe('dispatch', () => {
  test('delivers a message to each matching subscription and no others', () => {
    const hits = [];
    org.mqtt_client = { subscribe: () => {} }; // subscribe() tells the broker as well
    org.subscribe('dev/#', 0, (date, topic) => hits.push(['all', topic]));
    org.subscribe('dev/+', 0, (date, topic) => hits.push(['project', topic]));

    org.dispatch('dev/lotus/n1/sht/temperature', '25.3', false);
    org.dispatch('dev/lotus', 'n1', false);

    assert.deepEqual(hits, [
      ['all', 'dev/lotus/n1/sht/temperature'],
      ['all', 'dev/lotus'],
      ['project', 'dev/lotus'],
    ]);
  });
});

describe('quickdiscover and reportNodes', () => {
  test('records when a node was last announced', () => {
    const date = new Date(1000);
    org.quickdiscover(date, 'dev/lotus', 'n1');
    assert.equal(org.projects.lotus.n1, date);
  });

  test('reports the name, description and last seen time per node', () => {
    const date = new Date(1000);
    org.currentValue = {
      'dev/lotus/n1/frugal_iot/description': 'A node',
      'dev/lotus/n1/frugal_iot/name': 'Node One',
      'dev/lotus/n1/sht/temperature': 25.3, // Not a reported leaf
    };
    org.quickdiscover(date, 'dev/lotus', 'n1');

    assert.deepEqual(org.reportNodes(), {
      lotus: {
        n1: {
          'frugal_iot/description': 'A node',
          'frugal_iot/name': 'Node One',
          lastseen: date,
        },
      },
    });
  });

  test('a node announced but never heard from still appears', () => {
    const date = new Date(1000);
    org.quickdiscover(date, 'dev/lotus', 'n1');
    assert.deepEqual(org.reportNodes(), { lotus: { n1: { lastseen: date } } });
  });

  test('nothing seen at all reports nothing', () => {
    assert.deepEqual(org.reportNodes(), {});
  });
});
