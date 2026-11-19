/**
 * Audit a bank's repayment schedule against our own recomputation.
 *
 * The output is not "here are two tables" — it is a verdict plus the single most
 * likely reason they differ. Attribution is heuristic, and says so: a wrong cause
 * with a confident tone is worse than "未解释".
 */
import { monthlyIrr, annualizeNominal } from './irr.mjs';
import { buildSchedule } from './schedule.mjs';

export class AuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditError';
  }
}

const ABS_TOLERANCE_CENTS = 1; // a fen of rounding is not a finding

function sum(values) {
  return values.reduce((total, value) => total + (value ?? 0), 0);
}

/**
 * @param records   Parsed rows from csv.mjs (`period`, `*Cents`, optional `dueDate`).
 * @param contract  { principalCents, annualRate, periods, method, startDate, basis }
 */
export function auditSchedule({ records, contract }) {
  if (!Array.isArray(records) || records.length === 0) throw new AuditError('no rows to audit');
  const expected = buildSchedule(contract);
  const warnings = [...expected.warnings];

  const actualByPeriod = new Map();
  for (const record of records) {
    if (actualByPeriod.has(record.period)) warnings.push(`期次 ${record.period} 在文件中出现多次，取最后一行`);
    actualByPeriod.set(record.period, record);
  }

  const maxPeriod = Math.max(expected.rows.length, ...records.map((record) => record.period));
  const rows = [];
  for (let period = 1; period <= maxPeriod; period += 1) {
    const expectedRow = expected.rows[period - 1] ?? null;
    const actualRow = actualByPeriod.get(period) ?? null;
    rows.push({
      period,
      dueDate: actualRow?.dueDate ?? expectedRow?.dueDate ?? null,
      expected: expectedRow === null ? null : {
        paymentCents: expectedRow.paymentCents,
        interestCents: expectedRow.interestCents,
        principalCents: expectedRow.principalCents,
        balanceCents: expectedRow.balanceCents,
      },
      actual: actualRow === null ? null : {
        paymentCents: actualRow.paymentCents ?? null,
        interestCents: actualRow.interestCents ?? null,
        principalCents: actualRow.principalCents ?? null,
        balanceCents: actualRow.balanceCents ?? null,
      },
      diff: {
        interestCents: actualRow?.interestCents != null && expectedRow !== null
          ? actualRow.interestCents - expectedRow.interestCents : null,
        principalCents: actualRow?.principalCents != null && expectedRow !== null
          ? actualRow.principalCents - expectedRow.principalCents : null,
        paymentCents: actualRow?.paymentCents != null && expectedRow !== null
          ? actualRow.paymentCents - expectedRow.paymentCents : null,
      },
    });
  }

  const missing = rows.filter((row) => row.actual === null).length;
  const extra = rows.filter((row) => row.expected === null).length;
  if (missing > 0) warnings.push(`文件缺少 ${missing} 期`);
  if (extra > 0) warnings.push(`文件多出 ${extra} 期（超出合同期数）`);

  const comparable = rows.filter((row) => row.diff.interestCents !== null || row.diff.paymentCents !== null);
  const totalInterestDiff = sum(comparable.map((row) => row.diff.interestCents));
  const totalPrincipalDiff = sum(comparable.map((row) => row.diff.principalCents));
  const totalPaymentDiff = sum(comparable.map((row) => row.diff.paymentCents));

  const maxAbsInterest = Math.max(0, ...comparable.map((row) => Math.abs(row.diff.interestCents ?? 0)));
  const maxAbsPayment = Math.max(0, ...comparable.map((row) => Math.abs(row.diff.paymentCents ?? 0)));
  const firstDiff = comparable.find((row) => Math.abs(row.diff.interestCents ?? 0) > ABS_TOLERANCE_CENTS
    || Math.abs(row.diff.paymentCents ?? 0) > ABS_TOLERANCE_CENTS)?.period ?? null;

  // Invariants: an interior mistake shows up here even when every row "looks fine".
  const actualPrincipalSum = sum(records.map((record) => record.principalCents).filter((value) => value != null));
  if (actualPrincipalSum !== 0 && Math.abs(actualPrincipalSum - contract.principalCents) > 100) {
    warnings.push(
      `文件本金合计 ${(actualPrincipalSum / 100).toFixed(2)} 元，与合同本金 ${(contract.principalCents / 100).toFixed(2)} 元相差 ${(Math.abs(actualPrincipalSum - contract.principalCents) / 100).toFixed(2)} 元`,
    );
  }
  const lastActual = [...records].sort((a, b) => a.period - b.period).at(-1);
  if (lastActual?.balanceCents != null && lastActual.balanceCents !== 0) {
    warnings.push(`文件末期余额为 ${(lastActual.balanceCents / 100).toFixed(2)} 元，未结清`);
  }

  let verdict = 'match';
  if (missing > 0 || extra > 0) verdict = 'incomplete';
  else if (maxAbsInterest > ABS_TOLERANCE_CENTS || maxAbsPayment > ABS_TOLERANCE_CENTS) verdict = 'mismatch';

  const cause = verdict === 'mismatch' ? attribute({ records, contract, expected, totalInterestDiff, maxAbsInterest }) : null;

  return {
    rows,
    totals: {
      expectedInterestCents: expected.totals.interestCents,
      actualInterestCents: sum(records.map((record) => record.interestCents).filter((value) => value != null)),
      interestDiffCents: totalInterestDiff,
      principalDiffCents: totalPrincipalDiff,
      paymentDiffCents: totalPaymentDiff,
      maxAbsInterestCents: maxAbsInterest,
      maxAbsPaymentCents: maxAbsPayment,
    },
    verdict,
    cause,
    firstDiffPeriod: firstDiff,
    warnings,
  };
}

/**
 * Guess why the tables disagree, cheapest hypothesis first.
 *
 *   1. A different rate would shift every payment — check the implied IRR.
 *   2. A different day-count would shift interest only, by a near-constant ratio
 *      (365/360 is +1.39%, and that number is a recognisable signature).
 *   3. Otherwise: rounding, or honestly unknown.
 */
function attribute({ records, contract, expected, totalInterestDiff, maxAbsInterest }) {
  // A day-count change leaves a *signature* ratio (365/360 = +1.39%); a rate
  // change does not land on it by accident. Check the signature first, otherwise
  // a basis error would be reported as "wrong rate" — true but less actionable.
  const expectedInterest = expected.totals.interestCents;
  const interestDeviation = expectedInterest > 0 ? totalInterestDiff / expectedInterest : null;
  const ratio = 365 / 360 - 1;

  if (interestDeviation !== null) {
    const nearRatio = Math.abs(Math.abs(interestDeviation) - ratio) < 0.0015;
    if (nearRatio) {
      return {
        code: 'dayCount',
        title: '计息基准或天数口径不同',
        detail: `文件利息合计比按合同重算的${interestDeviation > 0 ? '多' : '少'} ${(Math.abs(interestDeviation) * 100).toFixed(2)}%，恰好接近 365/360 = +1.39% 的特征比值；请核对合同约定的计息基准（ACT/360、ACT/365、30/360）。`,
        confidence: 'medium',
      };
    }
  }

  const payments = records
    .filter((record) => typeof record.paymentCents === 'number' && record.paymentCents > 0)
    .sort((a, b) => a.period - b.period)
    .map((record) => record.paymentCents);

  if (payments.length === records.length && payments.length > 1) {
    try {
      const flows = [-contract.principalCents, ...payments];
      const impliedNominal = annualizeNominal(monthlyIrr(flows));
      const delta = impliedNominal - contract.annualRate;
      if (Math.abs(delta) > 1e-4) {
        return {
          code: 'rate',
          title: '利率不一致',
          detail: `按文件现金流反解的单利年化为 ${(impliedNominal * 100).toFixed(4)}%，合同为 ${(contract.annualRate * 100).toFixed(4)}%，差 ${(delta * 100).toFixed(4)} 个百分点。`,
          confidence: 'high',
        };
      }
    } catch { /* not enough signal, fall through */ }
  }

  if (interestDeviation !== null && Math.abs(interestDeviation) > 0.002 && Math.abs(interestDeviation) < 0.05) {
    return {
      code: 'dayCount',
      title: '计息基准或天数口径不同',
      detail: `文件利息合计比按合同重算的${interestDeviation > 0 ? '多' : '少'} ${(Math.abs(interestDeviation) * 100).toFixed(2)}%，但比值不对应常见的 365/360 特征，需人工核对计息天数。`,
      confidence: 'low',
    };
  }

  if (maxAbsInterest <= 2) {
    return {
      code: 'rounding',
      title: '逐期舍入差异',
      detail: '每期差异不超过 2 分，累计差异来自四舍五入与末期尾差处理方式。',
      confidence: 'medium',
    };
  }

  return {
    code: 'unknown',
    title: '未解释',
    detail: '无法用利率、计息基准或舍入解释这份差异，建议人工核对合同条款与原表。',
    confidence: 'none',
  };
}
