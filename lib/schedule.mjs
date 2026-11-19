/**
 * Amortisation schedules.
 *
 * Four repayment shapes, one invariant: the principal parts must sum to the
 * principal exactly and the closing balance must be zero. Every rounding
 * difference is absorbed by the *last* period, never smeared across the table —
 * a schedule whose last row is 3 fen off is indistinguishable from a bank error,
 * and this plugin exists to tell those two apart.
 *
 * The interest clock is deliberate per method (see docs/adr and README):
 *   equal-installment / equal-principal / balloon → monthly rate (annual / 12)
 *   interest-only                                 → daily rate (basis required)
 * Mixing the two is the single most common way a recomputation disagrees with a
 * bank's table, so the choice is explicit and echoed in `convention`.
 */
import { roundHalfUp } from './money.mjs';
import { BASES, accrualCents, addMonths, dayCount, parseBasis } from './daycount.mjs';

export class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export const METHODS = Object.freeze({
  'equal-installment': '等额本息',
  'equal-principal': '等额本金',
  'interest-only': '先息后本',
  balloon: '气球贷',
});

export const METHOD_IDS = Object.freeze(Object.keys(METHODS));

/** Accepts the id, the Chinese name, or a couple of common aliases. */
export function normalizeMethod(input) {
  if (input === undefined || input === null || input === '') return 'equal-installment';
  const raw = String(input).trim();
  const lower = raw.toLowerCase();
  if (METHOD_IDS.includes(lower)) return lower;
  const byLabel = Object.entries(METHODS).find(([, label]) => label === raw);
  if (byLabel !== undefined) return byLabel[0];
  const aliases = {
    等额本息: 'equal-installment',
    等额本金: 'equal-principal',
    先息后本: 'interest-only',
    气球: 'balloon',
    气球贷: 'balloon',
    bullet: 'interest-only',
    'interest only': 'interest-only',
    annuity: 'equal-installment',
  };
  const alias = aliases[lower] ?? aliases[raw];
  if (alias !== undefined) return alias;
  throw new ScheduleError(`unknown method "${input}"; expected one of ${METHOD_IDS.join(', ')}`);
}

/** The fixed instalment that amortises `principal` over `periods` at monthly rate `r`. */
export function levelPayment(principalCents, monthlyRate, periods) {
  if (monthlyRate === 0) return roundHalfUp(principalCents / periods, 0);
  const growth = (1 + monthlyRate) ** periods;
  return roundHalfUp((principalCents * monthlyRate * growth) / (growth - 1), 0);
}

function validate(options) {
  const {
    principalCents, annualRate, periods, method, startDate, basis,
  } = options;

  if (!Number.isSafeInteger(principalCents) || principalCents <= 0) {
    throw new ScheduleError('principalCents must be a positive integer number of fen');
  }
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 1) {
    throw new ScheduleError('annualRate must be a ratio between 0 and 1 (3.5% → 0.035)');
  }
  if (!Number.isInteger(periods) || periods < 1 || periods > 600) {
    throw new ScheduleError('periods must be an integer between 1 and 600');
  }
  if (startDate !== null && startDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
    throw new ScheduleError('startDate must be YYYY-MM-DD');
  }
  if (method === 'interest-only') {
    if (basis === null || basis === undefined) {
      throw new ScheduleError(
        'interest-only accrues daily, so basis is required (ACT/365, ACT/360 or 30/360) — it changes the answer',
      );
    }
    if (startDate === null || startDate === undefined) {
      throw new ScheduleError('interest-only needs startDate to count the days in each period');
    }
  }
  if (basis !== null && basis !== undefined) parseBasis(basis);
}

/**
 * Build the table.
 *
 * @returns `{ rows, totals, convention, paymentCents, warnings }` where every
 *          row is `{ period, dueDate, paymentCents, interestCents, principalCents, balanceCents }`.
 */
export function buildSchedule(options = {}) {
  const {
    principalCents,
    annualRate,
    periods,
    startDate = null,
    basis = null,
    balloonOver = null,
  } = options;
  const method = normalizeMethod(options.method);

  if (balloonOver !== null && balloonOver !== undefined) {
    if (!Number.isInteger(balloonOver) || balloonOver < periods || balloonOver > 600) {
      throw new ScheduleError('balloonOver must be an integer ≥ periods and ≤ 600');
    }
  }

  validate({
    principalCents, annualRate, periods, method, startDate, basis,
  });

  if (options.paymentCents !== undefined && options.paymentCents !== null) {
    if (method !== 'equal-installment') {
      throw new ScheduleError('paymentCents is only supported for equal-installment schedules');
    }
    if (!Number.isSafeInteger(options.paymentCents) || options.paymentCents <= 0) {
      throw new ScheduleError('paymentCents must be a positive integer number of fen');
    }
  }

  const daily = method === 'interest-only';
  const monthlyRate = annualRate / 12;
  const warnings = [];

  if (!daily && basis !== null && basis !== undefined) {
    warnings.push(`basis ${parseBasis(basis)} 已收到但不参与计算：${METHODS[method]} 按月利率（年利率/12）计息。`);
  }

  // The fixed payment, for the shapes that have one.
  let fixedPayment = null;
  if (method === 'equal-installment') {
    fixedPayment = options.paymentCents ?? levelPayment(principalCents, monthlyRate, periods);
  } else if (method === 'balloon') {
    fixedPayment = levelPayment(principalCents, monthlyRate, balloonOver ?? periods);
  } else if (method === 'equal-principal') {
    fixedPayment = roundHalfUp(principalCents / periods, 0);
  }

  const rows = [];
  let balance = principalCents;
  let previousDate = startDate;
  let totalInterest = 0;
  let totalPrincipal = 0;
  let totalPayment = 0;

  for (let period = 1; period <= periods; period += 1) {
    const dueDate = startDate === null || startDate === undefined ? null : addMonths(startDate, period);

    let interest;
    if (daily) {
      const days = dayCount(previousDate, dueDate, basis);
      if (days <= 0) throw new ScheduleError(`period ${period} spans ${days} days; check startDate`);
      interest = accrualCents(balance, annualRate, days, basis);
    } else {
      interest = roundHalfUp(balance * monthlyRate, 0);
    }

    const isLast = period === periods;
    let principalPart;
    let payment;

    if (method === 'equal-installment') {
      if (isLast) {
        principalPart = balance;
        payment = balance + interest;
      } else {
        principalPart = fixedPayment - interest;
        payment = fixedPayment;
      }
    } else if (method === 'equal-principal') {
      principalPart = isLast ? balance : Math.min(fixedPayment, balance);
      payment = principalPart + interest;
    } else if (method === 'interest-only') {
      principalPart = isLast ? balance : 0;
      payment = principalPart + interest;
    } else {
      // balloon: pay the long-amortisation instalment, settle the rest at maturity
      if (isLast) {
        principalPart = balance;
        payment = balance + interest;
      } else {
        principalPart = fixedPayment - interest;
        payment = fixedPayment;
      }
    }

    if (principalPart < 0) {
      throw new ScheduleError(
        `period ${period}: payment ${payment} does not cover interest ${interest} — the balance would grow`,
      );
    }
    if (principalPart > balance) throw new ScheduleError(`period ${period}: principal exceeds the outstanding balance`);
    if (principalPart === 0 && !isLast && method !== 'interest-only') {
      throw new ScheduleError(`period ${period}: payment covers only interest; this method would never amortise`);
    }

    balance -= principalPart;
    totalInterest += interest;
    totalPrincipal += principalPart;
    totalPayment += payment;

    rows.push({
      period,
      dueDate,
      paymentCents: payment,
      interestCents: interest,
      principalCents: principalPart,
      balanceCents: balance,
    });

    if (dueDate !== null) previousDate = dueDate;
  }

  if (balance !== 0) throw new ScheduleError(`schedule did not close: ${balance} fen left`);

  // Rounding lives in exactly one place: the final instalment. Only the shapes
  // with a *fixed* payment can show that as a difference; for equal-principal and
  // interest-only every period differs by design, so a warning would be noise.
  const fixedPaymentMethod = method === 'equal-installment' || method === 'balloon';
  const regular = rows[0].paymentCents;
  const last = rows[rows.length - 1];
  if (fixedPaymentMethod && rows.length > 1 && last.paymentCents !== regular) {
    warnings.push(
      `末期还款 ${(last.paymentCents / 100).toFixed(2)} 元与常规 ${(regular / 100).toFixed(2)} 元不同，用于吸收逐期舍入差额。`,
    );
  }

  return {
    method,
    methodLabel: METHODS[method],
    periods,
    rows,
    paymentCents: daily ? null : fixedPayment,
    convention: {
      interestClock: daily ? 'daily' : 'monthly',
      monthlyRate: daily ? null : monthlyRate,
      basis: daily ? parseBasis(basis) : null,
      basisLabel: daily ? BASES[parseBasis(basis)].label : null,
      balloonOver: method === 'balloon' ? (balloonOver ?? periods) : null,
    },
    totals: {
      principalCents,
      interestCents: totalInterest,
      paymentCents: totalPayment,
    },
    warnings,
  };
}
