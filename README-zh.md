# dsh-loan-cal

[English](README.md) | **中文**

严格口径的贷款计算工具，给 DeepSeek Harness 用。六个工具，零运行时依赖。

## 简介

同一笔贷款，算法不同答案就不同。这个插件不猜口径：复利年化按央行〔2021〕第 3 号公告的 IRR 计算，
单利并列标注，按日计息必须显式声明基准。金额全程整数分，月供取整到分、末期吸收尾差。

信用卡分期「月费率 0.6%」被说成一年 7.2%；分 12 期还，实际成本是**复利 13.84%**——这个差额就是它要量的东西。

工具覆盖一条链路：真实年化 → 摊还表 → 银行计划表核对 → 提前还款 → 多方案对比 → LPR 重定价。
有意不联网、不解析 Excel、不内置 LPR 数据。

## 工具

| 工具 | 做什么 |
|---|---|
| `real_apr` | 月费率、费用 → 月 IRR、单利年化、复利年化 |
| `loan_schedule` | 等额本息 / 等额本金 / 先息后本 / 气球贷 → 逐期摊还表 + 反解 IRR |
| `loan_audit` | 银行还款计划表 → 逐期对差、多收总额、差异归因（利率 / 计息基准 / 舍入） |
| `prepay_audit` | 提前还款 → 省息、违约金、隐含年化、回本期，两种银行方案并列 |
| `apr_compare` | 多个报价 → 统一口径排序，标出最便宜与差额 |
| `lpr_reset` | LPR + 加点 → 新执行利率、新月供、剩余利息变化 |

## 语言

结果表格、结论、警告是**中文**——看这些的是人。工具名、`description`、参数说明、报错是**英文**——
模型据此判断该不该调用、参数怎么填、错在哪。文档中英双语：本文件与 [README.md](README.md)。

## 口径

- 复利 `(1 + 月 IRR)¹² − 1` 是监管口径，放在首位；单利 `月 IRR × 12` 并列显示，两者不混用 — [ADR 0002](docs/adr/0002-annualized-rate-convention.md)
- 按日计息必须声明 `ACT/360`、`ACT/365` 或 `30/360`，没有隐式默认值
- 金额是整数分；每次「利率 × 金额」只舍入一次；逐期本金合计必须精确等于本金
- 只收 CSV/TSV 或粘贴文本，不收 xlsx — [ADR 0003](docs/adr/0003-csv-only-input.md)；LPR 由调用方传入

## 安装

需要 DSH ≥ 0.2.0（见 `engines`）。

```sh
dsh plugin --profile <profile> add dsh-loan-cal
```

## 开发

```sh
git clone https://github.com/aaaLittleCloud/dsh-loan-cal
dsh plugin --profile dev add file:./dsh-loan-cal   # file: 安装是快照

npm test          # 106 个测试，无需网络
npm run check     # 随机输入的不变量自检
```

## 验证

106 个测试，含央行公告附件三个官方算例（4.88% / 单利 5% 与 IRR 5.12% / 单利 12.80% 与 IRR 13.58%）；
另有一组随机输入的不变量自检，覆盖固定用例碰不到的地方：本金分项必须有合计等于本金、每张表必须结清、
有歧义的金额必须拒绝而不是猜。CI 在 Node 22 与 24 上跑这两项，六个工具也都已在真实 profile 里执行过。

## 引用

```bibtex
@software{dsh-loan-cal,
  author = {aaaLittleCloud},
  title  = {dsh-loan-cal: strict-convention loan math for DeepSeek Harness},
  year   = {2026},
  url    = {https://github.com/aaaLittleCloud/dsh-loan-cal}
}
```

> aaaLittleCloud. (2026). *dsh-loan-cal* [计算机软件]. https://github.com/aaaLittleCloud/dsh-loan-cal

## License

MIT
