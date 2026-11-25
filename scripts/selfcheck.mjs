#!/usr/bin/env node
/**
 * Randomised invariant checks — the things a fixed test suite can miss.
 *
 * The suite pins known answers; this hammers the same functions with a few
 * hundred generated contracts and asserts the invariants that must hold for any
 * input: principal parts sum to the principal, the schedule closes, every row
 * balances, and no cell is parsed into a number it does not represent.
 *
 * Deterministic (fixed seed), offline, and fast enough for CI.
 */
import { buildSchedule } from '../lib/schedule.mjs';
import { auditSchedule } from '../lib/audit.mjs';
import { planPrepayment } from '../lib/prepay.mjs';
import { compareOffers } from '../lib/compare.mjs';
import { resetRate } from '../lib/lpr.mjs';
import { parseDateCell, parseMoneyCell, scoreHeaderRow } from '../lib/csv.mjs';

let failures = 0;
const fail = (label, detail) => {
  failures += 1;
  console.log(`FAIL ${label}: ${detail}`);
};

// A small LCG keeps this reproducible across machines and runs.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (values) => values[Math.floor(rnd() * values.length)];
const intBetween = (low, high) => low + Math.floor(rnd() * (high - low + 1));

// --- schedules: invariants must hold for every contract ---------------------
const methods = ['equal-installment', 'equal-principal', 'interest-only', 'balloon'];
let built = 0;
for (let i = 0; i < 400; i += 1) {
  const method = pick(methods);
  const principalCents = intBetween(1, 500_000_000);
  const annualRate = pick([0, 0.0001, 0.035, 0.049, 0.12, 0.24, 0.36]);
  const periods = intBetween(1, 360);
  try {
    const schedule = buildSchedule({
      principalCents,
      annualRate,
      periods,
      method,
      startDate: method === 'interest-only' || rnd() < 0.5 ? '2024-01-31' : null,
      basis: method === 'interest-only' ? pick(['ACT/360', 'ACT/365', '30/360']) : null,
      balloonOver: method === 'balloon' ? intBetween(periods, 600) : null,
    });
    built += 1;
    const sum = schedule.rows.reduce((total, row) => total + row.principalCents, 0);
    if (sum !== principalCents) fail('principal-sum', `${method} P=${principalCents} n=${periods} sum=${sum}`);
    if (schedule.rows.at(-1).balanceCents !== 0) fail('not-closed', `${method} balance=${schedule.rows.at(-1).balanceCents}`);
    for (const row of schedule.rows) {
      if (row.paymentCents !== row.principalCents + row.interestCents) fail('row-balance', `${method} period ${row.period}`);
      if (row.principalCents < 0 || row.balanceCents < 0) fail('negative', `${method} period ${row.period}`);
    }
  } catch (error) {
    // An unpayable combination (payment below interest) is a legitimate refusal.
    if (error.name !== 'ScheduleError') fail('unexpected-throw', `${method}: ${error.message}`);
  }
}
console.log(`schedules: ${built}/400 built, invariants ${built === 0 ? 'not checked' : 'checked'}`);

// --- attribution: the same +1.4% gap means different things per clock -------
const level = { principalCents: 100_000_000, annualRate: 0.035, periods: 240, method: 'equal-installment', startDate: null, basis: null };
const rateShift = buildSchedule({ ...level, annualRate: 0.0355 });
const rateAudit = auditSchedule({
  records: rateShift.rows.map((row) => ({ period: row.period, paymentCents: row.paymentCents, interestCents: row.interestCents, principalCents: row.principalCents, balanceCents: row.balanceCents })),
  contract: level,
});
if (rateAudit.cause?.code !== 'rate') fail('attribution-rate', `got ${rateAudit.cause?.code}`);

const daily = { principalCents: 100_000_000, annualRate: 0.04, periods: 12, method: 'interest-only', startDate: '2026-01-01', basis: 'ACT/360' };
const dailySchedule = buildSchedule(daily);
const dailyAudit = auditSchedule({
  records: dailySchedule.rows.map((row) => {
    const interestCents = Math.round(row.interestCents * (365 / 360));
    return { period: row.period, interestCents, principalCents: row.principalCents, paymentCents: row.principalCents + interestCents, balanceCents: row.balanceCents };
  }),
  contract: daily,
});
if (dailyAudit.cause?.code !== 'dayCount') fail('attribution-daycount', `got ${dailyAudit.cause?.code}`);

// --- parsers must refuse, not guess ---------------------------------------
for (const ambiguous of ['1,2,3', '1.234,56', '12,34.5', '1.2.3', '12e3']) {
  if (parseMoneyCell(ambiguous) !== null) fail('money-ambiguous', `"${ambiguous}" was parsed instead of refused`);
}
if (parseMoneyCell('1,234.56') !== 123456) fail('money-valid', 'plain thousands failed');
if (parseDateCell('46082.5') !== '2026-03-01') fail('date-serial', 'datetime serial failed');
if (scoreHeaderRow(['序号', '期数', '本金', '利息']).mapping.period !== 1) fail('header-period', 'row counter won over 期数');

// --- the other three calculators must at least behave at the edges ---------
try {
  const prepay = planPrepayment({ remainingPrincipalCents: 100_000_000, annualRate: 0, remainingPeriods: 12, prepayCents: 10_000_000 });
  if (prepay.reduceTerm.savedInterestCents !== 0) fail('prepay-zero-rate', 'saved interest at 0% should be 0');
} catch (error) {
  fail('prepay-zero-rate-throw', error.message);
}
try {
  compareOffers({ offers: [{ principalCents: 100, periods: 1, paymentCents: 100 }, { principalCents: 100, periods: 1, paymentCents: 101 }] });
} catch (error) {
  fail('compare-minimal', error.message);
}
try {
  resetRate({ remainingPrincipalCents: 100_000_000, remainingPeriods: 240, spreadBp: 55, newLpr: 1e-9 });
} catch (error) {
  fail('lpr-zero', error.message);
}

console.log(failures === 0 ? 'selfcheck: OK' : `selfcheck: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
