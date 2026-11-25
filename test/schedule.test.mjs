import test from 'node:test';
import assert from 'node:assert/strict';

import { ScheduleError, buildSchedule, levelPayment, normalizeMethod } from '../lib/schedule.mjs';

/** Every schedule must close: principals sum to the loan, balance ends at zero. */
function assertCloses(schedule, principalCents) {
  const principalSum = schedule.rows.reduce((a, row) => a + row.principalCents, 0);
  const interestSum = schedule.rows.reduce((a, row) => a + row.interestCents, 0);
  assert.equal(principalSum, principalCents, 'principal parts must sum to the loan');
  assert.equal(schedule.rows.at(-1).balanceCents, 0, 'closing balance must be zero');
  assert.equal(schedule.totals.interestCents, interestSum);
  assert.equal(schedule.totals.principalCents, principalCents);
  for (const row of schedule.rows) {
    assert.equal(row.paymentCents, row.principalCents + row.interestCents, `period ${row.period} must balance`);
  }
}

test('method aliases: English ids and Chinese names both work', () => {
  assert.equal(normalizeMethod(undefined), 'equal-installment');
  assert.equal(normalizeMethod('等额本金'), 'equal-principal');
  assert.equal(normalizeMethod('先息后本'), 'interest-only');
  assert.equal(normalizeMethod('气球贷'), 'balloon');
  assert.equal(normalizeMethod('EQUAL-INSTALLMENT'), 'equal-installment');
  assert.throws(() => normalizeMethod('只还利息'), ScheduleError);
});

test('equal installment: a 30-year 3.5% mortgage', () => {
  const schedule = buildSchedule({
    principalCents: 100_000_000,
    annualRate: 0.035,
    periods: 360,
    method: 'equal-installment',
    startDate: '2026-01-15',
  });
  assertCloses(schedule, 100_000_000);
  assert.equal(schedule.rows.length, 360);
  assert.ok(Math.abs(schedule.paymentCents - 449_045) <= 1, `payment drifted: ${schedule.paymentCents}`);
  assert.equal(schedule.rows[0].dueDate, '2026-02-15');
  assert.equal(schedule.rows.at(-1).dueDate, '2056-01-15');
  // Interest dominates the early years and shrinks to almost nothing at the end.
  assert.ok(schedule.rows[0].interestCents > schedule.rows[0].principalCents);
  assert.ok(schedule.rows.at(-1).interestCents < 2_000);
});

test('levelPayment has a closed form and a zero-rate fallback', () => {
  assert.equal(levelPayment(1_200_000, 0, 12), 100_000);
  const payment = levelPayment(100_000_000, 0.035 / 12, 360);
  assert.ok(Math.abs(payment - 449_045) <= 1);
});

test('equal principal: principal is flat, payments fall', () => {
  const schedule = buildSchedule({
    principalCents: 1_200_000,
    annualRate: 0.12,
    periods: 12,
    method: 'equal-principal',
  });
  assertCloses(schedule, 1_200_000);
  assert.equal(schedule.rows[0].principalCents, 100_000);
  assert.equal(schedule.rows[0].interestCents, 12_000);
  assert.equal(schedule.rows[0].paymentCents, 112_000);
  assert.equal(schedule.rows.at(-1).paymentCents, 101_000);
  for (let i = 1; i < schedule.rows.length; i += 1) {
    assert.ok(schedule.rows[i].paymentCents < schedule.rows[i - 1].paymentCents);
  }
});

test('interest only accrues on the daily clock and repays principal at maturity', () => {
  const schedule = buildSchedule({
    principalCents: 1_000_000,
    annualRate: 0.1,
    periods: 12,
    method: 'interest-only',
    startDate: '2026-01-01',
    basis: 'ACT/360',
  });
  assertCloses(schedule, 1_000_000);
  assert.equal(schedule.convention.interestClock, 'daily');
  // January has 31 days: 10,000 × 10% × 31/360
  assert.equal(schedule.rows[0].interestCents, 8_611);
  assert.equal(schedule.rows[0].principalCents, 0);
  // February has 28.
  assert.equal(schedule.rows[1].interestCents, 7_778);
  // Maturity pays the whole principal back with the last period's interest.
  assert.equal(schedule.rows.at(-1).principalCents, 1_000_000);
});

test('the basis changes the answer, which is why it is mandatory', () => {
  const base = {
    principalCents: 1_000_000,
    annualRate: 0.1,
    periods: 12,
    method: 'interest-only',
    startDate: '2026-01-01',
  };
  const act360 = buildSchedule({ ...base, basis: 'ACT/360' });
  const act365 = buildSchedule({ ...base, basis: 'ACT/365' });
  const thirty = buildSchedule({ ...base, basis: '30/360' });
  assert.equal(act360.rows[0].interestCents, 8_611);
  assert.equal(act365.rows[0].interestCents, 8_493);
  assert.equal(thirty.rows[0].interestCents, 8_333);
});

test('balloon pays a long-amortisation instalment and settles at maturity', () => {
  const schedule = buildSchedule({
    principalCents: 1_000_000,
    annualRate: 0.06,
    periods: 24,
    method: 'balloon',
    balloonOver: 120,
  });
  assertCloses(schedule, 1_000_000);
  assert.equal(schedule.convention.balloonOver, 120);
  assert.ok(schedule.rows.at(-1).paymentCents > schedule.rows[0].paymentCents * 5);
});

test('a zero-rate loan is exactly the principal spread over the periods', () => {
  const schedule = buildSchedule({ principalCents: 1_200_000, annualRate: 0, periods: 12 });
  assertCloses(schedule, 1_200_000);
  assert.equal(schedule.totals.interestCents, 0);
  for (const row of schedule.rows) assert.equal(row.interestCents, 0);
  assert.equal(schedule.totals.paymentCents, 1_200_000);
});

test('a monthly method reports an ignored basis instead of silently using it', () => {
  const schedule = buildSchedule({
    principalCents: 1_200_000,
    annualRate: 0.12,
    periods: 12,
    method: 'equal-principal',
    basis: 'ACT/360',
  });
  assert.equal(schedule.warnings.length, 1);
  assert.match(schedule.warnings[0], /不参与计算/);
});

test('dates are optional for monthly methods', () => {
  const schedule = buildSchedule({ principalCents: 1_200_000, annualRate: 0.12, periods: 12 });
  assert.equal(schedule.rows[0].dueDate, null);
});

test('equal principal splits the principal exactly, even when P/n is sub-fen', () => {
  // ¥0.03 over 7 periods: a single rounded instalment would be 0 fen and the
  // schedule would never amortise. The largest-remainder split keeps it exact.
  const schedule = buildSchedule({ principalCents: 3, annualRate: 0.12, periods: 7, method: 'equal-principal' });
  assertCloses(schedule, 3);
  assert.deepEqual(schedule.rows.map((row) => row.principalCents), [1, 1, 1, 0, 0, 0, 0]);
  assert.equal(schedule.paymentCents, null, 'equal principal has no level instalment');
  assert.ok(schedule.firstPaymentCents > schedule.lastPaymentCents);
});

test('a level payment is only reported for shapes that have one', () => {
  const level = buildSchedule({ principalCents: 1_200_000, annualRate: 0.12, periods: 12 });
  assert.equal(level.paymentCents, level.rows[0].paymentCents);

  const declining = buildSchedule({ principalCents: 1_200_000, annualRate: 0.12, periods: 12, method: 'equal-principal' });
  assert.equal(declining.paymentCents, null);
  assert.equal(declining.firstPaymentCents, 112_000);
});

test('bad input fails with a reason, not a wrong table', () => {
  assert.throws(() => buildSchedule({ principalCents: 0, annualRate: 0.1, periods: 12 }), /principal/);
  assert.throws(() => buildSchedule({ principalCents: 1000, annualRate: 1.5, periods: 12 }), /ratio/);
  assert.throws(() => buildSchedule({ principalCents: 1000, annualRate: 0.1, periods: 0 }), /periods/);
  assert.throws(
    () => buildSchedule({ principalCents: 1000, annualRate: 0.1, periods: 12, method: 'interest-only', startDate: '2026-01-01' }),
    /basis is required/,
  );
  assert.throws(
    () => buildSchedule({ principalCents: 1000, annualRate: 0.1, periods: 12, method: 'interest-only', basis: 'ACT/360' }),
    /startDate/,
  );
  assert.throws(
    () => buildSchedule({ principalCents: 1000, annualRate: 0.1, periods: 12, balloonOver: 6, method: 'balloon' }),
    /balloonOver/,
  );
});
