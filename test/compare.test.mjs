import test from 'node:test';
import assert from 'node:assert/strict';

import { CompareError, compareOffers } from '../lib/compare.mjs';
import { createTools } from '../lib/tools.mjs';

const CARD_A = { name: 'A 信用卡', principalCents: 1_000_000, periods: 12, monthlyFeeRate: 0.006 };
const CARD_B = { name: 'B 消费贷', principalCents: 1_000_000, periods: 12, monthlyFeeRate: 0.003 };

test('offers are ranked by the compounded rate, cheapest first', () => {
  const result = compareOffers({ offers: [CARD_A, CARD_B] });
  assert.equal(result.rows[0].name, 'B 消费贷');
  assert.equal(result.rows[1].name, 'A 信用卡');
  assert.equal(result.rows[0].rank, 1);
  assert.ok(result.rows[0].effectiveApr < result.rows[1].effectiveApr);
  assert.equal(result.cheapest.name, 'B 消费贷');
  assert.ok(result.spreadPoints > 0);
});

test('the same shape means total cost is directly comparable', () => {
  const result = compareOffers({ offers: [CARD_A, CARD_B] });
  assert.equal(result.sameShape, true);
  assert.equal(result.warnings.length, 0);
});

test('different principals disable direct comparison of totals', () => {
  const result = compareOffers({
    offers: [CARD_A, { ...CARD_B, principalCents: 2_000_000 }],
  });
  assert.equal(result.sameShape, false);
  assert.ok(result.warnings.some((warning) => /不能直接比/.test(warning)));
});

test('an upfront fee is folded into the cost', () => {
  const withFee = compareOffers({
    offers: [{ ...CARD_A, upfrontFeeCents: 50_000 }, CARD_B],
  });
  const withoutFee = compareOffers({ offers: [CARD_A, CARD_B] });
  const row = (result) => result.rows.find((candidate) => candidate.name === 'A 信用卡');
  assert.ok(row(withFee).effectiveApr > row(withoutFee).effectiveApr);
  assert.ok(withFee.warnings.some((warning) => /前置费用/.test(warning)));
});

test('a mortgage quote and a card installment can be compared on one number', () => {
  const result = compareOffers({
    offers: [
      { name: '房贷', principalCents: 100_000_000, periods: 360, paymentCents: 449_045 },
      { name: '分期', principalCents: 100_000_000, periods: 12, monthlyFeeRate: 0.006 },
    ],
  });
  assert.equal(result.cheapest.name, '房贷');
  assert.ok(result.spreadPoints > 0.1);
});

test('bad offers name the offender', () => {
  assert.throws(() => compareOffers({ offers: [CARD_A] }), CompareError);
  assert.throws(() => compareOffers({ offers: [CARD_A, { ...CARD_B, periods: 0 }] }), /期数/);
  assert.throws(
    () => compareOffers({ offers: [CARD_A, { name: 'C', principalCents: 100, periods: 12 }] }),
    /二选一/,
  );
});

test('apr_compare tool renders a ranking table', async () => {
  const tool = createTools().find((candidate) => candidate.name === 'apr_compare');
  const result = await tool.execute({
    offers: [
      { name: 'A 银行', principal: 100000, periods: 36, payment: 3200 },
      { name: 'B 消费金融', principal: 100000, periods: 36, payment: 3450 },
      { name: 'C 信用卡分期', principal: 100000, periods: 36, monthlyFeeRate: 0.6 },
    ],
  });
  assert.match(result.markdown, /最便宜：A 银行/);
  assert.match(result.markdown, /\| 1 \| A 银行/);
  assert.equal(result.data.rows[0].name, 'A 银行');
  assert.equal(result.data.rows.length, 3);
});

test('apr_compare rejects a single offer', async () => {
  const tool = createTools().find((candidate) => candidate.name === 'apr_compare');
  await assert.rejects(
    () => tool.execute({ offers: [{ name: 'A', principal: 100000, periods: 12, payment: 9000 }] }),
    /at least two offers/,
  );
});
