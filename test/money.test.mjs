import test from 'node:test';
import assert from 'node:assert/strict';

import { allocate, formatAmount, formatCny, mulRate, roundHalfUp, toCents } from '../lib/money.mjs';

test('toCents accepts numbers, numeric strings, separators and 元', () => {
  assert.equal(toCents(0.1), 10);
  assert.equal(toCents(10000), 1000000);
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('¥100'), 10000);
  assert.equal(toCents('100元'), 10000);
});

test('toCents rejects nonsense instead of coercing it', () => {
  assert.throws(() => toCents('abc'), /not a number/);
  assert.throws(() => toCents(Number.NaN), /finite/);
  assert.throws(() => toCents(1e13), /out of range/);
});

test('roundHalfUp survives binary representation error', () => {
  // 0.145 * 100 === 14.499999999999998 in IEEE 754; a naive Math.round loses the half.
  assert.equal(roundHalfUp(0.145, 2), 0.15);
  assert.equal(roundHalfUp(1.005, 2), 1.01);
  assert.equal(roundHalfUp(2.675, 2), 2.68);
  // A value that is genuinely below the half stays below.
  assert.equal(roundHalfUp(14.4999, 0), 14);
});

test('formatCny keeps the sign outside the symbol and pads fen', () => {
  assert.equal(formatCny(123456), '¥1,234.56');
  assert.equal(formatCny(-123456), '-¥1,234.56');
  assert.equal(formatCny(5), '¥0.05');
  assert.equal(formatAmount(100000000), '1,000,000.00');
});

test('mulRate rounds once to whole fen', () => {
  assert.equal(mulRate(1000000, 0.0035), 3500);
  assert.equal(mulRate(101, 0.5), 51);
});

test('allocate never loses or invents a fen', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);

  for (const total of [1, 7, 999, 123457]) {
    for (const weights of [[1, 1, 1], [3, 2, 1], [0, 5, 0], [1, 1, 1, 1, 1, 1, 1]]) {
      const parts = allocate(total, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `sum mismatch for ${total}/${weights}`);
      assert.ok(parts.every((part) => Number.isInteger(part) && part >= 0));
    }
  }
});

test('allocate rejects bad weights', () => {
  assert.throws(() => allocate(100, []), /non-empty/);
  assert.throws(() => allocate(100, [0, 0]), /all be zero/);
  assert.throws(() => allocate(100, [1, -1]), /non-negative/);
});
