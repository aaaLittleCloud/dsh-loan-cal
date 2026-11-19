/**
 * Prepayment analysis.
 *
 * The question a borrower actually asks is not "how much interest do I save" but
 * "is this lump sum better spent here than anywhere else" — so the headline output
 * is the *implied return* of the prepayment, i.e. the IRR of the eliminated
 * payments, next to the interest saved and the penalty paid.
 *
 * Two shapes, because banks offer two and they are not equivalent:
 *   reduce-term     keep the instalment, finish earlier
 *   reduce-payment  keep the term, pay less each month
 */
import { annualizeEffective, annualizeNominal, monthlyIrr } from './irr.mjs';
import { buildSchedule } from './schedule.mjs';

export class PrepayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrepayError';
  }
}

const pctOf = (ratio) => (ratio * 100).toFixed(4);

/**
 * @param options.remainingPrincipalCents Outstanding balance today.
 * @param options.annualRate             Contract rate as a ratio (0.035).
 * @param options.remainingPeriods       Periods left on the contract.
 * @param options.prepayCents            Amount repaid early, today.
 * @param options.penaltyCents           Contractual penalty, today.
 * @param options.compareYield           Optional alternative annual yield (ratio) to compare against.
 */
export function planPrepayment(options) {
  const {
    remainingPrincipalCents,
    annualRate,
    remainingPeriods,
    prepayCents,
    penaltyCents = 0,
    compareYield = null,
  } = options;

  if (!Number.isSafeInteger(remainingPrincipalCents) || remainingPrincipalCents <= 0) {
    throw new PrepayError('remainingPrincipalCents must be a positive integer number of fen');
  }
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 1) {
    throw new PrepayError('annualRate must be a ratio between 0 and 1');
  }
  if (!Number.isInteger(remainingPeriods) || remainingPeriods < 1 || remainingPeriods > 600) {
    throw new PrepayError('remainingPeriods must be an integer between 1 and 600');
  }
  if (!Number.isSafeInteger(prepayCents) || prepayCents <= 0) {
    throw new PrepayError('prepayCents must be a positive integer number of fen');
  }
  if (prepayCents > remainingPrincipalCents) {
    throw new PrepayError('prepayCents cannot exceed the outstanding principal');
  }
  if (!Number.isSafeInteger(penaltyCents) || penaltyCents < 0) {
    throw new PrepayError('penaltyCents must be a non-negative integer number of fen');
  }

  const baseline = buildSchedule({
    principalCents: remainingPrincipalCents,
    annualRate,
    periods: remainingPeriods,
    method: 'equal-installment',
  });
  const paymentCents = baseline.paymentCents;
  const monthlyRate = annualRate / 12;
  const newPrincipalCents = remainingPrincipalCents - prepayCents;
  const warnings = [];
  const fullPayoff = newPrincipalCents === 0;

  // --- reduce term: same instalment, fewer periods -------------------------
  let reduceTerm;
  if (fullPayoff) {
    reduceTerm = {
      periods: 0,
      paymentCents: 0,
      interestCents: 0,
      savedInterestCents: baseline.totals.interestCents,
      schedule: null,
    };
  } else {
    const periods = remainingPeriodsAfterPrepay({ newPrincipalCents, monthlyRate, paymentCents });
    const schedule = buildSchedule({
      principalCents: newPrincipalCents,
      annualRate,
      periods,
      method: 'equal-installment',
      paymentCents,
    });
    reduceTerm = {
      periods,
      paymentCents: schedule.paymentCents,
      interestCents: schedule.totals.interestCents,
      savedInterestCents: baseline.totals.interestCents - schedule.totals.interestCents,
      schedule,
    };
  }

  // --- reduce payment: same term, smaller instalment -----------------------
  let reducePayment;
  if (fullPayoff) {
    reducePayment = { periods: 0, paymentCents: 0, interestCents: 0, savedInterestCents: baseline.totals.interestCents, schedule: null };
  } else {
    const schedule = buildSchedule({
      principalCents: newPrincipalCents,
      annualRate,
      periods: remainingPeriods,
      method: 'equal-installment',
    });
    reducePayment = {
      periods: remainingPeriods,
      paymentCents: schedule.paymentCents,
      interestCents: schedule.totals.interestCents,
      savedInterestCents: baseline.totals.interestCents - schedule.totals.interestCents,
      schedule,
    };
  }

  // --- the implicit return on the cash you hand over today -----------------
  // Savings are taken period by period from the two schedules rather than from
  // the level instalment: the closing payment absorbs rounding, and using the
  // nominal instalment there would bias the IRR.
  const upfront = prepayCents + penaltyCents;
  const savingsOf = (option) => {
    const flows = [-upfront];
    for (let period = 1; period <= remainingPeriods; period += 1) {
      const before = baseline.rows[period - 1]?.paymentCents ?? 0;
      const after = option.schedule?.rows[period - 1]?.paymentCents ?? 0;
      flows.push(before - after);
    }
    return flows;
  };

  reduceTerm.impliedReturn = impliedReturn(savingsOf(reduceTerm));
  reducePayment.impliedReturn = impliedReturn(savingsOf(reducePayment));
  const monthlySaving = paymentCents - reducePayment.paymentCents;
  reduceTerm.paybackPeriods = payback(upfront, paymentCents, reduceTerm.periods);
  reducePayment.paybackPeriods = payback(upfront, monthlySaving);

  for (const [key, option] of Object.entries({ reduceTerm, reducePayment })) {
    option.netSavingCents = option.savedInterestCents - penaltyCents;
    if (option.netSavingCents < 0) {
      warnings.push(`${key === 'reduceTerm' ? '缩短期限' : '减少月供'}方案的违约金超过省下的利息，净亏 ${((penaltyCents - option.savedInterestCents) / 100).toFixed(2)} 元`);
    }
    if (option.impliedReturn === null) {
      warnings.push(`${key === 'reduceTerm' ? '缩短期限' : '减少月供'}方案没有可解的内部收益率（节省的现金流过小或为零）`);
    }
  }

  const comparison = compareYield === null ? null : buildComparison({ compareYield, reduceTerm, reducePayment });

  return {
    baseline: {
      principalCents: remainingPrincipalCents,
      periods: remainingPeriods,
      paymentCents,
      interestCents: baseline.totals.interestCents,
    },
    prepayCents,
    penaltyCents,
    newPrincipalCents,
    fullPayoff,
    reduceTerm,
    reducePayment,
    comparison,
    warnings,
  };
}

/** How many periods a fixed instalment needs to clear `newPrincipalCents`. */
export function remainingPeriodsAfterPrepay({ newPrincipalCents, monthlyRate, paymentCents }) {
  if (newPrincipalCents <= 0) return 0;
  if (monthlyRate === 0) return Math.ceil(newPrincipalCents / paymentCents);

  const coverage = 1 - (newPrincipalCents * monthlyRate) / paymentCents;
  if (coverage <= 0) {
    throw new PrepayError('the instalment does not cover the interest on the remaining principal; check the rate or the payment');
  }
  return Math.ceil(-Math.log(coverage) / Math.log(1 + monthlyRate));
}

function impliedReturn(flows) {
  if (!flows.some((flow) => flow > 0)) return null;
  try {
    const monthly = monthlyIrr(flows);
    return {
      monthlyRate: monthly,
      nominalApr: annualizeNominal(monthly),
      effectiveApr: annualizeEffective(monthly),
    };
  } catch {
    return null;
  }
}

/** Undiscounted payback: how many periods until the saved cash covers what was paid. */
function payback(upfrontCents, perPeriodCents, startPeriod = 0) {
  if (!Number.isFinite(perPeriodCents) || perPeriodCents <= 0) return null;
  return startPeriod + Math.ceil(upfrontCents / perPeriodCents);
}

function buildComparison({ compareYield, reduceTerm, reducePayment }) {
  const pick = (option) => {
    if (option.impliedReturn === null) return { verdict: 'unknown', gapPoints: null };
    // The prepayment "beats" an investment when its implied return is higher.
    const gap = option.impliedReturn.nominalApr - compareYield;
    return { verdict: gap > 0 ? 'prepay-wins' : 'invest-wins', gapPoints: gap };
  };
  return {
    compareYield,
    reduceTerm: pick(reduceTerm),
    reducePayment: pick(reducePayment),
    // The footer already carries the caveats; keep this line to the comparison only.
    note: `比较基准 ${pctOf(compareYield)}% 是理财的名义年化。`,
  };
}
