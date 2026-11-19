import test from 'node:test';
import assert from 'node:assert/strict';

import { createTools } from '../lib/tools.mjs';
import { buildSchedule } from '../lib/schedule.mjs';

const byName = (name) => createTools().find((tool) => tool.name === name);

/** Serialise a schedule into the messy shape a bank export actually has. */
function scheduleCsv(contract, { titleRows = true } = {}) {
  const schedule = buildSchedule(contract);
  const body = schedule.rows.map((row) => [
    row.period,
    row.dueDate ?? '2026-02-15',
    (row.principalCents / 100).toFixed(2),
    (row.interestCents / 100).toFixed(2),
    (row.paymentCents / 100).toFixed(2),
    (row.balanceCents / 100).toFixed(2),
  ].join(','));
  const header = '期次,还款日,应还本金,应还利息,应还本息合计,剩余本金';
  if (!titleRows) return [header, ...body].join('\n');
  return ['个人住房贷款还款计划表', '借款人：张**  合同号：2024-0317', '', header, ...body].join('\n');
}

const SMALL = Object.freeze({
  principalCents: 1_000_000,
  annualRate: 0.04,
  periods: 12,
  method: 'equal-installment',
  startDate: '2026-01-15',
  basis: null,
});

test('registers exactly the six implemented tools, shaped the way the host expects', () => {
  const tools = createTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['real_apr', 'loan_schedule', 'loan_audit', 'prepay_audit', 'apr_compare', 'lpr_reset']);
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(Array.isArray(tool.parameters.required));
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.presentCall, 'function');
    assert.equal(typeof tool.output.render, 'function');
  }
});

test('real_apr still answers the card-installment case', async () => {
  const result = await byName('real_apr').execute({ principal: 10000, periods: 12, monthlyFeeRate: 0.6 });
  assert.equal(result.data.mode, 'feeRate');
  assert.ok(Math.abs(result.data.nominalApr - 0.13033513868723678) < 1e-9);
  // ADR 0002: the headline is the compounded rate, the one the PBOC requires.
  assert.match(result.markdown, /\*\*复利年化 13\.84%\*\*（IRR，监管口径）/);
  assert.match(result.markdown, /单利年化（月 IRR × 12） \| 13\.03%/);
  assert.match(result.markdown, /6\.64 个百分点/);
  assert.match(result.markdown, /中国人民银行公告〔2021〕第 3 号/);
});

test('real_apr rejects ambiguous input', async () => {
  await assert.rejects(() => byName('real_apr').execute({ principal: 10000, periods: 12 }), /exactly one/);
});

test('loan_schedule builds the full table and prints a trimmed one', async () => {
  const result = await byName('loan_schedule').execute({
    principal: 1000000,
    annualRate: 3.5,
    periods: 360,
    startDate: '2026-01-15',
  });
  assert.equal(result.data.rows.length, 360);
  assert.equal(result.data.method, 'equal-installment');
  assert.equal(result.data.methodLabel, '等额本息');
  assert.equal(result.data.convention.interestClock, 'monthly');
  assert.ok(Math.abs(result.data.irr.nominalApr - 0.035) < 5e-4);
  assert.equal(result.data.rows.at(-1).balanceCents, 0);

  assert.match(result.markdown, /等额本息 · 360 期/);
  assert.match(result.markdown, /每期还款 ¥4,490\.4\d/);
  assert.match(result.markdown, /共 360 期，隐藏 352 期/);
  // The transcript must stay readable: not all 360 rows are printed.
  assert.ok(result.markdown.split('\n').length < 25, 'trimmed table should stay compact');
});

test('loan_schedule honours a Chinese method name and a custom row count', async () => {
  const result = await byName('loan_schedule').execute({
    principal: 240000,
    annualRate: 4.2,
    periods: 24,
    method: '等额本金',
    rows: 60,
  });
  assert.equal(result.data.method, 'equal-principal');
  assert.match(result.markdown, /等额本金/);
  assert.ok(result.markdown.split('\n').length > 20, 'rows:60 should print every period');
});

test('loan_schedule drives the daily clock through the basis argument', async () => {
  const result = await byName('loan_schedule').execute({
    principal: 100000,
    annualRate: 6,
    periods: 12,
    method: 'interest-only',
    startDate: '2026-01-01',
    basis: 'ACT/360',
    rows: 3,
  });
  assert.equal(result.data.convention.interestClock, 'daily');
  assert.equal(result.data.convention.basis, 'ACT/360');
  assert.match(result.markdown, /按日计息/);
  assert.equal(result.data.rows[0].interestCents, 51667); // ¥100,000 × 6% × 31/360 = ¥516.67

  await assert.rejects(
    () => byName('loan_schedule').execute({ principal: 100000, annualRate: 6, periods: 12, method: 'interest-only', startDate: '2026-01-01' }),
    /basis is required/,
  );
});

test('loan_schedule validates its own inputs', async () => {
  await assert.rejects(
    () => byName('loan_schedule').execute({ principal: 100000, annualRate: 150, periods: 12 }),
    /percentage/,
  );
  await assert.rejects(
    () => byName('loan_schedule').execute({ principal: 100000, annualRate: 6, periods: 12, method: '先还利息' }),
    /unknown method/,
  );
  await assert.rejects(
    () => byName('loan_schedule').execute({ principal: 100000, annualRate: 6, periods: 12.5 }),
    /integer/,
  );
});

test('loan_audit reads a messy CSV and confirms a clean statement', async () => {
  const result = await byName('loan_audit').execute({
    csvText: scheduleCsv(SMALL),
    principal: 10000,
    annualRate: 4,
    periods: 12,
    startDate: '2026-01-15',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.headerRow, 4);
  assert.equal(result.data.verdict, 'match');
  assert.match(result.markdown, /结论：与合同口径一致/);
  assert.equal(result.data.rows.length, 12);
});

test('loan_audit refuses Excel with an actionable message', async () => {
  await assert.rejects(
    () => byName('loan_audit').execute({ path: 'C:/tmp/statement.xlsx', principal: 10000, annualRate: 4, periods: 12 }),
    /Excel files are not supported/,
  );
});

test('loan_audit asks for a mapping instead of guessing', async () => {
  const result = await byName('loan_audit').execute({
    csvText: 'foo,bar\n1,2\n3,4',
    principal: 10000,
    annualRate: 4,
    periods: 2,
  });
  assert.equal(result.status, 'needs_mapping');
  assert.match(result.markdown, /无法自动识别表头/);
  assert.ok(result.data.roles.period.required);
  assert.deepEqual(result.data.headerCandidates, []);
});

test('loan_audit honours an explicit column mapping on an alien header', async () => {
  const csv = scheduleCsv(SMALL, { titleRows: false }).split('\n');
  csv[0] = 'x1,x2,x3,x4,x5,x6';
  const result = await byName('loan_audit').execute({
    csvText: csv.join('\n'),
    columns: { period: 'A', dueDate: 'B', principal: 'C', interest: 'D', payment: 'E', balance: 'F' },
    principal: 10000,
    annualRate: 4,
    periods: 12,
    startDate: '2026-01-15',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.verdict, 'match');
});

test('loan_audit rejects a mapping that points at nothing', async () => {
  const csv = scheduleCsv(SMALL, { titleRows: false }).split('\n');
  csv[0] = 'x1,x2,x3';
  const result = await byName('loan_audit').execute({
    csvText: csv.join('\n'),
    columns: { period: 'Z', principal: 'B', interest: 'C' },
    principal: 10000,
    annualRate: 4,
    periods: 12,
  });
  assert.equal(result.status, 'needs_mapping');
  assert.ok(result.data.errors.some((error) => error.code === 'unknown_column'));
  assert.match(result.markdown, /没有通过校验/);
});

test('loan_audit parses the table first, then asks for contract terms', async () => {
  const result = await byName('loan_audit').execute({ csvText: scheduleCsv(SMALL) });
  assert.equal(result.status, 'needs_contract');
  assert.match(result.markdown, /还缺合同要素/);
  assert.equal(result.data.parsedPeriods, 12);
});

test('loan_audit flags a statement that used the wrong day count', async () => {
  const base = { ...SMALL, method: 'interest-only', basis: 'ACT/360' };
  const schedule = buildSchedule(base);
  const rows = schedule.rows.map((row) => {
    const interestCents = Math.round(row.interestCents * (365 / 360));
    return [row.period, row.dueDate, '0.00', (interestCents / 100).toFixed(2), (interestCents / 100).toFixed(2), '0.00'].join(',');
  });
  const csv = ['期次,还款日,应还本金,应还利息,应还本息合计,剩余本金', ...rows].join('\n');

  const result = await byName('loan_audit').execute({
    csvText: csv,
    principal: 10000,
    annualRate: 4,
    periods: 12,
    method: 'interest-only',
    startDate: '2026-01-15',
    basis: 'ACT/360',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.verdict, 'mismatch');
  assert.equal(result.data.cause.code, 'dayCount');
  assert.match(result.markdown, /结论：多收利息/);
});

test('prepay_audit compares the two bank options', async () => {
  const result = await byName('prepay_audit').execute({
    remainingPrincipal: 1000000,
    annualRate: 4.9,
    remainingPeriods: 240,
    prepay: 100000,
  });
  assert.match(result.markdown, /结论：提前还 ¥100,000\.00/);
  assert.match(result.markdown, /缩短期限（月供不变）/);
  assert.ok(result.data.reduceTerm.periods < 240);
  assert.ok(result.data.reduceTerm.netSavingCents > 0);
  // No penalty → the implied return of the prepayment is the loan rate.
  assert.ok(Math.abs(result.data.reduceTerm.impliedReturn.nominalApr - 0.049) < 1e-4);
});

test('prepay_audit turns a penalty rate and a penalty in months into money', async () => {
  const byRate = await byName('prepay_audit').execute({
    remainingPrincipal: 1000000,
    annualRate: 4.9,
    remainingPeriods: 240,
    prepay: 100000,
    penaltyRate: 1,
  });
  assert.equal(byRate.data.penaltyCents, 100000); // 1% of ¥100,000

  const byMonths = await byName('prepay_audit').execute({
    remainingPrincipal: 1000000,
    annualRate: 4.9,
    remainingPeriods: 240,
    prepay: 100000,
    penaltyMonths: 3,
  });
  assert.ok(byMonths.data.penaltyCents > 0);

  await assert.rejects(
    () => byName('prepay_audit').execute({
      remainingPrincipal: 1000000, annualRate: 4.9, remainingPeriods: 240, prepay: 100000, penalty: 1, penaltyRate: 1,
    }),
    /only one of penalty/,
  );
});

test('prepay_audit answers the "pay off or invest" question', async () => {
  const result = await byName('prepay_audit').execute({
    remainingPrincipal: 1000000,
    annualRate: 4.9,
    remainingPeriods: 240,
    prepay: 100000,
    compareYield: 2,
  });
  assert.equal(result.data.comparison.reduceTerm.verdict, 'prepay-wins');
  assert.match(result.markdown, /提前还款更划算/);

  const other = await byName('prepay_audit').execute({
    remainingPrincipal: 1000000, annualRate: 4.9, remainingPeriods: 240, prepay: 100000, compareYield: 8,
  });
  assert.equal(other.data.comparison.reduceTerm.verdict, 'invest-wins');
});

test('every tool renders the same Markdown into the transcript', async () => {
  const argsFor = {
    real_apr: { principal: 10000, periods: 12, monthlyFeeRate: 0.6 },
    loan_schedule: { principal: 100000, annualRate: 4, periods: 12 },
    loan_audit: { csvText: scheduleCsv(SMALL), principal: 10000, annualRate: 4, periods: 12, startDate: '2026-01-15' },
    prepay_audit: { remainingPrincipal: 1000000, annualRate: 4.9, remainingPeriods: 240, prepay: 100000 },
    apr_compare: {
      offers: [
        { name: 'A', principal: 100000, periods: 12, payment: 9000 },
        { name: 'B', principal: 100000, periods: 12, monthlyFeeRate: 0.6 },
      ],
    },
    lpr_reset: { remainingPrincipal: 1000000, remainingPeriods: 240, spreadBp: 55, newLpr: 3.5 },
  };
  for (const tool of createTools()) {
    const args = argsFor[tool.name];
    const result = await tool.execute(args);
    assert.deepEqual(tool.output.render(args, result), [{ type: 'text', text: result.markdown }]);
    assert.equal(tool.presentCall(args).card, 'generic');
  }
});
