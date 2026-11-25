# dsh-loan-cal

**English** | [中文](README-zh.md)

Strict-convention loan math for DeepSeek Harness. Six tools, zero dependencies.

## Overview

The same loan gets different answers depending on the convention applied. Nothing is guessed here:
the compounded rate follows the PBOC 2021 IRR notice, the simple rate sits beside it and is labelled,
and daily accrual requires an explicit basis. Money is integer fen throughout; the final instalment
absorbs rounding.

A card instalment quoted at 0.6% per month is sold as 7.2% a year. Over 12 instalments it actually
costs **13.84%** compounded — that gap is what this plugin measures.

The tools cover one chain: true annual rate → amortisation table → audit of a bank statement → early
payoff → comparing offers → LPR repricing. No network, no Excel parsing, no bundled LPR snapshot — by
design.

## Tools

| Tool | What it does |
|---|---|
| `real_apr` | Monthly fee rate and fees → monthly IRR, simple and compounded annual rate |
| `loan_schedule` | Equal-installment / equal-principal / interest-only / balloon → amortisation table + implied IRR |
| `loan_audit` | A bank's repayment schedule → per-period diff, overcharge total, attributed cause (rate / day count / rounding) |
| `prepay_audit` | Early payoff → interest saved, penalty, implied return, payback, both bank options |
| `apr_compare` | Several offers → one yardstick, ranked, with the spread |
| `lpr_reset` | LPR plus fixed spread → new rate, new instalment, interest change |

## Language

Results tables, conclusions and warnings are **Chinese** — a person reads them. Tool names,
`description`s, parameter docs and error messages are **English** — the model acts on them.
Documentation is bilingual: this file and [README-zh.md](README-zh.md).

## Conventions

- The compounded rate `(1 + monthly IRR)¹² − 1` is the headline (PBOC 2021 notice); the simple rate
  `monthly IRR × 12` is shown beside it and never mixed — [ADR 0002](docs/adr/0002-annualized-rate-convention.md)
- Daily accrual requires an explicit `ACT/360`, `ACT/365` or `30/360`; there is no default
- Integer fen throughout; one rounding per rate × amount; principal parts always sum to the principal
- CSV/TSV or pasted text only, never xlsx — [ADR 0003](docs/adr/0003-csv-only-input.md); LPR is supplied by the caller

## Install

Requires DSH ≥ 0.2.0 (declared in `engines`).

```sh
dsh plugin --profile <profile> add dsh-loan-cal
```

## Development

```sh
git clone https://github.com/aaaLittleCloud/dsh-loan-cal
dsh plugin --profile dev add file:./dsh-loan-cal   # file: install is a snapshot

npm test          # 106 tests, no network
npm run check     # randomised invariant checks
```

## Verification

106 tests, including the three worked examples in the annex of the PBOC 2021 notice (4.88% / simple 5%
and IRR 5.12% / simple 12.80% and IRR 13.58%). A randomised check asserts the invariants no fixture
covers: principal parts sum to the principal, every schedule closes, ambiguous cells are refused rather
than guessed. CI runs both on Node 22 and 24, and all six tools have been executed inside a real profile.

## Citation

```bibtex
@software{dsh-loan-cal,
  author = {aaaLittleCloud},
  title  = {dsh-loan-cal: strict-convention loan math for DeepSeek Harness},
  year   = {2026},
  url    = {https://github.com/aaaLittleCloud/dsh-loan-cal}
}
```

> aaaLittleCloud. (2026). *dsh-loan-cal* [Computer software]. https://github.com/aaaLittleCloud/dsh-loan-cal

## License

MIT
