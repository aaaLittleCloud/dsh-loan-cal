/**
 * CSV/TSV intake.
 *
 * Deliberately narrow (ADR 0003): text only. Excel files are converted before
 * they reach here, so this module never touches ZIP, XML or binary formats.
 *
 * Everything that can go wrong with a bank export is normalised into one of three
 * outcomes: parse it, ask for a column mapping, or say exactly why not.
 */

export class CsvError extends Error {
  constructor(message, code = 'csv_error') {
    super(message);
    this.name = 'CsvError';
    this.code = code;
  }
}

/** The roles a schedule table can carry. `required` ones make an audit possible. */
export const ROLES = Object.freeze({
  period: { required: true, type: 'integer', desc: '期次，1 起的整数' },
  principal: { required: true, type: 'money', desc: '当期应还本金' },
  interest: { required: true, type: 'money', desc: '当期应还利息' },
  payment: { required: false, type: 'money', desc: '当期应还本息合计' },
  balance: { required: false, type: 'money', desc: '还款后剩余本金' },
  dueDate: { required: false, type: 'date', desc: '还款日' },
});

export const ROLE_IDS = Object.freeze(Object.keys(ROLES));

/**
 * Decode bytes as UTF-8, else GB18030 (which covers GBK).
 *
 * Mainland bank exports are frequently GBK; a BOM wins outright when present.
 */
export function decodeText(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new CsvError('decodeText expects a byte array');

  const bom = (offset, encoding) => ({ text: new TextDecoder(encoding).decode(bytes.subarray(offset)), encoding });
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bom(3, 'utf-8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bom(2, 'utf-16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bom(2, 'utf-16be');

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch { /* not UTF-8, fall through */ }

  for (const encoding of ['gb18030', 'gbk']) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding };
    } catch { /* try the next one */ }
  }
  throw new CsvError('cannot decode the text (tried UTF-8, GB18030, GBK); re-save it as UTF-8 CSV', 'undecodable');
}

/** Pick the delimiter by counting candidates on the first lines. */
export function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 10);
  if (sample.length === 0) throw new CsvError('the file is empty', 'empty');
  const candidates = [
    { delimiter: ',', count: 0 },
    { delimiter: '\t', count: 0 },
    { delimiter: ';', count: 0 },
  ];
  for (const line of sample) {
    for (const candidate of candidates) {
      // Only count separators outside quotes.
      let inQuotes = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === candidate.delimiter && !inQuotes) candidate.count += 1;
      }
    }
  }
  candidates.sort((a, b) => b.count - a.count);
  if (candidates[0].count === 0) throw new CsvError('no delimiter found (tried comma, tab, semicolon)', 'no_delimiter');
  return candidates[0].delimiter;
}

/** RFC-4180-ish parser: quotes, doubled quotes, CRLF, and empty trailing cells. */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }

  // Blank lines are *kept*: `headerRow` is user-facing and must match the line
  // numbers the user sees in their editor or in Excel. Only a trailing run of
  // empty rows is trimmed, so a file ending in newlines does not gain a row.
  const trimmedCells = rows.map((cells) => {
    const copy = cells.slice();
    while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
    return copy;
  });
  let end = trimmedCells.length;
  while (end > 0 && trimmedCells[end - 1].every((value) => value.trim() === '')) end -= 1;
  return trimmedCells.slice(0, end);
}

/** Keyword matchers per role, ordered from most to least specific. */
const ROLE_PATTERNS = Object.freeze({
  period: [/期次/, /期数/, /^\s*期\s*$/, /序号/, /\bperiod\b/i, /\bno\.?\b/i],
  principal: [/应还本金/, /偿还本金/, /归还本金/, /本金/],
  interest: [/应还利息/, /偿还利息/, /归还利息/, /利息/],
  payment: [/本息合计/, /应还本息/, /月供/, /应还总额/, /应还金额/, /还款金额/, /还款额/],
  balance: [/剩余本金/, /本金余额/, /贷款余额/, /未还本金/, /余额/],
  dueDate: [/还款日/, /还款日期/, /扣款日/, /日期/, /\bdate\b/i],
});

/**
 * Score one candidate header row: how many distinct roles it covers.
 *
 * Within a role, the *earliest listed pattern wins* rather than the leftmost
 * column: a table often carries both `序号` (a row counter) and `期数` (the real
 * period), and picking whichever came first in the row would read the counter as
 * the period. Pattern order encodes specificity, so `期数` beats `序号` wherever
 * they sit.
 */
export function scoreHeaderRow(cells) {
  const found = new Map();
  for (const [role, patterns] of Object.entries(ROLE_PATTERNS)) {
    let best = null;
    for (let column = 0; column < cells.length; column += 1) {
      const cell = String(cells[column] ?? '').trim();
      if (cell === '') continue;
      const specificity = patterns.findIndex((pattern) => pattern.test(cell));
      if (specificity < 0) continue;
      if (best === null || specificity < best.specificity) best = { column, specificity };
    }
    if (best !== null) found.set(role, best.column);
  }
  // `payment` is implied by principal + interest, so it does not add to the score.
  const essential = ['period', 'principal', 'interest'].filter((role) => found.has(role)).length;
  return { mapping: Object.fromEntries(found), score: found.size, essential, columns: found.size };
}

/**
 * Find the header row within the first `limit` rows.
 *
 * Bank exports often put a title, an account number and a blank line above the
 * real header, so "row 1" is almost never right.
 */
export function findHeader(rows, limit = 10) {
  const candidates = [];
  for (let index = 0; index < Math.min(rows.length, limit); index += 1) {
    const { mapping, score, essential, columns } = scoreHeaderRow(rows[index]);
    if (essential >= 2) candidates.push({ index, mapping, score, essential, columns });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.essential - a.essential || b.score - a.score || a.index - b.index);
  return candidates[0];
}

/** `A` → 0, `AB` → 27. */
export function letterToIndex(letters) {
  if (typeof letters !== 'string' || !/^[A-Za-z]{1,3}$/.test(letters.trim())) return null;
  let index = 0;
  for (const ch of letters.trim().toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Check a caller-supplied mapping (role → column letter or header text).
 *
 * Returns errors in a shape the model can act on: each one names the role, the
 * offending cell and what was expected.
 */
export function validateMapping(mapping, headerCells) {
  const errors = [];
  const resolved = {};
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { ok: false, errors: [{ code: 'invalid_mapping', message: 'columns must be an object: { role: "column letter or header text" }' }], resolved };
  }

  const used = new Map();
  for (const [role, target] of Object.entries(mapping)) {
    if (!ROLE_IDS.includes(role)) {
      errors.push({ code: 'invalid_role', role, message: `未知角色 "${role}"；合法角色：${ROLE_IDS.join(', ')}` });
      continue;
    }
    if (typeof target !== 'string' || target.trim() === '') {
      errors.push({ code: 'invalid_target', role, message: `${role} 的列标识必须是非空字符串` });
      continue;
    }
    const byLetter = letterToIndex(target);
    let column = byLetter !== null && byLetter < headerCells.length ? byLetter : null;
    if (column === null) {
      const wanted = target.trim();
      column = headerCells.findIndex((cell) => String(cell ?? '').trim() === wanted);
    }
    if (column === null || column < 0) {
      errors.push({
        code: 'unknown_column',
        role,
        message: `${role} 指向的列 "${target}" 不存在；当前列：${headerCells.map((cell, index) => `${String.fromCharCode(65 + index)}=${String(cell ?? '').trim() || '空'}`).join(' ')}`,
      });
      continue;
    }
    if (used.has(column)) {
      errors.push({ code: 'duplicate_column', role, message: `列 ${String.fromCharCode(65 + column)} 被 ${used.get(column)} 和 ${role} 同时占用` });
      continue;
    }
    used.set(column, role);
    resolved[role] = column;
  }

  for (const role of ROLE_IDS) {
    if (ROLES[role].required && resolved[role] === undefined && !errors.some((error) => error.role === role)) {
      errors.push({ code: 'missing_role', role, message: `缺少必填角色 ${role}（${ROLES[role].desc}）` });
    }
  }
  return { ok: errors.length === 0, errors, resolved };
}

/**
 * `¥1,234.56` / `1234.56元` / `(1,234.56)` → integer cents, or null.
 *
 * Separatars are validated rather than stripped: `1,2,3` and the European
 * `1.234,56` are ambiguous, and silently reading them as 123 and 1.23 would put a
 * wrong number into an audit that then reports a confident conclusion. Returning
 * null makes the row surface as a warning instead.
 */
export function parseMoneyCell(cell) {
  if (cell === null || cell === undefined) return null;
  let text = String(cell).trim();
  if (text === '' || text === '-' || text === '—') return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text.replace(/[¥￥$元\s]/g, '');
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }

  if (text === '') return null;
  const hasComma = text.includes(',');
  const hasDot = text.includes('.');
  if (hasComma && hasDot) {
    // `1.234,56` puts the comma last — European grouping. Ambiguous here, reject.
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) return null;
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(text)) return null;
  } else if (hasComma) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return null;
  } else if (hasDot && !/^\d+(\.\d+)?$/.test(text)) {
    return null;
  }

  const normalized = text.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

/** `1` / `第1期` / `1.0` → 1, or null. */
export function parsePeriodCell(cell) {
  if (cell === null || cell === undefined) return null;
  const text = String(cell).trim().replace(/^第/, '').replace(/期$/, '').trim();
  if (text === '' || !/^\d+(\.0+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Date cells: ISO, slash form, compact `20260215`, or an Excel serial (1900 base).
 *
 * Excel serials still show up after a manual copy-paste into a CSV, so they are
 * accepted here rather than silently becoming "not a date".
 */
export function parseDateCell(cell) {
  if (cell === null || cell === undefined) return null;
  const text = String(cell).trim();
  if (text === '') return null;

  let match = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/.exec(text);
  if (match !== null) {
    const [, y, m, d] = match;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return isValidIso(iso) ? iso : null;
  }
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match !== null) {
    const iso = `${match[1]}-${match[2]}-${match[3]}`;
    return isValidIso(iso) ? iso : null;
  }
  // A datetime cell carries a fractional part (`46082.5` = noon); the date is
  // still the date, so the fraction is floored rather than rejected.
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial > 20000 && serial < 80000) {
      const ms = Date.UTC(1899, 11, 30) + serial * 86_400_000;
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
  return null;
}

function isValidIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Turn mapped rows into typed records.
 *
 * Any cell that cannot be read is recorded with its period and column, never
 * dropped: an audit that silently loses a row produces a confident wrong answer.
 */
export function coerceRows(rows, headerRowIndex, mapping) {
  const records = [];
  const warnings = [];
  for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.every((value) => String(value ?? '').trim() === '')) continue;
    const column = (role) => (mapping[role] === undefined ? undefined : cells[mapping[role]]);

    const period = parsePeriodCell(column('period'));
    if (period === null) {
      warnings.push(`第 ${index + 1} 行：期次无法解析（值 "${column('period') ?? ''}"），已跳过`);
      continue;
    }

    const record = { period, sourceRow: index + 1 };
    for (const role of ['principal', 'interest', 'payment', 'balance']) {
      if (mapping[role] === undefined) continue;
      const cents = parseMoneyCell(column(role));
      if (cents === null) {
        warnings.push(`第 ${index + 1} 行（第 ${period} 期）：${role} 无法解析（值 "${column(role) ?? ''}"）`);
        record[`${role}Cents`] = null;
      } else record[`${role}Cents`] = cents;
    }
    if (mapping.dueDate !== undefined) {
      record.dueDate = parseDateCell(column('dueDate'));
      if (record.dueDate === null) warnings.push(`第 ${index + 1} 行（第 ${period} 期）：日期无法解析（值 "${column('dueDate') ?? ''}"）`);
    }
    records.push(record);
  }
  return { records, warnings };
}
