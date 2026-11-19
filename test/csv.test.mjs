import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CsvError,
  coerceRows,
  decodeText,
  detectDelimiter,
  findHeader,
  letterToIndex,
  parseDateCell,
  parseDelimited,
  parseMoneyCell,
  parsePeriodCell,
  scoreHeaderRow,
  validateMapping,
} from '../lib/csv.mjs';

test('decodeText handles BOM, UTF-8 and GBK bytes', () => {
  const utf8 = Buffer.from('期次,本金', 'utf8');
  assert.deepEqual(decodeText(utf8), { text: '期次,本金', encoding: 'utf-8' });

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  assert.equal(decodeText(bom).encoding, 'utf-8');
  assert.equal(decodeText(bom).text, '期次,本金');

  // GBK for 期次 is C6 DA B4 CE — invalid UTF-8, so the fallback must take it.
  const gbk = Buffer.from([0xc6, 0xda, 0xb4, 0xce]);
  const decoded = decodeText(gbk);
  assert.equal(decoded.text, '期次');
  assert.match(decoded.encoding, /gb/);
});

test('decodeText refuses bytes it cannot read', () => {
  // 0xFF is not a valid lead byte in UTF-8 or GB18030 (and is not a BOM).
  assert.throws(() => decodeText(Buffer.from([0xff, 0xff, 0xff])), CsvError);
});

test('detectDelimiter picks the separator that actually splits rows', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.throws(() => detectDelimiter('single column\nno separators'), /delimiter/);
});

test('parseDelimited honours quotes, doubled quotes and CRLF', () => {
  const rows = parseDelimited('a,b\r\n"x, y","he said ""hi"""\r\n', ',');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
});

test('parseDelimited keeps interior blank lines so row numbers match the file', () => {
  const rows = parseDelimited('a,b,\n\n1,2,\n\n\n', ',');
  assert.deepEqual(rows, [['a', 'b'], [], ['1', '2']]);
});

test('findHeader skips the title block a bank export puts on top', () => {
  const rows = [
    ['个人住房贷款还款计划表'],
    ['借款人：张**', '合同号：2024-0317'],
    [''],
    ['期次', '还款日', '应还本金', '应还利息', '本息合计', '剩余本金'],
    ['1', '2026-02-15', '1573.78', '2916.67', '4490.45', '998426.22'],
  ];
  const found = findHeader(rows);
  assert.equal(found.index, 3);
  assert.deepEqual(
    { period: found.mapping.period, principal: found.mapping.principal, interest: found.mapping.interest, balance: found.mapping.balance, dueDate: found.mapping.dueDate },
    { period: 0, principal: 2, interest: 3, balance: 5, dueDate: 1 },
  );
});

test('findHeader returns null rather than guessing', () => {
  assert.equal(findHeader([['foo', 'bar'], ['1', '2']]), null);
});

test('scoreHeaderRow tolerates alternative column names', () => {
  const scored = scoreHeaderRow(['期数', '扣款日', '本金', '利息', '月供', '贷款余额']);
  assert.equal(scored.essential, 3);
  assert.equal(scored.mapping.principal, 2);
  assert.equal(scored.mapping.interest, 3);
});

test('letterToIndex maps spreadsheet letters', () => {
  assert.equal(letterToIndex('A'), 0);
  assert.equal(letterToIndex('C'), 2);
  assert.equal(letterToIndex('AB'), 27);
  assert.equal(letterToIndex('1'), null);
});

test('validateMapping accepts letters and header text, rejects bad input', () => {
  const header = ['期次', '还款日', '应还本金', '应还利息'];

  const ok = validateMapping({ period: 'A', principal: 'C', interest: 'D' }, header);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.resolved, { period: 0, principal: 2, interest: 3 });

  const byText = validateMapping({ period: '期次', principal: '应还本金', interest: '应还利息' }, header);
  assert.equal(byText.ok, true);

  const unknown = validateMapping({ period: 'A', principal: 'Z', interest: 'D' }, header);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errors[0].code, 'unknown_column');

  const duplicate = validateMapping({ period: 'A', principal: 'A', interest: 'D' }, header);
  assert.ok(duplicate.errors.some((error) => error.code === 'duplicate_column'));

  const missing = validateMapping({ period: 'A', principal: 'C' }, header);
  assert.ok(missing.errors.some((error) => error.code === 'missing_role'));

  const badRole = validateMapping({ term: 'A', principal: 'C', interest: 'D' }, header);
  assert.ok(badRole.errors.some((error) => error.code === 'invalid_role'));
});

test('money cells survive the shapes banks actually print', () => {
  assert.equal(parseMoneyCell('1,234.56'), 123456);
  assert.equal(parseMoneyCell('¥1,234.56'), 123456);
  assert.equal(parseMoneyCell('1234.56元'), 123456);
  assert.equal(parseMoneyCell('(1,234.56)'), -123456);
  assert.equal(parseMoneyCell(''), null);
  assert.equal(parseMoneyCell('-'), null);
  assert.equal(parseMoneyCell('待定'), null);
});

test('period and date cells cover the common formats', () => {
  assert.equal(parsePeriodCell('1'), 1);
  assert.equal(parsePeriodCell('第3期'), 3);
  assert.equal(parsePeriodCell('2.0'), 2);
  assert.equal(parsePeriodCell('x'), null);

  assert.equal(parseDateCell('2026-02-15'), '2026-02-15');
  assert.equal(parseDateCell('2026/2/15'), '2026-02-15');
  assert.equal(parseDateCell('2026年2月15日'), '2026-02-15');
  assert.equal(parseDateCell('20260215'), '2026-02-15');
  // Excel serial, still common after a copy-paste into CSV.
  assert.equal(parseDateCell('46082'), '2026-03-01');
  assert.equal(parseDateCell('2026-13-01'), null);
});

test('coerceRows records unparsable cells instead of dropping rows', () => {
  const rows = [
    ['期次', '本金', '利息'],
    ['1', '100.00', '10.00'],
    ['2', 'abc', '10.00'],
    ['3', '100.00', '10.00'],
  ];
  const { records, warnings } = coerceRows(rows, 0, { period: 0, principal: 1, interest: 2 });
  assert.equal(records.length, 3);
  assert.equal(records[1].principalCents, null);
  assert.ok(warnings.some((warning) => /第 3 行.*principal/.test(warning)));
});
