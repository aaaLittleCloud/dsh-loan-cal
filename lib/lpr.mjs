/**
 * Rate reset (LPR repricing).
 *
 * Deliberately does not ship an LPR history table: a bundled snapshot goes stale
 * silently, and a wrong rate is worse than no rate. The caller passes the LPR that
 * applies; this module only does the deterministic part — new rate = LPR + spread,
 * then the new instalment and the remaining interest.
 *
 * The spread (加点) is fixed for the life of a Chinese mortgage; only the LPR moves.
 */
import { buildSchedule } from './schedule.mjs';

export class LprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LprError';
  }
}

/**
 * @param options.remainingPrincipalCents Outstanding balance.
 * @param options.remainingPeriods       Periods left.
 * @param options.spreadBp               Fixed spread over LPR, in basis points (55 = 0.55%).
 * @param options.newLpr                 The LPR that applies after repricing, as a ratio (0.035).
 * @param options.oldLpr                 The previous LPR, to show the change. Optional.
 */
export function resetRate(options) {
  const {
    remainingPrincipalCents,
    remainingPeriods,
    spreadBp,
    newLpr,
    oldLpr = null,
  } = options;

  if (!Number.isSafeInteger(remainingPrincipalCents) || remainingPrincipalCents <= 0) {
    throw new LprError('remainingPrincipalCents must be a positive integer number of fen');
  }
  if (!Number.isInteger(remainingPeriods) || remainingPeriods < 1 || remainingPeriods > 600) {
    throw new LprError('remainingPeriods must be an integer between 1 and 600');
  }
  if (!Number.isFinite(spreadBp) || Math.abs(spreadBp) > 2000) {
    throw new LprError('spreadBp must be between -2000 and 2000 basis points');
  }
  for (const [label, value] of [['newLpr', newLpr], ['oldLpr', oldLpr]]) {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 0.5)) {
      throw new LprError(`${label} must be a ratio between 0 and 0.5 (3.5% → 0.035)`);
    }
  }

  const newRate = newLpr + spreadBp / 10_000;
  if (newRate <= 0) throw new LprError('LPR + spread is not a positive rate');
  if (newRate > 1) throw new LprError('LPR + spread exceeds 100%');

  const after = buildSchedule({
    principalCents: remainingPrincipalCents,
    annualRate: newRate,
    periods: remainingPeriods,
    method: 'equal-installment',
  });

  let before = null;
  if (oldLpr !== null) {
    const oldRate = oldLpr + spreadBp / 10_000;
    if (oldRate <= 0 || oldRate > 1) throw new LprError('old LPR + spread is out of range');
    before = buildSchedule({
      principalCents: remainingPrincipalCents,
      annualRate: oldRate,
      periods: remainingPeriods,
      method: 'equal-installment',
    });
  }

  return {
    spreadBp,
    newLpr,
    oldLpr,
    newRate,
    oldRate: before === null ? null : oldLpr + spreadBp / 10_000,
    paymentCents: after.paymentCents,
    oldPaymentCents: before === null ? null : before.paymentCents,
    paymentDeltaCents: before === null ? null : after.paymentCents - before.paymentCents,
    interestCents: after.totals.interestCents,
    oldInterestCents: before === null ? null : before.totals.interestCents,
    interestDeltaCents: before === null ? null : after.totals.interestCents - before.totals.interestCents,
    periods: remainingPeriods,
    principalCents: remainingPrincipalCents,
  };
}
