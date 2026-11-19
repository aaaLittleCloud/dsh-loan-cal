import test from 'node:test';
import assert from 'node:assert/strict';

import { PrepayError, planPrepayment, remainingPeriodsAfterPrepay } from '../lib/prepay.mjs';

const BASE = Object.freeze({
  remainingPrincipalCents: 100_000_000, // ¥1,000,000
  annualRate: 0.049,
  remainingPeriods: 240,
  prepayCents: 10_000_000, // ¥100,000
});

test('the implied return of a penalty-free prepayment equals the loan rate', () => {
  const result = planPrepayment(BASE);
  // Prepaying at the contract rate must earn exactly the contract rate — this is
  // the sanity anchor for the whole module.
  assert.ok(Math.abs(result.reduceTerm.impliedReturn.nominalApr - 0.049) < 1e-4,
    `reduce-term: ${result.reduceTerm.impliedReturn.nominalApr}`);
  assert.ok(Math.abs(result.reducePayment.impliedReturn.nominalApr - 0.049) < 1e-4,
    `reduce-payment: ${result.reducePayment.impliedReturn.nominalApr}`);
  assert.ok(result.reduceTerm.savedInterestCents > 0);
  assert.equal(result.reduceTerm.netSavingCents, result.reduceTerm.savedInterestCents);
});

test('reducing the term shortens it and keeps the instalment', () => {
  const result = planPrepayment(BASE);
  assert.ok(result.reduceTerm.periods < BASE.remainingPeriods);
  assert.equal(result.reduceTerm.paymentCents, result.baseline.paymentCents);
  assert.equal(result.reducePayment.periods, BASE.remainingPeriods);
  assert.ok(result.reducePayment.paymentCents < result.baseline.paymentCents);
});

test('a penalty lowers the return and can make the whole thing a loss', () => {
  const penalised = planPrepayment({ ...BASE, penaltyCents: 2_000_000 }); // ¥20,000
  assert.ok(penalised.reduceTerm.impliedReturn.nominalApr < 0.049);
  assert.equal(penalised.reduceTerm.netSavingCents, penalised.reduceTerm.savedInterestCents - 2_000_000);

  const crushing = planPrepayment({ ...BASE, penaltyCents: 900_000_000 });
  assert.ok(crushing.reduceTerm.netSavingCents < 0);
  assert.ok(crushing.warnings.some((warning) => /净亏/.test(warning)));
});

test('paying off the whole balance leaves no schedule and saves all future interest', () => {
  const result = planPrepayment({ ...BASE, prepayCents: BASE.remainingPrincipalCents });
  assert.equal(result.fullPayoff, true);
  assert.equal(result.reduceTerm.periods, 0);
  assert.equal(result.newPrincipalCents, 0);
  assert.equal(result.reduceTerm.savedInterestCents, result.baseline.interestCents);
  assert.ok(result.reduceTerm.paybackPeriods > 0);
});

test('comparing with an investment yield flips the verdict', () => {
  const cheap = planPrepayment({ ...BASE, compareYield: 0.02 });
  assert.equal(cheap.comparison.reduceTerm.verdict, 'prepay-wins');
  assert.ok(cheap.comparison.reduceTerm.gapPoints > 0);

  const expensive = planPrepayment({ ...BASE, compareYield: 0.08 });
  assert.equal(expensive.comparison.reduceTerm.verdict, 'invest-wins');
  assert.ok(expensive.comparison.reduceTerm.gapPoints < 0);
});

test('remainingPeriodsAfterPrepay is monotone and guards unpayable debt', () => {
  const rate = 0.049 / 12;
  const short = remainingPeriodsAfterPrepay({ newPrincipalCents: 50_000_000, monthlyRate: rate, paymentCents: 1_000_000 });
  const long = remainingPeriodsAfterPrepay({ newPrincipalCents: 90_000_000, monthlyRate: rate, paymentCents: 1_000_000 });
  assert.ok(long > short);
  assert.throws(
    () => remainingPeriodsAfterPrepay({ newPrincipalCents: 100_000_000, monthlyRate: 0.05, paymentCents: 100_000 }),
    /does not cover the interest/,
  );
});

test('bad input is rejected', () => {
  assert.throws(() => planPrepayment({ ...BASE, prepayCents: BASE.remainingPrincipalCents + 1 }), PrepayError);
  assert.throws(() => planPrepayment({ ...BASE, prepayCents: 0 }), PrepayError);
  assert.throws(() => planPrepayment({ ...BASE, remainingPeriods: 0 }), PrepayError);
  assert.throws(() => planPrepayment({ ...BASE, annualRate: 2 }), PrepayError);
});
