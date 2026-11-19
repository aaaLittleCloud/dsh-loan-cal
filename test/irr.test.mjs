import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IrrError,
  annualizeEffective,
  annualizeNominal,
  aprFromInstallment,
  monthlyIrr,
  npv,
} from '../lib/irr.mjs';

/** The canonical case: ¥10,000 over 12 periods at a quoted 0.6%/month fee. */
const CARD_CASE = {
  principalCents: 1_000_000,
  periods: 12,
  paymentCents: 89_333, // 83333 principal + 6000 fee
  monthlyFeeRate: 0.006,
};

test('monthlyIrr solves the card-installment case', () => {
  const flows = [-CARD_CASE.principalCents, ...Array(12).fill(CARD_CASE.paymentCents)];
  const monthly = monthlyIrr(flows);
  // Regression pin: 1.0861%/month, cross-checked by hand against the annuity factor.
  assert.ok(Math.abs(monthly - 0.010861261557269731) < 1e-12, `monthly IRR drifted: ${monthly}`);
  // Bisection leaves a residual far below one fen, measured against the principal.
  assert.ok(
    Math.abs(npv(monthly, flows)) < CARD_CASE.principalCents * 1e-9,
    `NPV at the solved rate must be ~0, got ${npv(monthly, flows)}`,
  );
});

test('annualisation: nominal is ×12, effective compounds', () => {
  const monthly = 0.01;
  assert.equal(annualizeNominal(monthly), 0.12);
  assert.ok(Math.abs(annualizeEffective(monthly) - (1.01 ** 12 - 1)) < 1e-15);
  assert.ok(annualizeEffective(monthly) > annualizeNominal(monthly));
});

test('aprFromInstallment reports 13.03% nominal / 13.84% effective for 0.6% × 12', () => {
  const result = aprFromInstallment(CARD_CASE);
  assert.equal(result.paymentCents, 89_333);
  assert.equal(result.totalRepay, 1_071_996);
  assert.equal(result.totalCost, 71_996);
  assert.ok(Math.abs(result.nominalApr - 0.13033513868723678) < 1e-9, `nominal: ${result.nominalApr}`);
  assert.ok(Math.abs(result.effectiveApr - 0.13840985012919016) < 1e-9, `effective: ${result.effectiveApr}`);
  assert.ok(Math.abs(result.naiveAnnual - 0.072) < 1e-12);
  // The whole point of the tool: the compounded number is ~6.6 points above the pitch.
  assert.ok(Math.abs(result.gapPoints - 0.06640985012919016) < 1e-9, `gap: ${result.gapPoints}`);
  assert.ok(Math.abs(result.gapPointsNominal - 0.05833513868723678) < 1e-9);
});

test('a real mortgage rate round-trips through the IRR solver', () => {
  // ¥1,000,000 over 360 months at 3.5% annual → payment 4,490.45, APR back to 3.5%.
  const result = aprFromInstallment({
    principalCents: 100_000_000,
    periods: 360,
    paymentCents: 449_045,
  });
  assert.ok(Math.abs(result.nominalApr - 0.035) < 5e-4, `nominal: ${result.nominalApr}`);
});

test('an upfront fee raises the cost', () => {
  const withFee = aprFromInstallment({ ...CARD_CASE, upfrontFeeCents: 50_000 });
  const without = aprFromInstallment(CARD_CASE);
  assert.ok(withFee.nominalApr > without.nominalApr);
  assert.equal(withFee.netProceeds, 950_000);
  assert.equal(withFee.totalCost, without.totalCost + 50_000);
});

test('an interest-free plan really is zero', () => {
  const result = aprFromInstallment({ principalCents: 1_200_000, periods: 12, paymentCents: 100_000 });
  assert.ok(Math.abs(result.nominalApr) < 1e-9, `expected 0%, got ${result.nominalApr}`);
});

test('bad streams fail loudly', () => {
  assert.throws(() => monthlyIrr([100, 100]), IrrError);
  assert.throws(() => monthlyIrr([100, -100]), /first cash flow/);
  assert.throws(() => monthlyIrr([-100]), /at least two/);
  assert.throws(() => monthlyIrr([-100, Number.NaN]), /finite/);
  assert.throws(() => aprFromInstallment({ ...CARD_CASE, periods: 0 }), /periods/);
  assert.throws(() => aprFromInstallment({ ...CARD_CASE, upfrontFeeCents: 1_000_000 }), /swallow/);
});
