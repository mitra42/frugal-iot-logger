// Shared fixtures and helpers for the tests.
//
// The schema below is a cut-down stand-in for config.d/schema/{topics,modules}.yaml. It is small
// enough to read in one go, but carries one example of each thing the resolution code has to get
// right: a plain topic, a leaf_from redirect, a module-level override of a topic-level setting, a
// writable topic, and two module names where one is a prefix of the other.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodepath from 'node:path';
import { MqttOrganization, _test } from '../index.js';

export const topics = {
  temperature: {
    leaf: 'temperature', name: 'Temperature', type: 'float', units: 'Cel',
    min: -40, max: 125, rw: 'r', log: true,
    duplicates: { significantdate: 60000, significantvalue: 0.5 },
  },
  humidity: {
    leaf: 'humidity', name: 'Humidity', type: 'float', units: '%',
    min: 0, max: 100, rw: 'r', log: true,
  },
  percent: { leaf: 'percent', name: 'Percent', type: 'float', units: '%', min: 0, max: 100, rw: 'r' },
  on: { leaf: 'on', name: 'On', type: 'bool', rw: 'w' },
  wifi: { leaf: 'wifi', name: 'WiFi Strength', type: 'int', rw: 'r', log: false },
  description: { leaf: 'description', name: 'Description', type: 'text', rw: 'r' },
  controlfloat: { leaf: 'controlfloat', name: 'Control', type: 'float', rw: 'rw' },
};

export const modules = {
  sht: { name: 'SHT', topics: [{ leaf: 'temperature' }, { leaf: 'humidity' }] },
  // leaf_from: the reading is published as "moisture" but takes its definition from "percent"
  soil: {
    name: 'Soil',
    topics: [{ leaf: 'moisture', leaf_from: 'percent', name: 'Moisture', color: '#00FF00' }],
  },
  // Longer name sharing a prefix with "soil" - moduleBaseId has to prefer this one for "soilmodbus1"
  soilmodbus: { name: 'Soil Modbus', topics: [{ leaf: 'moisture', leaf_from: 'percent' }] },
  // Two letters, so "door" would resolve to it if bare-word suffixes were accepted
  do: { name: 'Dissolved Oxygen', topics: [{ leaf: 'do', leaf_from: 'percent' }] },
  relay: { name: 'Relay', topics: [{ leaf: 'on' }] },
  dimmer: { name: 'Dimmer', topics: [{ leaf: 'level', leaf_from: 'controlfloat', name: 'Level' }] },
  frugal_iot: { name: 'Frugal IoT', topics: [{ leaf: 'description' }, { leaf: 'wifi' }] },
  // Module-level "log: false" over a topic that says "log: true"
  nolog: { name: 'No Log', topics: [{ leaf: 'temperature', log: false }] },
};

export const schema = { topics, modules };

export const mqttConfig = { broker: 'wss://broker.example.org/mqtt' };

export const orgConfig = {
  name: 'Developers',
  userid: 'dev',
  mqtt_password: 'secret',
  projects: { lotus: { name: 'Lotus' } },
};

// An organization with the schema above and no broker connection. Everything the tests below call
// on it - shouldLog, the schema lookups, reportNodes - runs without one; startClient() is the only
// thing that needs a broker, and nothing here calls it.
export function makeOrg(id = 'dev', config_org = orgConfig, config_mqtt = mqttConfig) {
  return new MqttOrganization(id, config_org, config_mqtt, schema);
}

// A directory that goes away again, for the tests that write real files. Returns the path plus the
// cleanup, so a test can hand the cleanup straight to t.after().
export function makeTempDir() {
  const dir = mkdtempSync(nodepath.join(tmpdir(), 'frugal-iot-logger-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Silence the per-message console.log and put the batching state back to "write as it arrives",
// which is what the logger does before start() has read a config.
export function resetModuleState(dataDir) {
  _test.setVerbose(false);
  _test.reset();
  if (dataDir) _test.setDataDir(dataDir);
}

// Collect what a function writes to console.log/console.error, for the paths that report a problem
// rather than throwing. Returns the captured lines.
export function captureConsole(fn) {
  const lines = [];
  const log = console.log, error = console.error, warn = console.warn;
  console.log = console.error = console.warn = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
  }
  return lines;
}
