// Collecting readings in memory and writing them out a batch at a time. The point of the batching
// is that an SD card gets one write per file per flush rather than one per reading, so the tests
// check what ends up on disk and when, not just that nothing threw.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import nodepath from 'node:path';
import { _test } from '../index.js';
import { makeTempDir, resetModuleState } from './support.js';

const { appendPending, flushPending, flushPendingSync, startFlushing, pendingRows } = _test;

const flush = () => new Promise((resolve) => flushPending(resolve));

let dir, cleanup;

beforeEach(() => {
  ({ dir, cleanup } = makeTempDir());
  resetModuleState(dir);
});

afterEach(async () => {
  await flush(); // Leave nothing queued for the next test
  resetModuleState();
  cleanup();
});

describe('writing each reading as it arrives (flushseconds absent)', () => {
  test('the reading reaches its file', async () => {
    const path = nodepath.join(dir, 'dev/lotus/n1/sht');
    appendPending(path, '2026-09-24.csv', '1000,"25.3"\n');
    await flush();
    assert.equal(readFileSync(nodepath.join(path, '2026-09-24.csv'), 'utf8'), '1000,"25.3"\n');
  });

  test('the directory is created as needed', async () => {
    const path = nodepath.join(dir, 'a/deep/tree/that/does/not/exist');
    appendPending(path, '2026-09-24.csv', '1000,"1"\n');
    await flush();
    assert.ok(existsSync(nodepath.join(path, '2026-09-24.csv')));
  });

  test('successive readings append rather than overwrite', async () => {
    const path = nodepath.join(dir, 'dev/lotus/n1/sht');
    appendPending(path, '2026-09-24.csv', '1000,"25.3"\n');
    await flush();
    appendPending(path, '2026-09-24.csv', '2000,"25.4"\n');
    await flush();
    assert.equal(readFileSync(nodepath.join(path, '2026-09-24.csv'), 'utf8'),
      '1000,"25.3"\n2000,"25.4"\n');
  });
});

describe('collecting in memory (flushseconds set)', () => {
  beforeEach(() => startFlushing(3600)); // Long enough that only an explicit flush writes anything

  test('nothing is written until the flush', async () => {
    const path = nodepath.join(dir, 'dev/lotus/n1/sht');
    appendPending(path, '2026-09-24.csv', '1000,"25.3"\n');
    appendPending(path, '2026-09-24.csv', '2000,"25.4"\n');
    appendPending(path, '2026-09-24.csv', '3000,"25.5"\n');
    assert.equal(pendingRows(), 3);
    assert.ok(!existsSync(nodepath.join(path, '2026-09-24.csv')));

    await flush();
    assert.equal(pendingRows(), 0);
    assert.equal(readFileSync(nodepath.join(path, '2026-09-24.csv'), 'utf8'),
      '1000,"25.3"\n2000,"25.4"\n3000,"25.5"\n');
  });

  test('readings for different files are kept apart', async () => {
    const sht = nodepath.join(dir, 'dev/lotus/n1/sht');
    const soil = nodepath.join(dir, 'dev/lotus/n1/soil');
    appendPending(sht, '2026-09-24.csv', '1000,"25.3"\n');
    appendPending(soil, '2026-09-24.csv', '1000,"42"\n');
    appendPending(sht, '2026-09-25.csv', '90000,"25.9"\n'); // Same topic, next day
    await flush();

    assert.equal(readFileSync(nodepath.join(sht, '2026-09-24.csv'), 'utf8'), '1000,"25.3"\n');
    assert.equal(readFileSync(nodepath.join(soil, '2026-09-24.csv'), 'utf8'), '1000,"42"\n');
    assert.equal(readFileSync(nodepath.join(sht, '2026-09-25.csv'), 'utf8'), '90000,"25.9"\n');
  });

  test('a big enough backlog is written out without waiting for the interval', () => {
    // FLUSH_MAX_ROWS is 2000 - the limit exists so a server with many nodes never sits on an
    // unbounded amount of unwritten data
    const path = nodepath.join(dir, 'dev/lotus/n1/sht');
    for (let i = 0; i < 1999; i++) appendPending(path, '2026-09-24.csv', `${i},"1"\n`);
    assert.equal(pendingRows(), 1999);
    appendPending(path, '2026-09-24.csv', '1999,"1"\n');
    assert.equal(pendingRows(), 0, 'the batch should have been taken at 2000 rows');
  });

  test('flushing with nothing waiting still calls back', async () => {
    assert.equal(pendingRows(), 0);
    await flush(); // Would hang if it did not - the server calls this before serving any request
  });

  test('a flush requested during a flush gets one of its own', async () => {
    const path = nodepath.join(dir, 'dev/lotus/n1/sht');
    appendPending(path, '2026-09-24.csv', '1000,"25.3"\n');

    const first = flush();
    // This arrives while the first batch is being written, so it must not be lost
    appendPending(path, '2026-09-24.csv', '2000,"25.4"\n');
    const second = flush();
    await Promise.all([first, second]);

    assert.equal(pendingRows(), 0);
    assert.equal(readFileSync(nodepath.join(path, '2026-09-24.csv'), 'utf8'),
      '1000,"25.3"\n2000,"25.4"\n');
  });

  test('an unwritable file loses its readings noisily rather than growing memory', async () => {
    // The directory cannot be created because a file of that name is in the way
    const blocker = nodepath.join(dir, 'blocked');
    appendPending(dir, 'blocked', 'not a directory\n');
    await flush();

    appendPending(nodepath.join(blocker, 'sub'), '2026-09-24.csv', '1000,"1"\n');
    // The report comes from the write's callback, so the capture has to span the await
    const lines = [];
    const realError = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await flush();
    } finally {
      console.error = realError;
    }
    assert.match(lines.join('\n'), /readings lost/);
    assert.equal(pendingRows(), 0, 'rows must not be put back');
  });
});

describe('flushPendingSync', () => {
  beforeEach(() => startFlushing(3600));

  test('writes everything waiting, with no event loop left to run', () => {
    // This is the "exit" handler's path - Node allows no asynchronous work by then
    const path = nodepath.join(dir, 'dev/lotus/n1/sht');
    appendPending(path, '2026-09-24.csv', '1000,"25.3"\n');
    appendPending(path, '2026-09-24.csv', '2000,"25.4"\n');

    flushPendingSync();

    assert.equal(pendingRows(), 0);
    assert.equal(readFileSync(nodepath.join(path, '2026-09-24.csv'), 'utf8'),
      '1000,"25.3"\n2000,"25.4"\n');
  });

  test('is a no-op with nothing waiting', () => {
    assert.doesNotThrow(() => flushPendingSync());
  });
});
