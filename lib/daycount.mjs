/**
 * Day-count conventions.
 *
 * A loan has two different clocks and mixing them is the classic source of
 * "the bank charged 3 fen more than my spreadsheet":
 *
 *   - Amortising loans (等额本息/等额本金) run on a *monthly* clock: the rate is
 *     annual/12 and the number of days in the month is irrelevant.
 *   - Interest-only loans, overdue penalties and split periods run on a *daily*
 *     clock: interest = balance × annualRate × days / denominator, and the
 *     denominator (360 or 365) is a contractual term, not a detail.
 *
 * This module owns the second clock. Nothing here guesses a convention: every
 * function takes the basis explicitly, and an unknown basis is an error rather
 * than a default.
 */

import { roundHalfUp } from './money.mjs';

export class DayCountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DayCountError';
  }
}

/** The three conventions this plugin supports. */
export const BASES = Object.freeze({
  'ACT/365': { id: 'ACT/365', kind: 'actual', denominator: 365, label: '实际天数 / 365' },
  'ACT/360': { id: 'ACT/360', kind: 'actual', denominator: 360, label: '实际天数 / 360（人民币贷款惯例）' },
  '30/360': { id: '30/360', kind: 'thirty', denominator: 360, label: '30/360（US，每月按 30 天）' },
});

export const BASIS_IDS = Object.freeze(Object.keys(BASES));

/** `'act/365'`, `'ACT_360'`, `'实际/360'` → the canonical id. Unknown → throw. */
export function parseBasis(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new DayCountError(`basis is required, one of ${BASIS_IDS.join(', ')}`);
  }
  const normalized = input.trim().toUpperCase().replace(/\s+/g, '').replace(/_/g, '/');
  const aliases = {
    'ACT/365': 'ACT/365',
    'ACTUAL/365': 'ACT/365',
    '实际/365': 'ACT/365',
    'ACT/360': 'ACT/360',
    'ACTUAL/360': 'ACT/360',
    '实际/360': 'ACT/360',
    '30/360': '30/360',
    '30/360US': '30/360',
    '30E/360': '30/360',
  };
  const id = aliases[normalized];
  if (id === undefined) {
    throw new DayCountError(`unknown basis "${input}"; expected one of ${BASIS_IDS.join(', ')}`);
  }
  return id;
}

/** `YYYY-MM-DD` → UTC day number, so arithmetic never drifts across time zones. */
export function toUtcDay(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new DayCountError(`expected a YYYY-MM-DD date, got ${String(iso)}`);
  }
  const [year, month, day] = iso.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new DayCountError(`not a real date: ${iso}`);
  }
  return Math.round(utc / 86_400_000);
}

/** Day number → `YYYY-MM-DD`. */
export function fromUtcDay(dayNumber) {
  if (!Number.isInteger(dayNumber)) throw new DayCountError('fromUtcDay: expected an integer day number');
  return new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);
}

function isLastDayOfFebruary(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  if (month !== 2) return false;
  return day === new Date(Date.UTC(year, 2, 0)).getUTCDate();
}

/** Calendar days between two dates (end − start). Negative if reversed. */
export function actualDays(start, end) {
  return toUtcDay(end) - toUtcDay(start);
}

/**
 * 30/360 (US/NASD): every month counts as 30 days.
 *
 * Month-end is where the conventions diverge, so this is the only branch worth
 * writing down: a 31st becomes the 30th; a February month-end becomes the 30th
 * when the other end is also a February month-end.
 */
export function thirty360Days(start, end) {
  let [y1, m1, d1] = start.split('-').map(Number);
  let [y2, m2, d2] = end.split('-').map(Number);

  // February month-ends count as the 30th; only then do the 31st rules apply.
  if (isLastDayOfFebruary(start)) d1 = 30;
  if (isLastDayOfFebruary(end)) d2 = 30;
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;

  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

/** Days between two dates under a convention. Unknown basis throws. */
export function dayCount(start, end, basis) {
  const id = parseBasis(basis);
  const spec = BASES[id];
  return spec.kind === 'thirty' ? thirty360Days(start, end) : actualDays(start, end);
}

/** `YYYY-MM-DD` + n calendar months, clamping to the last day of the target month. */
export function addMonths(iso, months) {
  if (!Number.isInteger(months)) throw new DayCountError('addMonths: months must be an integer');
  const [year, month, day] = iso.split('-').map(Number);
  const total = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = total - nextYear * 12; // 0-based
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  const nextDay = Math.min(day, lastDay);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(nextYear, 4)}-${pad(nextMonth + 1)}-${pad(nextDay)}`;
}

/**
 * Interest for one period on a daily clock, in integer cents.
 *
 * `balance × rate × days / denominator`, rounded once. Kept separate from the
 * schedule so the same formula serves penalties and split periods later.
 */
export function accrualCents(balanceCents, annualRate, days, basis) {
  if (!Number.isFinite(balanceCents) || balanceCents < 0) {
    throw new DayCountError('accrualCents: balance must be a non-negative number of cents');
  }
  if (!Number.isFinite(annualRate) || annualRate < 0) {
    throw new DayCountError('accrualCents: rate must be a non-negative number');
  }
  if (!Number.isInteger(days) || days <= 0) {
    throw new DayCountError('accrualCents: days must be a positive integer');
  }
  const id = parseBasis(basis);
  const denominator = BASES[id].denominator;
  return roundHalfUp((balanceCents * annualRate * days) / denominator, 0);
}
