// MqttLogger: reading the configuration, answering the platform API's schema and value questions,
// and sending an action to a device.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import nodepath from 'node:path';
import { fileURLToPath } from 'node:url';
import { MqttLogger, _test } from '../index.js';
import { makeOrg, makeTempDir, resetModuleState, captureConsole } from './support.js';

const here = nodepath.dirname(fileURLToPath(import.meta.url));
const fixtureConfig = nodepath.join(here, 'fixtures/config');

const readConfig = (path) => new Promise((resolve, reject) => {
  new MqttLogger().readYamlConfig(path, (err, config) => (err ? reject(err) : resolve(config)));
});

describe('readYamlConfig', () => {
  test('reads config.yaml', async () => {
    const config = await captureConsoleAsync(() => readConfig(fixtureConfig));
    assert.equal(config.server.port, 8080);
    assert.equal(config.server.datadir, 'test-data');
    assert.equal(config.logger.verbose, false);
  });

  test('merges each file in config.d under its own name', async () => {
    const config = await captureConsoleAsync(() => readConfig(fixtureConfig));
    assert.equal(config.mqtt.broker, 'wss://broker.example.org/mqtt');
  });

  test('reads config.d subdirectories recursively', async () => {
    const config = await captureConsoleAsync(() => readConfig(fixtureConfig));
    assert.equal(config.organizations.dev.name, 'Developers');
    assert.equal(config.organizations.dev.projects.lotus.name, 'Lotus');
    assert.equal(config.schema.topics.temperature.type, 'float');
    assert.deepEqual(config.schema.modules.sht.topics.map((t) => t.leaf),
      ['temperature', 'humidity']);
  });

  test('keeps the config on the logger for later', async () => {
    const logger = new MqttLogger();
    const config = await captureConsoleAsync(() => new Promise((resolve, reject) => {
      logger.readYamlConfig(fixtureConfig, (err, c) => (err ? reject(err) : resolve(c)));
    }));
    assert.equal(logger.config, config);
  });

  test('a missing config.d is not an error', async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(nodepath.join(dir, 'config.yaml'), 'server:\n  port: 9090\n');
      const config = await captureConsoleAsync(() => readConfig(dir));
      assert.equal(config.server.port, 9090);
    } finally {
      cleanup();
    }
  });

  test('an empty config.yaml still gets the config.d contents', async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      writeFileSync(nodepath.join(dir, 'config.yaml'), '');
      mkdirSync(nodepath.join(dir, 'config.d'));
      writeFileSync(nodepath.join(dir, 'config.d/mqtt.yaml'), 'broker: wss://x.example.org\n');
      const config = await captureConsoleAsync(() => readConfig(dir));
      assert.equal(config.mqtt.broker, 'wss://x.example.org');
    } finally {
      cleanup();
    }
  });

  test('a missing config.yaml is an error', async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      await assert.rejects(() => captureConsoleAsync(() => readConfig(dir)), /ENOENT/);
    } finally {
      cleanup();
    }
  });

  // NOT covered: malformed yaml. js-yaml throws from inside the readFile callback rather than
  // handing the error to the waterfall, so it escapes readYamlConfig as an uncaught exception
  // instead of reaching the caller's cb(err). Worth a look, but it is existing behaviour, so
  // there is no test here asserting either the crash or the error it does not produce.
});

describe('mapTypeToWoT', () => {
  const logger = new MqttLogger();

  test('maps the frugal-iot types', () => {
    assert.equal(logger.mapTypeToWoT('bool'), 'boolean');
    assert.equal(logger.mapTypeToWoT('int'), 'integer');
    assert.equal(logger.mapTypeToWoT('float'), 'number');
    assert.equal(logger.mapTypeToWoT('text'), 'string');
    assert.equal(logger.mapTypeToWoT('topic'), 'string');
    assert.equal(logger.mapTypeToWoT('color'), 'string');
    assert.equal(logger.mapTypeToWoT('yaml'), 'object');
  });

  test('falls back to string for anything else', () => {
    assert.equal(logger.mapTypeToWoT('nosuchtype'), 'string');
    assert.equal(logger.mapTypeToWoT(undefined), 'string');
  });
});

describe('buildWoTSchemaObject', () => {
  const logger = new MqttLogger();

  test('carries the standard WoT fields', () => {
    const obj = logger.buildWoTSchemaObject(
      { field: 'temperature', name: 'Temperature', type: 'float', units: 'Cel', min: -40, max: 125, rw: 'r' },
      'SHT', false);
    assert.equal(obj.type, 'number');
    assert.equal(obj.title, 'Temperature');
    assert.equal(obj.description, 'SHT: Temperature');
    assert.equal(obj.unit, 'Cel');
    assert.equal(obj.minimum, -40);
    assert.equal(obj.maximum, 125);
    assert.equal(obj.readOnly, true);
    assert.equal(obj.writeOnly, undefined);
  });

  test('marks a writable field write-only', () => {
    const obj = logger.buildWoTSchemaObject({ field: 'on', name: 'On', type: 'bool', rw: 'w' }, 'Relay', true);
    assert.equal(obj.writeOnly, true);
    assert.equal(obj.readOnly, undefined);
  });

  test('a read-write field gets neither flag', () => {
    const obj = logger.buildWoTSchemaObject({ field: 'level', name: 'Level', type: 'float', rw: 'rw' }, 'Dimmer', false);
    assert.equal(obj.readOnly, undefined);
    assert.equal(obj.writeOnly, undefined);
  });

  test('frugal-iot extras are kept in their own namespace', () => {
    const obj = logger.buildWoTSchemaObject(
      { field: 'moisture', name: 'Moisture', type: 'float', rw: 'r', color: '#00FF00', slot: 2 },
      'Soil', false);
    assert.deepEqual(obj['frugal-iot:metadata'], { color: '#00FF00', slot: 2 });
  });

  test('no extras means no namespace key at all', () => {
    const obj = logger.buildWoTSchemaObject({ field: 'temperature', name: 'Temperature', type: 'float', rw: 'r' }, 'SHT', false);
    assert.ok(!('frugal-iot:metadata' in obj));
  });
});

describe('getDeviceSchema', () => {
  let logger, org;

  beforeEach(() => {
    logger = new MqttLogger();
    org = makeOrg();
    // The node's modules are discovered from what has been heard on the broker
    org.currentValue = {
      'dev/lotus/n1/sht/temperature': 25.3,
      'dev/lotus/n1/sht/humidity': 65,
      'dev/lotus/n1/relay/on': 1,
      'dev/lotus/n1/dimmer/level': 0.5,
    };
    logger.clients.dev = org;
  });

  test('is a Thing Descriptor identifying the device', () => {
    const td = logger.getDeviceSchema('dev', 'lotus', 'n1', 'https://example.org');
    assert.equal(td.id, 'dev/lotus/n1');
    assert.equal(td.base, 'https://example.org');
    assert.ok(td['@context'][0].startsWith('https://www.w3.org/2022/wot/td/'));
    assert.deepEqual(td.security, ['basic_sc']);
    assert.equal(td.securityDefinitions.basic_sc.scheme, 'basic');
  });

  test('a readable field is a property with an HTTP form', () => {
    const td = logger.getDeviceSchema('dev', 'lotus', 'n1');
    const prop = td.properties['sht/temperature'];
    assert.equal(prop.type, 'number');
    assert.equal(prop.unit, 'Cel');
    assert.equal(prop.readOnly, true);

    const http = prop.forms.find((f) => !f.subprotocol);
    assert.deepEqual(http.op, ['readproperty']);
    assert.equal(http.contentType, 'application/json');
    assert.equal(http.href,
      `/api/devices/property?deviceId=${encodeURIComponent('dev/lotus/n1')}&property=${encodeURIComponent('sht/temperature')}`);
  });

  test('the broker from the config becomes an MQTT form', () => {
    const td = logger.getDeviceSchema('dev', 'lotus', 'n1');
    const mqttForm = td.properties['sht/temperature'].forms.find((f) => f.subprotocol === 'mqtt');
    assert.equal(mqttForm.href, 'wss://broker.example.org/mqtt/dev/lotus/n1/sht/temperature');
    assert.equal(td['mqtt:broker'], 'wss://broker.example.org/mqtt');
    assert.equal(td['mqtt:clientId'], 'frugal-iot-dev');
  });

  test('a write-only field is an action, not a property', () => {
    const td = logger.getDeviceSchema('dev', 'lotus', 'n1');
    assert.ok(!('relay/on' in td.properties));
    const action = td.actions['relay/on'];
    assert.equal(action.title, 'On');
    assert.equal(action.input.type, 'boolean');
    const http = action.forms.find((f) => !f.subprotocol);
    assert.deepEqual(http.op, ['invokeaction']);
    assert.equal(http.href,
      `/api/devices/action?deviceId=${encodeURIComponent('dev/lotus/n1')}&action=${encodeURIComponent('relay/on')}`);
    // The MQTT form publishes under "set/", which is how a device is told anything
    const mqttForm = action.forms.find((f) => f.subprotocol === 'mqtt');
    assert.equal(mqttForm.href, 'wss://broker.example.org/mqtt/dev/lotus/n1/set/relay/on');
  });

  test('a read-write field is one property covering both, not a property and an action', () => {
    const td = logger.getDeviceSchema('dev', 'lotus', 'n1');
    assert.ok(!('dimmer/level' in td.actions));
    const prop = td.properties['dimmer/level'];
    assert.deepEqual(prop.forms.find((f) => !f.subprotocol).op, ['readproperty', 'writeproperty']);
    // A read form and a write form, the write one under "set/"
    const mqttForms = prop.forms.filter((f) => f.subprotocol === 'mqtt');
    assert.equal(mqttForms.length, 2);
    assert.ok(mqttForms.some((f) => f.href.endsWith('/dev/lotus/n1/dimmer/level')));
    assert.ok(mqttForms.some((f) => f.href.endsWith('/dev/lotus/n1/set/dimmer/level')));
  });

  test('the top level offers read-all and observe-all', () => {
    const td = logger.getDeviceSchema('dev', 'lotus', 'n1');
    assert.equal(td.forms.find((f) => f.op === 'readallproperties').href,
      `/api/devices/property?deviceId=${encodeURIComponent('dev/lotus/n1')}`);
    const observe = td.forms.find((f) => Array.isArray(f.op) && f.op.includes('observeallproperties'));
    assert.equal(observe['mqv:filter'], 'dev/lotus/n1/#');
  });

  test('an unknown organization is null', () => {
    let td;
    captureConsole(() => { td = logger.getDeviceSchema('nosuchorg', 'lotus', 'n1'); });
    assert.equal(td, null);
  });

  test('a device nothing has been heard from is null', () => {
    let td;
    captureConsole(() => { td = logger.getDeviceSchema('dev', 'lotus', 'n99'); });
    assert.equal(td, null);
  });

  test('an organization with no broker configured gets no MQTT forms', () => {
    logger.clients.dev = makeOrg('dev', undefined, {});
    logger.clients.dev.currentValue = { 'dev/lotus/n1/sht/temperature': 25.3 };
    const td = logger.getDeviceSchema('dev', 'lotus', 'n1');
    assert.ok(!('mqtt:broker' in td));
    assert.equal(td.properties['sht/temperature'].forms.length, 1);
  });
});

describe('getPropertyValue and getDeviceCurrentValues', () => {
  let logger;

  beforeEach(() => {
    logger = new MqttLogger();
    const org = makeOrg();
    org.currentValue = {
      'dev/lotus/n1/sht/temperature': 25.3,
      'dev/lotus/n1/sht/humidity': 65,
    };
    logger.clients.dev = org;
  });

  test('returns the last value seen', () => {
    assert.equal(logger.getPropertyValue('dev', 'lotus', 'n1', 'sht/temperature'), 25.3);
  });

  test('an unseen field or unknown organization is undefined', () => {
    assert.equal(logger.getPropertyValue('dev', 'lotus', 'n1', 'sht/nosuchleaf'), undefined);
    assert.equal(logger.getPropertyValue('nosuchorg', 'lotus', 'n1', 'sht/temperature'), undefined);
  });

  test('the whole device gives every field seen at least once', () => {
    assert.deepEqual(logger.getDeviceCurrentValues('dev', 'lotus', 'n1'), {
      'sht/temperature': 25.3,
      'sht/humidity': 65,
    });
  });

  test('an unknown organization or device is empty', () => {
    assert.deepEqual(logger.getDeviceCurrentValues('nosuchorg', 'lotus', 'n1'), {});
    assert.deepEqual(logger.getDeviceCurrentValues('dev', 'lotus', 'n99'), {});
  });
});

describe('sendAction', () => {
  let logger, published;

  beforeEach(() => {
    logger = new MqttLogger();
    published = [];
    const org = makeOrg();
    org.mqtt_client = {
      connected: true,
      publish: (topic, message, opts, cb) => { published.push({ topic, message, opts }); cb(null); },
    };
    logger.clients.dev = org;
  });

  test('publishes under "set/", which is how a device is told anything', async () => {
    const result = await logger.sendAction('dev', 'lotus', 'n1', 'relay/on', 1);
    assert.equal(result.status, 'sent');
    assert.equal(published[0].topic, 'dev/lotus/n1/set/relay/on');
    assert.equal(published[0].message, '1');
    assert.equal(published[0].opts.retain, false);
  });

  test('a boolean is sent as the 1/0 devices expect, not "true"/"false"', async () => {
    await logger.sendAction('dev', 'lotus', 'n1', 'relay/on', true);
    await logger.sendAction('dev', 'lotus', 'n1', 'relay/on', false);
    assert.deepEqual(published.map((p) => p.message), ['1', '0']);
  });

  test('other values are stringified', async () => {
    await logger.sendAction('dev', 'lotus', 'n1', 'dimmer/level', 0.5);
    await logger.sendAction('dev', 'lotus', 'n1', 'frugal_iot/name', 'Node One');
    assert.deepEqual(published.map((p) => p.message), ['0.5', 'Node One']);
  });

  test('an action not in module/field form is refused', async () => {
    const result = await logger.sendAction('dev', 'lotus', 'n1', 'on', 1);
    assert.equal(result.status, 'error');
    assert.match(result.message, /module\/field/);
    assert.equal(published.length, 0);
  });

  test('an unknown organization is an error', async () => {
    const result = await logger.sendAction('nosuchorg', 'lotus', 'n1', 'relay/on', 1);
    assert.equal(result.status, 'error');
    assert.match(result.message, /not connected/);
  });

  test('a disconnected broker is an error rather than a silent drop', async () => {
    logger.clients.dev.mqtt_client.connected = false;
    const result = await logger.sendAction('dev', 'lotus', 'n1', 'relay/on', 1);
    assert.equal(result.status, 'error');
    assert.match(result.message, /not connected/);
    assert.equal(published.length, 0);
  });

  test('a publish failure is reported', async () => {
    logger.clients.dev.mqtt_client.publish = (topic, message, opts, cb) => cb(new Error('broker said no'));
    const result = await logger.sendAction('dev', 'lotus', 'n1', 'relay/on', 1);
    assert.equal(result.status, 'error');
    assert.match(result.message, /broker said no/);
  });
});

describe('reportNodes across organizations', () => {
  test('keys the result by organization', () => {
    const logger = new MqttLogger();
    const dev = makeOrg('dev');
    dev.quickdiscover(new Date(1000), 'dev/lotus', 'n1');
    const varta = makeOrg('varta');
    varta.quickdiscover(new Date(2000), 'varta/field', 'n9');
    logger.clients = { dev, varta };

    assert.deepEqual(logger.reportNodes(), {
      dev: { lotus: { n1: { lastseen: new Date(1000) } } },
      varta: { field: { n9: { lastseen: new Date(2000) } } },
    });
  });
});

describe('flush', () => {
  let dir, cleanup;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    resetModuleState(dir);
    _test.startFlushing(3600);
  });

  afterEach(() => { resetModuleState(); cleanup(); });

  test('writes out what is held in memory, so a graph is never missing readings', async () => {
    const logger = new MqttLogger();
    const org = makeOrg();
    org.log(new Date('2026-09-24T10:20:30.000Z'), 'dev/lotus/n1/sht/temperature', '25.3');
    assert.equal(_test.pendingRows(), 1);

    await new Promise((resolve) => logger.flush(resolve));
    assert.equal(_test.pendingRows(), 0);
  });
});

// The config reader reports what it is doing on the console, which is useful running the logger and
// noise running the tests
async function captureConsoleAsync(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}
