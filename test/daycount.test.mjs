import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASES,
  DayCountError,
  accrualCents,
  actualDays,
  addMonths,
  dayCount,
  fromUtcDay,
  parseBasis,
  thirty360Days,
  toUtcDay,
} from '../lib/daycount.mjs';

test('parseBasis accepts the canonical ids, aliases and Chinese names', () => {
  assert.equal(parseBasis('ACT/360'), 'ACT/360');
  assert.equal(parseBasis('act_365'), 'ACT/365');
  assert.equal(parseBasis('30/360'), '30/360');
  assert.equal(parseBasis('实际/360'), 'ACT/360');
  assert.equal(parseBasis('  ACT / 365 '), 'ACT/365');
});

test('an unknown or missing basis is an error, never a default', () => {
  assert.throws(() => parseBasis('ACT/364'), DayCountError);
  assert.throws(() => parseBasis(''), /required/);
  assert.throws(() => parseBasis(undefined), /required/);
});

test('dates round-trip and impossible dates are rejected', () => {
  assert.equal(toUtcDay('2026-01-01') + 31, toUtcDay('2026-02-01'));
  assert.equal(fromUtcDay(toUtcDay('2024-02-29')), '2024-02-29');
  assert.throws(() => toUtcDay('2026-02-30'), /not a real date/);
  assert.throws(() => toUtcDay('2026/01/01'), /YYYY-MM-DD/);
});

test('actual days cross month and leap-year boundaries', () => {
  assert.equal(actualDays('2026-01-01', '2026-02-01'), 31);
  assert.equal(actualDays('2024-02-28', '2024-03-01'), 2); // leap year
  assert.equal(actualDays('2026-02-28', '2026-03-01'), 1);
  assert.equal(actualDays('2026-01-01', '2027-01-01'), 365);
});

test('30/360 counts every month as 30 days and handles month-ends', () => {
  assert.equal(thirty360Days('2026-01-31', '2026-02-28'), 30);
  assert.equal(thirty360Days('2026-02-28', '2026-03-31'), 30);
  assert.equal(thirty360Days('2026-03-31', '2026-04-30'), 30);
  assert.equal(thirty360Days('2026-01-01', '2026-07-01'), 180);
  assert.equal(thirty360Days('2026-01-01', '2027-01-01'), 360);
  // A 31st start only becomes the 30th when the end day is also a 31st.
  assert.equal(thirty360Days('2026-01-31', '2026-03-15'), 45);
});

test('dayCount dispatches on the basis', () => {
  assert.equal(dayCount('2026-01-01', '2026-02-01', 'ACT/365'), 31);
  assert.equal(dayCount('2026-01-01', '2026-02-01', '30/360'), 30);
  assert.throws(() => dayCount('2026-01-01', '2026-02-01', 'ACT/999'), DayCountError);
});

test('addMonths clamps to the last day of the target month', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-01-01', 12), '2027-01-01');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
});

test('accrual is balance × rate × days / denominator, rounded once', () => {
  // ¥10,000 at 10% for 30 days
  assert.equal(accrualCents(1_000_000, 0.1, 30, 'ACT/360'), 8333);
  assert.equal(accrualCents(1_000_000, 0.1, 30, 'ACT/365'), 8219);
  assert.equal(accrualCents(1_000_000, 0.1, 30, '30/360'), 8333);
  assert.throws(() => accrualCents(1_000_000, 0.1, 0, 'ACT/360'), /positive/);
  assert.throws(() => accrualCents(1_000_000, 0.1, 30, 'ACT/364'), DayCountError);
});

test('the basis catalogue stays in sync with what the tool advertises', () => {
  assert.deepEqual(Object.keys(BASES), ['ACT/365', 'ACT/360', '30/360']);
});
