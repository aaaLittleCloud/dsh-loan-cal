/**
 * Internal rate of return for a monthly cash-flow stream.
 *
 * A loan is a single outflow at t0 followed by equal inflows: the rate that makes
 * the discounted sum zero is the monthly IRR, and every "real APR" in this plugin
 * is a function of it. There is no closed form, so this solves numerically — but
 * on a conventional loan NPV is monotonically decreasing in the rate, which makes
 * bisection both sufficient and impossible to fool with a bad starting guess.
 */

export class IrrError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IrrError';
  }
}

/** Net present value of `flows` at a per-period `rate`. flows[0] is t = 0. */
export function npv(rate, flows) {
  if (rate <= -1) throw new IrrError('npv: rate must be greater than -100%');
  let total = 0;
  for (let i = 0; i < flows.length; i += 1) {
    total += flows[i] / (1 + rate) ** i;
  }
  return total;
}

/**
 * Solve for the monthly rate where NPV = 0.
 *
 * @param flows Cash flows in any consistent unit (cents here). Must contain at
 *              least one negative and one positive entry, and the negative must
 *              come first (a loan, not an investment).
 */
export function monthlyIrr(flows, options = {}) {
  const {
    lo = -0.999999,
    hi = 10,
    tolerance = 1e-12,
    maxIterations = 300,
  } = options;

  if (!Array.isArray(flows) || flows.length < 2) throw new IrrError('monthlyIrr: need at least two cash flows');
  for (const flow of flows) {
    if (!Number.isFinite(flow)) throw new IrrError('monthlyIrr: every cash flow must be finite');
  }
  if (!flows.some((f) => f < 0) || !flows.some((f) => f > 0)) {
    throw new IrrError('monthlyIrr: cash flows need both signs — this does not look like a loan');
  }
  if (flows[0] > 0) throw new IrrError('monthlyIrr: the first cash flow must be the money received (negative)');

  /**
   * NPV near r = -1 overflows to ±Infinity or NaN (0 × Infinity), which breaks
   * sign comparisons. Non-finite points are skipped and never bracket a root:
   * for loan streams the root is always in the well-behaved region anyway.
   */
  const bisect = (low, high, fLow) => {
    let a = low;
    let b = high;
    let fa = fLow;
    for (let i = 0; i < maxIterations; i += 1) {
      const mid = (a + b) / 2;
      const fm = npv(mid, flows);
      if (!Number.isFinite(fm)) {
        // Shrink away from the overflowing end and retry.
        if (a < 0 && b < 0) { a = mid; fa = npv(a, flows); continue; }
        b = mid;
        continue;
      }
      if (fm === 0 || (b - a) / 2 < tolerance) return mid;
      // Sign-preserving step, so either orientation of the bracket works.
      if ((fm > 0) === (fa > 0)) { a = mid; fa = fm; } else b = mid;
    }
    return (a + b) / 2;
  };

  const fLow = npv(lo, flows);
  const fHigh = npv(hi, flows);
  if (Number.isFinite(fLow) && Number.isFinite(fHigh) && fLow > 0 && fHigh < 0) {
    return bisect(lo, hi, fLow);
  }

  // Deferred streams (nothing paid for years, then a balloon) do not flip sign at
  // the edges, so scan for the first bracket on finite values.
  const steps = 2000;
  let previous = null;
  for (let i = 0; i <= steps; i += 1) {
    const rate = lo + ((hi - lo) * i) / steps;
    const value = npv(rate, flows);
    if (!Number.isFinite(value)) { previous = null; continue; }
    if (value === 0) return rate;
    if (previous !== null && (value > 0) !== (previous.value > 0)) {
      return bisect(previous.rate, rate, previous.value);
    }
    previous = { rate, value };
  }

  throw new IrrError(
    `monthlyIrr: no sign change on [${lo}, ${hi}] — the stream may not be a conventional loan`,
  );
}

/** Monthly rate → nominal annual (simple ×12), the number a contract must disclose. */
export function annualizeNominal(monthlyRate) {
  if (!Number.isFinite(monthlyRate)) throw new IrrError('annualizeNominal: rate must be finite');
  return monthlyRate * 12;
}

/** Monthly rate → effective annual (compounded), the number the borrower actually pays. */
export function annualizeEffective(monthlyRate) {
  if (!Number.isFinite(monthlyRate) || monthlyRate <= -1) {
    throw new IrrError('annualizeEffective: rate must be finite and above -100%');
  }
  return (1 + monthlyRate) ** 12 - 1;
}

/**
 * Turn an installment plan into the three annual figures that matter.
 *
 * The pitch for a card installment is a monthly *fee rate* on the original
 * principal (等本等费), which is not an interest rate: the borrower keeps less
 * principal every month while still paying the fee on all of it. The honest
 * comparison is the IRR of the actual cash flows.
 *
 * @param options.principalCents    Amount lent.
 * @param options.periods           Number of installments (≥1).
 * @param options.paymentCents      Amount paid in every period.
 * @param options.upfrontFeeCents   Deducted at disbursement (default 0).
 * @param options.monthlyFeeRate    The quoted monthly fee rate (0.006 for 0.6%), optional.
 */
export function aprFromInstallment(options) {
  const {
    principalCents,
    periods,
    paymentCents,
    upfrontFeeCents = 0,
    monthlyFeeRate = null,
  } = options;

  if (!Number.isSafeInteger(principalCents) || principalCents <= 0) {
    throw new IrrError('aprFromInstallment: principalCents must be a positive integer');
  }
  if (!Number.isInteger(periods) || periods < 1 || periods > 600) {
    throw new IrrError('aprFromInstallment: periods must be an integer between 1 and 600');
  }
  if (!Number.isSafeInteger(paymentCents) || paymentCents <= 0) {
    throw new IrrError('aprFromInstallment: paymentCents must be a positive integer');
  }
  if (!Number.isSafeInteger(upfrontFeeCents) || upfrontFeeCents < 0) {
    throw new IrrError('aprFromInstallment: upfrontFeeCents must be a non-negative integer');
  }

  const netProceeds = principalCents - upfrontFeeCents;
  if (netProceeds <= 0) {
    throw new IrrError('aprFromInstallment: upfront fees swallow the whole principal');
  }

  const flows = [-netProceeds];
  for (let i = 0; i < periods; i += 1) flows.push(paymentCents);

  const monthlyRate = monthlyIrr(flows);
  const totalRepay = paymentCents * periods;
  const totalCost = totalRepay + upfrontFeeCents - principalCents;

  // "业务员口径": total cost spread flat over the term. With a quoted fee rate
  // that is simply fee × 12 (the number usually said out loud); without one it is
  // the flat annualised cost, which understates the truth by construction.
  const naiveAnnual = monthlyFeeRate === null
    ? (totalCost / principalCents) * (12 / periods)
    : monthlyFeeRate * 12;

  // Two annualisations of the same monthly rate, and neither is "the" answer on
  // its own (ADR 0002): the compounded one is what the PBOC requires lenders to
  // disclose, the simple one is the basis of mortgage/LPR quotes.
  const nominalApr = annualizeNominal(monthlyRate);
  const effectiveApr = annualizeEffective(monthlyRate);

  return {
    principalCents,
    upfrontFeeCents,
    netProceeds,
    periods,
    paymentCents,
    totalRepay,
    totalCost,
    monthlyRate,
    nominalApr,
    effectiveApr,
    naiveAnnual,
    gapPoints: effectiveApr - naiveAnnual,
    gapPointsNominal: nominalApr - naiveAnnual,
  };
}
