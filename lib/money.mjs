/**
 * Money in integer cents.
 *
 * Every amount in this plugin is an integer number of fen, never a float yuan.
 * A loan schedule adds and subtracts hundreds of rounded amounts; doing that in
 * floating point drifts by a few fen, and "a few fen" is exactly the kind of
 * error the rest of this plugin exists to expose.
 *
 * Rates stay floats (they are ratios, not money) but every rate * amount product
 * goes through `roundHalfUp` once, at the boundary, and only once.
 */

/** Reject inputs that are not plausibly yuan amounts. */
const MAX_YUAN = 1e12;

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

function parseNumeric(input, label) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`${label} must be a finite number`);
    return input;
  }
  if (typeof input === 'string') {
    const cleaned = input
      .trim()
      .replace(/[¥$€£\s]/g, '')
      .replace(/元$/, '')
      .replace(/,/g, '');
    if (cleaned === '') throw new MoneyError(`${label} must not be empty`);
    const value = Number(cleaned);
    if (!Number.isFinite(value)) throw new MoneyError(`${label} is not a number: ${input}`);
    return value;
  }
  throw new MoneyError(`${label} must be a number or a numeric string`);
}

/**
 * Round half away from zero, correcting binary representation error first.
 *
 * `0.145 * 100` is 14.499999999999998 in IEEE 754, so a naive `Math.round` turns
 * a true half into a loss. Nudging by one ulp before rounding restores "half up"
 * for values that are only off by representation error, while leaving genuinely
 * smaller values (14.4999) alone.
 */
export function roundHalfUp(value, decimals = 0) {
  if (!Number.isFinite(value)) throw new MoneyError('roundHalfUp: value must be finite');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new MoneyError('roundHalfUp: decimals must be an integer between 0 and 8');
  }
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const nudge = Math.abs(scaled) * Number.EPSILON;
  const nudged = scaled + (scaled >= 0 ? nudge : -nudge);
  return Math.round(nudged) / factor;
}

/** Yuan (number or numeric string) → integer fen. */
export function toCents(input, label = 'amount') {
  const yuan = parseNumeric(input, label);
  if (Math.abs(yuan) > MAX_YUAN) throw new MoneyError(`${label} is out of range: ${yuan}`);
  const cents = roundHalfUp(yuan * 100, 0);
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`${label} does not fit in integer cents: ${yuan}`);
  return cents;
}

/** Integer fen → yuan as a number. For display use `formatCny`. */
export function fromCents(cents) {
  assertCents(cents);
  return cents / 100;
}

/** Integer fen → `1,234.56` (no currency symbol). */
export function formatAmount(cents) {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = String(abs % 100).padStart(2, '0');
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fen}`;
}

/** Integer fen → `¥1,234.56`, with the sign outside the symbol (`-¥12.30`). */
export function formatCny(cents) {
  assertCents(cents);
  return cents < 0 ? `-¥${formatAmount(-cents)}` : `¥${formatAmount(cents)}`;
}

function assertCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`expected integer cents, got ${cents}`);
}

/**
 * cents × rate, rounded once to whole fen.
 *
 * `rate` is a ratio (0.0035 for 0.35%), not a percentage.
 */
export function mulRate(cents, rate) {
  assertCents(cents);
  if (!Number.isFinite(rate)) throw new MoneyError('mulRate: rate must be finite');
  return roundHalfUp(cents * rate, 0);
}

/**
 * Split `totalCents` by `weights` without losing or inventing a single fen.
 *
 * Largest-remainder method: floor everything, then hand the leftover fen to the
 * entries with the largest fractional parts (ties broken by index, so the result
 * is deterministic). `allocate(100, [1,1,1])` → `[34, 33, 33]`.
 */
export function allocate(totalCents, weights) {
  assertCents(totalCents);
  if (totalCents < 0) throw new MoneyError('allocate: total must not be negative');
  if (!Array.isArray(weights) || weights.length === 0) throw new MoneyError('allocate: weights must be a non-empty array');
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) throw new MoneyError('allocate: every weight must be a non-negative number');
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new MoneyError('allocate: weights must not all be zero');

  const exact = weights.map((weight) => (totalCents * weight) / sum);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let k = 0; remainder > 0; k += 1, remainder -= 1) {
    floors[order[k % order.length].index] += 1;
  }
  return floors;
}
