/**
 * The PBOC's own worked examples, locked as test vectors.
 *
 * 中国人民银行公告〔2021〕第 3 号 附件《采用内部收益率法计算贷款年化利率示例》
 * https://www.gov.cn/zhengce/zhengceku/2021-03/31/content_5597156.htm
 *
 * These three cases are the reason ADR 0002 exists: they prove which annualisation
 * the regulator calls "年化利率" (the compounded one) and which it calls "单利"
 * (monthly IRR × 12). If a future change moves any of these numbers, the
 * convention was touched — explain it before merging.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { annualizeEffective, annualizeNominal, monthlyIrr } from '../lib/irr.mjs';
import { buildSchedule } from '../lib/schedule.mjs';
import { createTools } from '../lib/tools.mjs';

const round2 = (ratio) => (ratio * 100).toFixed(2);

test('PBOC example 1 — 100,000 for 2 years, 110,000 repaid at maturity → 4.88%', () => {
  const flows = [-10_000_000, ...Array(23).fill(0), 11_000_000];
  const monthly = monthlyIrr(flows);
  assert.equal(round2(annualizeEffective(monthly)), '4.88');
  // The simple basis would report 4.77%; the regulator's number is the compounded one.
  assert.equal(round2(annualizeNominal(monthly)), '4.77');
});

test('PBOC example 2 — 1,000,000 / 240 periods / 6,599.6 per period → 单利 5%, IRR 5.12%', () => {
  const flows = [-100_000_000, ...Array(240).fill(659_960)];
  const monthly = monthlyIrr(flows);
  assert.equal(round2(annualizeNominal(monthly)), '5.00');
  assert.equal(round2(annualizeEffective(monthly)), '5.12');
});

test('PBOC example 2 — our own level payment lands on 6,599.6', () => {
  const schedule = buildSchedule({ principalCents: 100_000_000, annualRate: 0.05, periods: 240 });
  assert.equal((schedule.paymentCents / 100).toFixed(2), '6599.56');
});

test('PBOC example 3 — 100,000 / 12 periods / 1,000 upfront / 8,833.3 → 单利 12.80%, IRR 13.58%', () => {
  const flows = [-9_900_000, ...Array(12).fill(883_330)];
  const monthly = monthlyIrr(flows);
  assert.equal(round2(annualizeNominal(monthly)), '12.80');
  assert.equal(round2(annualizeEffective(monthly)), '13.58');
});

test('PBOC example 3 — the real_apr tool reproduces the regulator 13.58%', async () => {
  const tool = createTools().find((candidate) => candidate.name === 'real_apr');
  const result = await tool.execute({ principal: 100000, periods: 12, payment: 8833.3, upfrontFee: 1000 });
  assert.equal(round2(result.data.effectiveApr), '13.58');
  assert.equal(round2(result.data.nominalApr), '12.80');
  assert.match(result.markdown, /复利年化 13\.58%/);
});
