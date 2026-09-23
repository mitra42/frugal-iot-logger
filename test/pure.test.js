// The module-private helpers: converting a message to a value, deciding whether a reading is worth
// recording, and turning a topic into a directory.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodepath from 'node:path';
import { _test } from '../index.js';
import { captureConsole } from './support.js';

const { valueFromText, significantlyDifferent, isDuplicate, topicToDir } = _test;

describe('valueFromText', () => {
  test('bool accepts the wire forms and the numeric ones', () => {
    assert.equal(valueFromText('true', 'bool'), 1);
    assert.equal(valueFromText('false', 'bool'), 0);
    assert.equal(valueFromText('1', 'bool'), 1);
    assert.equal(valueFromText('0', 'bool'), 0);
  });

  test('numbers', () => {
    assert.equal(valueFromText('25.3', 'float'), 25.3);
    assert.equal(valueFromText('-40', 'float'), -40);
    assert.equal(valueFromText('7', 'int'), 7);
    assert.equal(valueFromText('1.5e3', 'exponential'), 1500);
  });

  test('"nan" is an absent reading, and becomes null rather than NaN', () => {
    // NaN would be invisible to isDuplicate/significantlyDifferent, every comparison against it
    // being false. null is testable, which is the whole point of the conversion.
    assert.equal(valueFromText('nan', 'float'), null);
    assert.equal(valueFromText('nan', 'int'), null);
    assert.equal(valueFromText('rubbish', 'float'), null);
  });

  test('strings are passed through unchanged', () => {
    assert.equal(valueFromText('hello world', 'text'), 'hello world');
    assert.equal(valueFromText('dev/lotus/n1/sht/temperature', 'topic'), 'dev/lotus/n1/sht/temperature');
    assert.equal(valueFromText('#FF5733', 'color'), '#FF5733');
  });

  test('yaml is parsed', () => {
    assert.deepEqual(valueFromText('a: 1\nb: two\n', 'yaml'), { a: 1, b: 'two' });
  });

  test('an unknown type yields undefined, and says so', () => {
    let value;
    const lines = captureConsole(() => { value = valueFromText('123', 'nosuchtype'); });
    assert.equal(value, undefined);
    assert.match(lines.join('\n'), /Unrecognized message type/);
  });

  test('a missing type yields undefined', () => {
    let value;
    captureConsole(() => { value = valueFromText('123', undefined); });
    assert.equal(value, undefined);
  });
});

describe('significantlyDifferent', () => {
  test('absolute threshold', () => {
    assert.equal(significantlyDifferent(5.6, 5, 0.5), true);
    assert.equal(significantlyDifferent(5.5, 5, 0.5), true); // Boundary counts as significant
    assert.equal(significantlyDifferent(5.2, 5, 0.5), false);
    assert.equal(significantlyDifferent(4.4, 5, 0.5), true); // Movement down counts too
  });

  test('percentage threshold', () => {
    assert.equal(significantlyDifferent(102, 100, '2%'), true);
    assert.equal(significantlyDifferent(101, 100, '2%'), false);
    assert.equal(significantlyDifferent(98, 100, '2%'), true);
    assert.equal(significantlyDifferent(102, 100, ' 2% '), true); // Whitespace in the yaml
  });

  test('percentage of a negative last value uses the magnitude', () => {
    assert.equal(significantlyDifferent(-102, -100, '2%'), true);
    assert.equal(significantlyDifferent(-101, -100, '2%'), false);
  });

  test('any non-zero move away from zero is significant', () => {
    // There is no percentage of zero to take, so the rule cannot be applied as written
    assert.equal(significantlyDifferent(0.001, 0, '50%'), true);
    assert.equal(significantlyDifferent(0, 0, '50%'), false);
  });

  test('an unparsable percentage is not significant, and says so', () => {
    let result;
    const lines = captureConsole(() => { result = significantlyDifferent(100, 1, 'lots%'); });
    assert.equal(result, false);
    assert.match(lines.join('\n'), /Unparsable significantvalue percentage/);
  });
});

describe('isDuplicate', () => {
  const rules = { significantdate: 60000, significantvalue: 0.5 };

  test('with no rules nothing is a duplicate', () => {
    assert.equal(isDuplicate(1000, 't', 5, undefined, 1000, 5), false);
    assert.equal(isDuplicate(1000, 't', 5, null, 1000, 5), false);
  });

  test('an exact repeat at the same instant is a duplicate', () => {
    assert.equal(isDuplicate(1000, 't', 5, rules, 1000, 5), true);
  });

  test('a big enough change is recorded even if the last one was recent', () => {
    assert.equal(isDuplicate(1500, 't', 6, rules, 1000, 5), false);
  });

  test('a long enough gap is recorded even if the value barely moved', () => {
    assert.equal(isDuplicate(100000, 't', 5.01, rules, 30000, 5), false);
  });

  test('neither rule met is a duplicate', () => {
    assert.equal(isDuplicate(1500, 't', 5.1, rules, 1000, 5), true);
  });

  test('one rule alone still decides', () => {
    assert.equal(isDuplicate(9e9, 't', 5.1, { significantvalue: 0.5 }, 1000, 5), true);
    assert.equal(isDuplicate(1001, 't', 99, { significantdate: 60000 }, 1000, 5), true);
  });

  describe('invalid readings', () => {
    test('a reading going invalid is always recorded', () => {
      assert.equal(isDuplicate(1500, 't', null, rules, 1000, 5), false);
    });

    test('a reading coming back is always recorded', () => {
      assert.equal(isDuplicate(1500, 't', 5, rules, 1000, null), false);
    });

    test('a repeat of an already-invalid reading is a duplicate', () => {
      assert.equal(isDuplicate(1500, 't', null, rules, 1000, null), true);
    });

    test('the first reading of a sensor that starts out broken is recorded', () => {
      // lastvalue undefined means nothing has been logged yet, which is not the same as invalid
      assert.equal(isDuplicate(1500, 't', null, rules, undefined, undefined), false);
    });

    test('invalid readings are handled with no rules configured too', () => {
      assert.equal(isDuplicate(1500, 't', null, undefined, 1000, null), true);
    });
  });
});

describe('topicToDir', () => {
  const root = nodepath.resolve('/tmp/frugal-iot-test-data');

  beforeEach(() => _test.setDataDir('/tmp/frugal-iot-test-data'));

  test('an ordinary topic lands under the data directory', () => {
    assert.equal(topicToDir('dev/lotus/n1/sht/temperature'),
      nodepath.join(root, 'dev/lotus/n1/sht/temperature'));
  });

  test('a topic climbing out of the data directory is refused', () => {
    assert.equal(topicToDir('../escape'), null);
    assert.equal(topicToDir('dev/../../escape'), null);
    assert.equal(topicToDir('dev/lotus/../../../escape'), null);
  });

  test('a topic that is exactly the data directory is refused', () => {
    // Nothing is logged at the root, and letting it through would mean writing a file called
    // "<date>.csv" beside the organizations
    assert.equal(topicToDir(''), null);
    assert.equal(topicToDir(undefined), null);
    assert.equal(topicToDir('dev/..'), null);
  });

  test('an absolute topic is treated as relative to the data directory', () => {
    assert.equal(topicToDir('/etc/passwd'), nodepath.join(root, 'etc/passwd'));
  });

  test('a "../" that survives a single-pass strip still stays inside', () => {
    // "....//" is the sequence that defeated the sanitiser this replaced: removing the "../" it
    // contains leaves another one behind. Resolving first and checking where it landed does not care
    const result = topicToDir('....//dev/x');
    assert.ok(result === null || result.startsWith(root + nodepath.sep),
      `expected null or a path under ${root}, got ${result}`);
  });

  test('the data directory is read at call time, so start() can change it', () => {
    _test.setDataDir('/tmp/frugal-iot-other');
    assert.equal(topicToDir('dev/x'), nodepath.resolve('/tmp/frugal-iot-other/dev/x'));
  });
});
