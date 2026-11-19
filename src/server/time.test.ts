import assert from 'node:assert/strict';
import { test } from 'node:test';

import { utcDayKey } from './time';

test('utcDayKey formats the UTC date', () => {
  assert.equal(utcDayKey(0), '1970-01-01');
  assert.equal(utcDayKey(Date.UTC(2026, 10, 9, 23, 59, 59, 999)), '2026-11-09');
  assert.equal(utcDayKey(Date.UTC(2026, 10, 10, 0, 0, 0, 0)), '2026-11-10');
});
