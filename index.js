/**
 * dsh-loan-cal — host entry.
 *
 * Registers the loan tools. The math is pure and local: no network, no storage,
 * nothing to read at mount time, so a DSH start never waits on this plugin.
 *
 * Implemented:  real_apr       — installment fee → nominal / effective APR
 *               loan_schedule  — amortisation table + IRR under a declared clock
 *               loan_audit     — recompute a bank schedule and diff it
 *               prepay_audit   — early payoff: interest saved, penalty, implied return
 *               apr_compare    — several offers ranked on one yardstick
 *               lpr_reset      — LPR repricing: new rate, new instalment
 */
import { createTools } from './lib/tools.mjs';

export const name = 'loan-cal';

// Only the tool registry is needed: the math is pure and local, so there is no
// network, storage or web-server dependency to declare.
export const inject = ['tools'];

export function apply(ctx, settings = {}) {
  // A broken plugin must never take the profile's composition down with it.
  try {
    mount(ctx, settings);
  } catch (error) {
    console.warn('loan-cal: mount failed; the plugin stays dormant', error);
  }
}

function mount(ctx, settings) {
  void settings;
  for (const tool of createTools()) {
    // Registered through ctx.effect so unload and hot reload remove it cleanly.
    ctx.effect(() => ctx.tools.register(tool), `loan-cal: ${tool.name}`);
  }
}
