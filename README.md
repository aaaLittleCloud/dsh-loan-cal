# dsh-loan-cal

严格口径的贷款计算工具，给 DeepSeek Harness 用。六个工具，零运行时依赖。
Strict-convention loan math for DeepSeek Harness. Six tools, zero dependencies.

## 简介

同一笔贷款，算法不同答案就不同。这个插件不猜口径：复利年化按央行〔2021〕第 3 号公告的 IRR 计算，
单利并列标注，按日计息必须显式声明基准。金额全程整数分，月供取整到分、末期吸收尾差。

工具覆盖一条链路：真实年化 → 摊还表 → 银行计划表核对 → 提前还款 → 多方案对比 → LPR 重定价。
有意不联网、不解析 Excel、不内置 LPR 数据。

## Overview

The same loan gets different answers depending on the convention applied. Nothing is guessed here:
the compounded rate follows the PBOC 2021 IRR notice, the simple rate sits beside it and is labelled,
and daily accrual requires an explicit basis. Money is integer fen throughout; the final instalment
absorbs rounding. No network, no Excel parsing, no bundled LPR snapshot — by design.

## 工具 / Tools

| Tool | 做什么 / What it does |
|---|---|
| `real_apr` | 月费率、费用 → 月 IRR、单利、复利年化 · fee rate and fees → monthly IRR, simple and compounded APR |
| `loan_schedule` | 等额本息 / 等额本金 / 先息后本 / 气球贷 → 摊还表 + 反解 IRR · four repayment shapes → amortisation table + implied IRR |
| `loan_audit` | 银行还款计划 → 逐期对差、多收总额、归因 · bank statement → per-period diff, overcharge, attributed cause |
| `prepay_audit` | 提前还款 → 省息、违约金、隐含年化、回本期 · early payoff → interest saved, penalty, implied return, payback |
| `apr_compare` | 多方案 → 统一口径排序 · several offers → one yardstick, ranked |
| `lpr_reset` | LPR + 加点 → 新利率、新月供 · LPR plus spread → new rate and instalment |

## 语言 / Language

用户看中文，模型读英文：结果表格与结论用中文，工具名、描述、参数、报错用英文。
Results are Chinese (a person reads them); tool names, descriptions, parameters and errors are English
(the model acts on them).

## 口径 / Conventions

- 复利是监管口径 `(1+月IRR)¹²−1`，单利 `月IRR×12` 并列，不混用 — [ADR 0002](docs/adr/0002-annualized-rate-convention.md)
- 按日计息必须声明 `ACT/360`、`ACT/365` 或 `30/360`，无隐式默认值
- 金额整数分；逐期本金合计必须精确等于本金
- 只收 CSV/TSV 或粘贴文本，不收 xlsx — [ADR 0003](docs/adr/0003-csv-only-input.md)；LPR 由调用方传入

## 安装 / 开发

```sh
dsh plugin --profile <profile> add dsh-loan-cal
npm test        # 99 tests, no network
```

`file:` 安装是快照，改代码后需 `remove` + `add` 重新挂载。

## 验证 / Verification

99 个测试，含央行公告附件三个官方算例（4.88% / 单利 5% 与 IRR 5.12% / 单利 12.80% 与 IRR 13.58%）；
六个工具已在真实 profile 中实机执行。

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
