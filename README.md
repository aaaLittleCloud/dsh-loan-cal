# dsh-loan-cal

严格口径的借贷计算插件，给 DeepSeek Harness 用。

> **状态：阶段 D 完成，六个工具全部实现并实机验证。** 99 个测试通过。下一步是阶段 E（发布）。

## 为什么

模型能背出等额本息公式，但在口径上会算错：日利率除 360 还是 365、IRR 的现金流在期初
还是期末、LPR 重定价后剩余期限怎么重算、提前还款的违约金摊不摊进年化。这些错误看起来
很像正确答案，所以适合交给一个确定性的工具。

## 计划中的工具

| 工具 | 状态 | 输入 | 输出 |
|---|---|---|---|
| `real_apr` | 已实现 | 期数、每期还款或月费率、前置费用 | 月 IRR、名义 / 有效年化、与「月费率 × 12」的差额 |
| `loan_schedule` | 已实现 | 本金、年利率、期数、还款方式、起贷日、计息基准 | 逐期本金利息余额、总利息、整笔 IRR |
| `loan_audit` | 已实现 | 还款计划表（`.csv` / `.tsv` 或粘贴文本；xlsx 需先转 CSV）+ 合同要素 | 逐期差异、多收总额、差异归因 |
| `prepay_audit` | 已实现 | 剩余本金、剩余期数、提前还款额、违约金规则、可选理财收益率 | 省息、净省、两个方案的隐含年化、回本期、与理财对比的结论 |
| `lpr_reset` | 已实现 | 剩余本金、剩余期数、加点（bp）、新 LPR、可选旧 LPR | 新执行利率、新月供、月供与剩余利息变化 |
| `apr_compare` | 已实现 | 2–5 个方案（本金、期数、每期还款或月费率） | 统一口径对比表，按复利年化排序，标出最便宜与差额 |

## 约定

- 纯本地计算：无网络、无 API key、无遥测。
- 金额走定点数（整数分），不用浮点，避免末位差一分；每次 rate × 金额只舍入一次。
- 计息基准显式声明：`ACT/365`、`ACT/360`、`30/360`，不设隐式默认值。
- 年化给两个数：**单利**（月 IRR × 12）与**复利**（(1 + 月 IRR)¹² − 1），默认展示复利——这是
  央行〔2021〕第 3 号要求明示的口径。两个口径不混用，见
  [ADR 0002](docs/adr/0002-annualized-rate-convention.md)。
- **零运行时依赖**：不解析 `.xlsx`，只收 `.csv` / `.tsv` 或粘贴文本；Excel 文件由模型先用表格能力
  转成 CSV 再传入。为什么不自己解析，见 [ADR 0003](docs/adr/0003-csv-only-input.md)。
- **不内置 LPR 数据**：LPR 由调用方传入，工具只做「LPR + 加点 → 新月供」的确定性计算。
  过期快照静默出错，比没有数据更糟。

## 口径基准

年化换算以**中国人民银行公告〔2021〕第 3 号**及其附件《采用内部收益率法计算贷款年化利率示例》
为准，三个官方算例已固化为测试向量（`test/pboc.test.mjs`）：

| 官方算例 | 官方结论 | 本插件 |
|---|---|---|
| 10 万 / 2 年 / 到期还 11 万 | 4.88% | 复利 4.8809% ✅ |
| 100 万 / 240 期 / 月供 6,599.6 | 单利 5% / IRR 5.12% | 单利 5.0001% / 复利 5.1163% ✅ |
| 10 万 / 12 期 / 前置 1,000 / 月还 8,833.3 | 单利 12.80% / IRR 13.58% | 单利 12.8038% / 复利 13.5826% ✅ |

## 安装

```sh
dsh plugin --profile <profile> add dsh-loan-cal
```

## 验证

| 层 | 结果 | 证据 |
|---|---|---|
| 单元 / 集成测试 | ✅ 99 个用例通过 | `npm test`，含央行三个官方算例、日计数边界、四种还款方式、CSV 解析（GBK/表头探测/列映射）、差异归因、提前还款隐含收益率、多方案排序、LPR 重定价、舍入不变量 |
| 打包 | ✅ | `npm pack` 后 12 个文件，`test/`、`docs/` 不进包 |
| 宿主注册 | ✅ 实机 | 装进 `desktop` profile 后，宿主当场接受三份工具 schema |
| 真实调用 | ✅ 实机 | 0.6% 分期 → 复利 13.84% / 单利 13.03%；央行例 3 → 13.58% / 12.80%；30 年房贷 → 单利 3.50% / 复利 3.56%；计划表审计 → 逐期对差与归因 |
| 错误路径 | ✅ 实机 | 缺参数、缺 basis、传 xlsx、表头识别失败，报错均可直接行动 |

未验证：模型能否在**没被提示**的情况下自主选择调用（`description` 的命中率需要真实使用数据）。

## 开发

```sh
npm test          # node --test，99 个用例，无需网络（含央行三个官方算例）
```

**注意：`file:` 安装是快照，不是软链。** pnpm 会把插件拷进 profile，改代码不会自动生效，热重载也不管用。改完必须：

```sh
dsh plugin --profile desktop remove dsh-loan-cal
dsh plugin --profile desktop add file:C:\path\to\dsh-loan-cal
```

`remove` + `add` 会重新挂载并重新导入模块，**不需要重启 DSH**。

实现放 `lib/`（`money.mjs` 金额、`irr.mjs` 现金流求解、`daycount.mjs` 计息基准、
`schedule.mjs` 摊还表、`csv.mjs` 文本解析与列映射、`audit.mjs` 对差与归因、`tools.mjs` 工具层），
在 `index.js` 里通过 `ctx.effect(() => ctx.tools.register(tool), ...)` 注册，这样卸载和热重载都能干净地撤销。

## 发布

推送到 GitHub 有两条路，任选其一。

**A. 用脚本（本机没装 git 也能用）** —— 走 GitHub REST API，一次提交：

```sh
npm test
node scripts/publish-github.mjs --repo dsh-loan-cal          # 先预览会推哪些文件
GITHUB_TOKEN=... node scripts/publish-github.mjs --repo dsh-loan-cal --push
```

Token 需要 `repo` 权限；脚本不会打印它。

**B. 用 git**

```sh
git init -b main
git add -A
git commit -m "dsh-loan-cal 0.1.0"
git remote add origin git@github.com:<you>/dsh-loan-cal.git
git push -u origin main
```

`.github/workflows/test.yml` 会在 push 和 PR 上跑 `node --test`（Node 22 与 24），
并检查 `npm pack` 的内容。

## License

MIT
