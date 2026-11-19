import test from 'node:test';
import assert from 'node:assert/strict';

import { LprError, resetRate } from '../lib/lpr.mjs';
import { buildSchedule } from '../lib/schedule.mjs';
import { createTools } from '../lib/tools.mjs';

const BASE = Object.freeze({
  remainingPrincipalCents: 100_000_000, // ¥1,000,000
  remainingPeriods: 240,
  spreadBp: 55,
  newLpr: 0.035,
});

test('the executed rate is LPR plus the fixed spread', () => {
  const result = resetRate(BASE);
  assert.ok(Math.abs(result.newRate - 0.0405) < 1e-12);
  // ... and the instalment is the ordinary level payment at that rate.
  const expected = buildSchedule({ principalCents: BASE.remainingPrincipalCents, annualRate: 0.0405, periods: 240 });
  assert.equal(result.paymentCents, expected.paymentCents);
});

test('a lower LPR lowers the instalment and the remaining interest', () => {
  const result = resetRate({ ...BASE, oldLpr: 0.036 });
  assert.ok(result.paymentDeltaCents < 0);
  assert.ok(result.interestDeltaCents < 0);
  assert.ok(result.oldRate > result.newRate);
  assert.equal(result.paymentDeltaCents, result.paymentCents - result.oldPaymentCents);
});

test('a zero spread means the rate is exactly the LPR', () => {
  const result = resetRate({ ...BASE, spreadBp: 0, newLpr: 0.03 });
  assert.ok(Math.abs(result.newRate - 0.03) < 1e-12);
});

test('a negative spread (discount) is allowed down to a sane floor', () => {
  const result = resetRate({ ...BASE, spreadBp: -20, newLpr: 0.035 });
  assert.ok(Math.abs(result.newRate - 0.033) < 1e-12);
  assert.throws(() => resetRate({ ...BASE, spreadBp: -400, newLpr: 0.035 }), /positive rate/);
});

test('bad input is rejected', () => {
  assert.throws(() => resetRate({ ...BASE, spreadBp: 5000 }), LprError);
  assert.throws(() => resetRate({ ...BASE, newLpr: 0.9 }), LprError);
  assert.throws(() => resetRate({ ...BASE, remainingPeriods: 0 }), LprError);
});

test('lpr_reset tool reports the change in the monthly payment', async () => {
  const tool = createTools().find((candidate) => candidate.name === 'lpr_reset');
  const result = await tool.execute({
    remainingPrincipal: 1000000,
    remainingPeriods: 240,
    spreadBp: 55,
    newLpr: 3.5,
    oldLpr: 3.6,
  });
  assert.match(result.markdown, /新月供 ¥/);
  assert.match(result.markdown, /LPR 3\.5000% \+ 加点 55bp/);
  assert.ok(result.data.paymentDeltaCents < 0);
  assert.equal(result.data.spreadBp, 55);
});

test('lpr_reset without an old LPR omits the comparison', async () => {
  const tool = createTools().find((candidate) => candidate.name === 'lpr_reset');
  const result = await tool.execute({
    remainingPrincipal: 1000000, remainingPeriods: 240, spreadBp: 55, newLpr: 3.5,
  });
  assert.equal(result.data.oldPaymentCents, null);
  assert.match(result.markdown, /\| 月供 \| — \|/);
});
