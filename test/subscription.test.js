// Subscription matching. The logger subscribes to "<org>/#" plus a per-project topic, and then
// decides locally which of its subscriptions a delivered message belongs to, so these are the rules
// that route a message to its callback.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../index.js';

const { Subscription } = _test;

const sub = (topic) => new Subscription(topic, 0, () => {});

// matches() is used for its truthiness, so assert that rather than an exact true/false
const assertMatches = (s, topic) => assert.ok(s.matches(topic), `${s.topic} should match ${topic}`);
const assertNoMatch = (s, topic) => assert.ok(!s.matches(topic), `${s.topic} should not match ${topic}`);

describe('Subscription.matches', () => {
  describe('an exact topic', () => {
    const s = sub('dev/lotus/n1/sht/temperature');

    test('matches itself', () => assertMatches(s, 'dev/lotus/n1/sht/temperature'));
    test('does not match a different leaf', () => assertNoMatch(s, 'dev/lotus/n1/sht/humidity'));
    test('does not match a longer topic', () => assertNoMatch(s, 'dev/lotus/n1/sht/temperature/x'));
    test('does not match a prefix of itself', () => assertNoMatch(s, 'dev/lotus/n1/sht'));
  });

  describe('a "#" subscription', () => {
    const s = sub('dev/#');

    test('matches everything in the organization', () => {
      assertMatches(s, 'dev/lotus/n1/sht/temperature');
      assertMatches(s, 'dev/lotus');
      assertMatches(s, 'dev/lotus/n1/set/relay/on');
    });

    test('does not match another organization', () => {
      assertNoMatch(s, 'other/lotus/n1/sht/temperature');
      // The prefix compared includes the separator, so an organization whose name starts with
      // this one's is not swept up
      assertNoMatch(s, 'development/lotus/n1');
    });

    test('does not match the organization on its own', () => assertNoMatch(s, 'dev'));
  });

  describe('a "+" subscription', () => {
    const s = sub('dev/+/n1/sht/temperature');

    test('matches any value in the wildcard position', () => {
      assertMatches(s, 'dev/lotus/n1/sht/temperature');
      assertMatches(s, 'dev/banana/n1/sht/temperature');
    });

    test('does not match when a fixed level differs', () => {
      assertNoMatch(s, 'dev/lotus/n2/sht/temperature');
      assertNoMatch(s, 'other/lotus/n1/sht/temperature');
      assertNoMatch(s, 'dev/lotus/n1/sht/humidity');
    });
  });

  describe('the per-project subscription the logger makes', () => {
    // watchProject() subscribes to "<org>/<project>" to catch quickdiscover announcements
    const s = sub('dev/+');

    test('matches an organization/project announcement', () => assertMatches(s, 'dev/lotus'));
    test('does not match a reading below it', () => assertNoMatch(s, 'dev/lotus/n1/sht/temperature'));
    test('does not match another organization', () => assertNoMatch(s, 'other/lotus'));
  });
});

describe('Subscription.dispatch', () => {
  test('calls the callback with a date it supplies itself', () => {
    const calls = [];
    const s = new Subscription('dev/#', 0, (...args) => calls.push(args));
    const before = Date.now();
    s.dispatch('dev/lotus/n1/sht/temperature', '25.3', false);
    const after = Date.now();

    assert.equal(calls.length, 1);
    const [date, topic, message, retained] = calls[0];
    assert.ok(date instanceof Date);
    assert.ok(date.valueOf() >= before && date.valueOf() <= after);
    assert.equal(topic, 'dev/lotus/n1/sht/temperature');
    assert.equal(message, '25.3');
    assert.equal(retained, false);
  });

  test('passes the retained flag through', () => {
    let seen;
    const s = new Subscription('dev/#', 0, (date, topic, message, retained) => { seen = retained; });
    s.dispatch('dev/lotus/n1/sht/temperature', '25.3', true);
    assert.equal(seen, true);
  });
});
