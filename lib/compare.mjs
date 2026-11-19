/**
 * Several loan offers, one yardstick.
 *
 * Every offer is normalised to the same numbers `real_apr` produces, then ranked by
 * the compounded annual rate — the one the PBOC requires lenders to disclose
 * (ADR 0002). Ranking by the simple rate instead would reorder offers whose terms
 * differ, which is exactly the mistake this tool exists to prevent.
 */
import { aprFromInstallment } from './irr.mjs';

export class CompareError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompareError';
  }
}

/**
 * @param options.offers Array of { name?, principalCents, periods, paymentCents?, monthlyFeeRate?, upfrontFeeCents? }
 */
export function compareOffers({ offers }) {
  if (!Array.isArray(offers) || offers.length < 2) {
    throw new CompareError('at least two offers are required');
  }

  const rows = offers.map((offer, index) => {
    const label = typeof offer.name === 'string' && offer.name.trim() !== '' ? offer.name.trim() : `方案 ${index + 1}`;
    if (!Number.isSafeInteger(offer.principalCents) || offer.principalCents <= 0) {
      throw new CompareError(`${label}：本金必须是正整数分`);
    }
    if (!Number.isInteger(offer.periods) || offer.periods < 1 || offer.periods > 600) {
      throw new CompareError(`${label}：期数必须是 1–600 的整数`);
    }
    const hasPayment = offer.paymentCents !== undefined && offer.paymentCents !== null;
    const hasFeeRate = offer.monthlyFeeRate !== undefined && offer.monthlyFeeRate !== null;
    if (hasPayment === hasFeeRate) {
      throw new CompareError(`${label}：每期还款与月费率必须二选一`);
    }

    const paymentCents = hasPayment ? offer.paymentCents : feeBasedPayment(offer);
    const computed = aprFromInstallment({
      principalCents: offer.principalCents,
      periods: offer.periods,
      paymentCents,
      upfrontFeeCents: offer.upfrontFeeCents ?? 0,
      monthlyFeeRate: hasFeeRate ? offer.monthlyFeeRate : null,
    });

    return {
      name: label,
      principalCents: computed.principalCents,
      periods: computed.periods,
      paymentCents: computed.paymentCents,
      upfrontFeeCents: computed.upfrontFeeCents,
      totalRepayCents: computed.totalRepay,
      totalCostCents: computed.totalCost,
      monthlyRate: computed.monthlyRate,
      nominalApr: computed.nominalApr,
      effectiveApr: computed.effectiveApr,
    };
  });

  const ranked = rows.slice().sort((a, b) => a.effectiveApr - b.effectiveApr);
  ranked.forEach((row, index) => { row.rank = index + 1; });

  const cheapest = ranked[0];
  const mostExpensive = ranked[ranked.length - 1];
  const warnings = [];

  const sameShape = rows.every((row) => row.principalCents === cheapest.principalCents && row.periods === cheapest.periods);
  if (!sameShape) {
    warnings.push('各方案的本金或期数不同：年化利率可以直接比，但「总成本」金额不能直接比。');
  }
  if (rows.some((row) => row.upfrontFeeCents > 0)) {
    warnings.push('含前置费用的方案，其年化已把费用计入实际到手本金。');
  }

  return {
    rows: ranked,
    cheapest: { name: cheapest.name, effectiveApr: cheapest.effectiveApr, nominalApr: cheapest.nominalApr },
    mostExpensive: { name: mostExpensive.name, effectiveApr: mostExpensive.effectiveApr, nominalApr: mostExpensive.nominalApr },
    spreadPoints: mostExpensive.effectiveApr - cheapest.effectiveApr,
    sameShape,
    warnings,
  };
}

/** 等本等费: principal spread flat plus a fee charged on the original principal. */
function feeBasedPayment(offer) {
  const principalPart = Math.round(offer.principalCents / offer.periods);
  const feePart = Math.round(offer.principalCents * offer.monthlyFeeRate);
  return principalPart + feePart;
}
