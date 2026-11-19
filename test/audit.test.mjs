import test from 'node:test';
import assert from 'node:assert/strict';

import { auditSchedule } from '../lib/audit.mjs';
import { buildSchedule } from '../lib/schedule.mjs';

const CONTRACT = Object.freeze({
  principalCents: 100_000_000,
  annualRate: 0.035,
  periods: 360,
  method: 'equal-installment',
  startDate: null,
  basis: null,
});

const recordsOf = (schedule) => schedule.rows.map((row) => ({
  period: row.period,
  paymentCents: row.paymentCents,
  interestCents: row.interestCents,
  principalCents: row.principalCents,
  balanceCents: row.balanceCents,
}));

test('a table produced by our own engine audits clean', () => {
  const schedule = buildSchedule(CONTRACT);
  const audit = auditSchedule({ records: recordsOf(schedule), contract: CONTRACT });
  assert.equal(audit.verdict, 'match');
  assert.equal(audit.cause, null);
  assert.equal(audit.firstDiffPeriod, null);
  assert.equal(audit.totals.interestDiffCents, 0);
  assert.equal(audit.rows.length, 360);
});

test('a 365/360 basis error is attributed to the day count, not to the rate', () => {
  const schedule = buildSchedule(CONTRACT);
  const inflated = schedule.rows.map((row) => {
    const interestCents = Math.round(row.interestCents * (365 / 360));
    return {
      period: row.period,
      interestCents,
      principalCents: row.principalCents,
      paymentCents: row.principalCents + interestCents,
      balanceCents: row.balanceCents,
    };
  });

  const audit = auditSchedule({ records: inflated, contract: CONTRACT });
  assert.equal(audit.verdict, 'mismatch');
  assert.equal(audit.cause.code, 'dayCount');
  assert.ok(audit.totals.interestDiffCents > 0, 'the bank charged more');
  assert.ok(audit.firstDiffPeriod >= 1);
});

test('a wrong rate is attributed to the rate', () => {
  const atFourPercent = buildSchedule({ ...CONTRACT, annualRate: 0.04 });
  const audit = auditSchedule({ records: recordsOf(atFourPercent), contract: CONTRACT });
  assert.equal(audit.verdict, 'mismatch');
  assert.equal(audit.cause.code, 'rate');
  assert.match(audit.cause.detail, /3\.5/);
  assert.match(audit.cause.detail, /4\.0/);
});

test('missing periods make the verdict incomplete instead of a false match', () => {
  const schedule = buildSchedule({ ...CONTRACT, periods: 12 });
  const audit = auditSchedule({
    records: recordsOf(schedule).slice(0, 8),
    contract: { ...CONTRACT, periods: 12 },
  });
  assert.equal(audit.verdict, 'incomplete');
  assert.ok(audit.warnings.some((warning) => /缺少 4 期/.test(warning)));
});

test('an inconsistent principal total is reported even when rows look plausible', () => {
  const schedule = buildSchedule({ ...CONTRACT, periods: 12 });
  const records = recordsOf(schedule).map((record) => ({ ...record, principalCents: Math.round(record.principalCents * 0.99) }));
  const audit = auditSchedule({ records, contract: { ...CONTRACT, periods: 12 } });
  assert.ok(audit.warnings.some((warning) => /本金合计/.test(warning)));
});

test('a schedule that does not close is flagged', () => {
  const schedule = buildSchedule({ ...CONTRACT, periods: 12 });
  const records = recordsOf(schedule);
  records[records.length - 1].balanceCents = 12_345;
  const audit = auditSchedule({ records, contract: { ...CONTRACT, periods: 12 } });
  assert.ok(audit.warnings.some((warning) => /未结清/.test(warning)));
});

test('duplicate periods are reported, last one wins', () => {
  const schedule = buildSchedule({ ...CONTRACT, periods: 3 });
  const records = [...recordsOf(schedule), { ...recordsOf(schedule)[0], interestCents: 1 }];
  const audit = auditSchedule({ records, contract: { ...CONTRACT, periods: 3 } });
  assert.ok(audit.warnings.some((warning) => /出现多次/.test(warning)));
});
