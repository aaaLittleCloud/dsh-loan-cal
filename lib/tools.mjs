/**
 * Model-facing tools.
 *
 * Each returns a Markdown document plus the structured numbers behind it: the
 * model reads the Markdown, a panel (later) can read `data`, and neither has to
 * parse the other's format.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { MoneyError, formatAmount, formatCny, roundHalfUp, toCents } from './money.mjs';
import { IrrError, aprFromInstallment, annualizeEffective, annualizeNominal, monthlyIrr } from './irr.mjs';
import { METHODS, METHOD_IDS, ScheduleError, buildSchedule } from './schedule.mjs';
import {
  ROLES, ROLE_IDS, coerceRows, decodeText, detectDelimiter, findHeader, parseDelimited, scoreHeaderRow, validateMapping,
} from './csv.mjs';
import { AuditError, auditSchedule } from './audit.mjs';
import { PrepayError, planPrepayment } from './prepay.mjs';
import { CompareError, compareOffers } from './compare.mjs';
import { LprError, resetRate } from './lpr.mjs';

const pct = (ratio) => `${(ratio * 100).toFixed(2)}%`;

/* ------------------------------------------------------------------ real APR */

function realAprMarkdown(view) {
  const lines = [];
  lines.push(`**复利年化 ${pct(view.result.effectiveApr)}**（IRR，监管口径）`);
  lines.push('');
  lines.push('| 项目 | 数值 |');
  lines.push('|---|---|');
  lines.push(`| 本金 | ${formatCny(view.result.principalCents)} |`);
  if (view.result.upfrontFeeCents > 0) {
    lines.push(`| 前置费用 | ${formatCny(view.result.upfrontFeeCents)} |`);
    lines.push(`| 实际到手 | ${formatCny(view.result.netProceeds)} |`);
  }
  lines.push(`| 期数 | ${view.result.periods} 期 |`);
  lines.push(`| 每期还款 | ${formatCny(view.result.paymentCents)} |`);
  lines.push(`| 总还款 | ${formatCny(view.result.totalRepay)} |`);
  lines.push(`| 总成本 | ${formatCny(view.result.totalCost)} |`);
  lines.push(`| 月 IRR | ${(view.result.monthlyRate * 100).toFixed(4)}% |`);
  lines.push(`| 复利年化（(1+月 IRR)¹²−1，监管口径） | ${pct(view.result.effectiveApr)} |`);
  lines.push(`| 单利年化（月 IRR × 12） | ${pct(view.result.nominalApr)} |`);
  if (view.result.naiveAnnual !== null) {
    lines.push(`| ${view.naiveLabel} | ${pct(view.result.naiveAnnual)} |`);
    lines.push(`| 差额（复利 − 业务员口径） | ${(view.result.gapPoints * 100).toFixed(2)} 个百分点 |`);
  }
  lines.push('');
  lines.push(`> 口径：${view.basisNote}`);
  lines.push('> 依据中国人民银行公告〔2021〕第 3 号：年化利率按 IRR（复利）计，用单利须声明；两个口径不得混用。');
  lines.push('> 只做数学换算，不构成法律或投资建议。');
  return lines.join('\n');
}

const realAprTool = {
  name: 'real_apr',
  description:
    'Convert a loan or installment plan into its true annual cost. Takes principal, term and either the payment per period or the quoted monthly fee rate, ' +
    'and returns the monthly IRR, the COMPOUNDED annual rate (the number the PBOC requires lenders to disclose), the simple annual rate (monthly IRR × 12, comparable with mortgage/LPR quotes), ' +
    'and the gap against the "monthly fee × 12" number a salesperson quotes. ' +
    'Use for credit-card installments, consumer loans, 花呗/白条-style plans, or any offer described as a "月费率".',
  parameters: {
    type: 'object',
    properties: {
      principal: { type: 'number', description: 'Amount borrowed / financed, in yuan (元).' },
      periods: { type: 'integer', description: 'Number of installments (期), 1–600.' },
      payment: { type: 'number', description: 'Fixed payment per period, in yuan. Mutually exclusive with monthlyFeeRate.' },
      monthlyFeeRate: {
        type: 'number',
        description: 'Quoted monthly fee rate as a percentage (0.6 means 0.6%/month, 等本等费). Mutually exclusive with payment.',
      },
      upfrontFee: { type: 'number', description: 'One-off fee deducted at disbursement, in yuan. Default 0.' },
    },
    required: ['principal', 'periods'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['markdown'],
    },
    render: (_args, value) => [{ type: 'text', text: value.markdown }],
  },
  async execute(args) {
    const principalCents = toCents(args?.principal, 'principal');
    const periods = args?.periods;
    if (!Number.isInteger(periods)) throw new MoneyError('periods must be an integer');
    const upfrontFeeCents = args?.upfrontFee === undefined ? 0 : toCents(args.upfrontFee, 'upfrontFee');

    const hasPayment = args?.payment !== undefined && args?.payment !== null;
    const hasFeeRate = args?.monthlyFeeRate !== undefined && args?.monthlyFeeRate !== null;
    if (hasPayment === hasFeeRate) {
      throw new MoneyError('pass exactly one of payment (yuan per period) or monthlyFeeRate (percent per month), not both and not neither');
    }

    let paymentCents;
    let monthlyFeeRate = null;
    let naiveLabel;
    if (hasPayment) {
      paymentCents = toCents(args.payment, 'payment');
      naiveLabel = '业务员口径（总成本摊年）';
    } else {
      const rate = Number(args.monthlyFeeRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        throw new MoneyError('monthlyFeeRate must be a percentage between 0 and 100');
      }
      monthlyFeeRate = rate / 100;
      // 等本等费: principal spread flat, fee charged on the original principal
      // every period, each half rounded to fen the way the lender's table would be.
      paymentCents = roundHalfUp(principalCents / periods, 0) + roundHalfUp(principalCents * monthlyFeeRate, 0);
      naiveLabel = '业务员口径（月费率 × 12）';
    }

    const result = aprFromInstallment({
      principalCents,
      periods,
      paymentCents,
      upfrontFeeCents,
      monthlyFeeRate,
    });

    const basisNote = hasPayment
      ? 'IRR 按期末等额现金流、按月求解；单利年化 = 月 IRR × 12，复利年化 = (1 + 月 IRR)¹² − 1。'
      : 'IRR 按期末等额现金流、按月求解；每期还款 = 本金/期数 + 本金×月费率（等本等费）；单利年化 = 月 IRR × 12，复利年化 = (1 + 月 IRR)¹² − 1。';

    const view = { result, naiveLabel, basisNote };
    return { markdown: realAprMarkdown(view), data: { ...result, mode: hasPayment ? 'payment' : 'feeRate' } };
  },
  presentCall: (args) => ({ card: 'generic', title: `年化利率：${formatCny(toCents(args?.principal ?? 0, 'principal'))}` }),
};

/* ------------------------------------------------------------ loan schedule */

function scheduleTable(rows, limit) {
  const lines = [];
  lines.push('| 期 | 还款日 | 还款 | 利息 | 本金 | 余额 |');
  lines.push('|---:|---|---:|---:|---:|---:|');
  const render = (row) => `| ${row.period} | ${row.dueDate ?? '—'} | ${formatAmount(row.paymentCents)} | ${formatAmount(row.interestCents)} | ${formatAmount(row.principalCents)} | ${formatAmount(row.balanceCents)} |`;

  if (rows.length <= limit) {
    for (const row of rows) lines.push(render(row));
    return lines;
  }
  const head = Math.max(1, limit - 3);
  for (const row of rows.slice(0, head)) lines.push(render(row));
  lines.push(`| … | 共 ${rows.length} 期，隐藏 ${rows.length - head - 3} 期 | | | | |`);
  for (const row of rows.slice(-3)) lines.push(render(row));
  return lines;
}

function scheduleMarkdown(view) {
  const { schedule, irr, rowsLimit } = view;
  const lines = [];
  lines.push(`**${schedule.methodLabel} · ${schedule.periods} 期 · 单利 ${pct(irr.nominalApr)} / 复利 ${pct(irr.effectiveApr)}（监管口径）**`);
  lines.push('');
  const summary = [];
  if (schedule.paymentCents !== null) summary.push(`每期还款 ${formatCny(schedule.paymentCents)}`);
  summary.push(`总还款 ${formatCny(schedule.totals.paymentCents)}`);
  summary.push(`总利息 ${formatCny(schedule.totals.interestCents)}`);
  lines.push(summary.join(' · '));
  lines.push('');
  lines.push(...scheduleTable(schedule.rows, rowsLimit));
  lines.push('');
  const clock = schedule.convention.interestClock === 'daily'
    ? `按日计息，基准 ${schedule.convention.basis}（${schedule.convention.basisLabel}）`
    : `按月利率（年利率/12 = ${(schedule.convention.monthlyRate * 100).toFixed(6)}%）计息`;
  lines.push(`> 口径：${clock}；末期吸收逐期舍入差额，故末期金额可能与常规不同。`);
  if (schedule.paymentCents !== null) {
    lines.push('> 月供按「分」取整后逐期计息（银行做法），与不取整的官网计算器可能有几元差异。');
  }
  lines.push(`> 由现金流反解：月 IRR ${(irr.monthlyRate * 100).toFixed(4)}% → 单利 ${pct(irr.nominalApr)} / 复利 ${pct(irr.effectiveApr)}。`);
  lines.push('> 单利（月 IRR × 12）与房贷、LPR 报价可比；复利（IRR，央行〔2021〕第 3 号要求明示）更适合跨产品比较。');
  for (const warning of schedule.warnings) lines.push(`> ⚠️ ${warning}`);
  lines.push('> 只做数学换算，不构成法律或投资建议。');
  return lines.join('\n');
}

const loanScheduleTool = {
  name: 'loan_schedule',
  description:
    'Build a full amortisation table for a loan: equal installment (等额本息), equal principal (等额本金), interest-only (先息后本) or a balloon (气球贷). ' +
    'Returns every period (payment / interest / principal / balance), the totals, and the IRR implied by the cash flows. ' +
    'Use to check what a bank quoted, to see how much of the early payments is interest, or to compare repayment shapes.',
  parameters: {
    type: 'object',
    properties: {
      principal: { type: 'number', description: 'Loan amount in yuan (元).' },
      annualRate: { type: 'number', description: 'Annual interest rate as a percentage (3.5 means 3.5%).' },
      periods: { type: 'integer', description: 'Number of payments (期), 1–600. Monthly periods only.' },
      method: {
        type: 'string',
        enum: METHOD_IDS,
        description: `Repayment shape: ${METHOD_IDS.map((id) => `${id} (${METHODS[id]})`).join(', ')}. Default equal-installment.`,
      },
      startDate: { type: 'string', description: 'First period start, YYYY-MM-DD. Required for interest-only; optional otherwise (dates are then omitted).' },
      basis: {
        type: 'string',
        enum: ['ACT/365', 'ACT/360', '30/360'],
        description: 'Day-count basis. Required for interest-only (daily accrual); ignored — and reported as ignored — for the monthly methods.',
      },
      balloonOver: { type: 'integer', description: 'Balloon only: amortise over this many periods while paying only `periods` of them.' },
      rows: { type: 'integer', description: 'How many rows to print in the Markdown table (default 8, max 60). `data.rows` always has all periods.' },
    },
    required: ['principal', 'annualRate', 'periods'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['markdown'],
    },
    render: (_args, value) => [{ type: 'text', text: value.markdown }],
  },
  async execute(args) {
    const principalCents = toCents(args?.principal, 'principal');
    const ratePercent = Number(args?.annualRate);
    if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) {
      throw new ScheduleError('annualRate must be a percentage between 0 and 100');
    }
    const periods = args?.periods;
    if (!Number.isInteger(periods)) throw new ScheduleError('periods must be an integer');
    const rowsLimit = Math.max(1, Math.min(Number(args?.rows) || 8, 60));

    const schedule = buildSchedule({
      principalCents,
      annualRate: ratePercent / 100,
      periods,
      method: args?.method,
      startDate: args?.startDate ?? null,
      basis: args?.basis ?? null,
      balloonOver: args?.balloonOver ?? null,
    });

    const flows = [-principalCents, ...schedule.rows.map((row) => row.paymentCents)];
    const monthlyRate = monthlyIrr(flows);
    const irr = {
      monthlyRate,
      nominalApr: annualizeNominal(monthlyRate),
      effectiveApr: annualizeEffective(monthlyRate),
    };

    return {
      markdown: scheduleMarkdown({ schedule, irr, rowsLimit }),
      data: { ...schedule, irr },
    };
  },
  presentCall: (args) => ({ card: 'generic', title: `还款计划：${formatCny(toCents(args?.principal ?? 0, 'principal'))} / ${args?.periods ?? '?'} 期` }),
};

/* --------------------------------------------------------------- loan audit */

const PREVIEW_ROWS = 8;
const PREVIEW_COLUMNS = 12;

/** Read the table text, refusing binary formats with an actionable message. */
function loadScheduleText(args) {
  const csvText = typeof args?.csvText === 'string' && args.csvText.trim() !== '' ? args.csvText : null;
  const path = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : null;
  if (csvText !== null && path !== null) throw new AuditError('pass either path or csvText, not both');
  if (csvText !== null) return { text: csvText, source: { kind: 'text' } };
  if (path === null) throw new AuditError('pass a path to a .csv/.tsv file, or the table as csvText');

  const ext = extname(path).toLowerCase();
  if (['.xlsx', '.xls', '.xlsm', '.xlsb'].includes(ext)) {
    throw new AuditError(
      'Excel files are not supported (ADR 0003). Convert the sheet to CSV text first and pass it as csvText, or ask the user to save it as CSV.',
    );
  }

  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new AuditError(`读不到文件：${path}（${error?.message ?? error}）`);
  }
  const { text, encoding } = decodeText(bytes);
  return { text, source: { kind: ext === '.tsv' ? 'tsv' : 'csv', path, encoding } };
}

/** Markdown grid of the first rows, so the model can see what it is mapping. */
function previewMarkdown(rows) {
  const width = Math.max(...rows.slice(0, PREVIEW_ROWS).map((row) => row.length), 1);
  const columns = Math.min(width, PREVIEW_COLUMNS);
  const header = ['行', ...Array.from({ length: columns }, (_, index) => String.fromCharCode(65 + index))];
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (let index = 0; index < Math.min(rows.length, PREVIEW_ROWS); index += 1) {
    const cells = Array.from({ length: columns }, (_, column) => {
      const value = String(rows[index][column] ?? '').replace(/\|/g, '\\|').slice(0, 24);
      return value;
    });
    lines.push(`| ${index + 1} | ${cells.join(' | ')} |`);
  }
  return lines;
}

function needsMappingMarkdown({ source, rows, candidates, errors }) {
  const lines = [];
  lines.push('**无法自动识别表头**，需要你指定列的位置。');
  lines.push('');
  lines.push(`来源：${source.kind}${source.path ? ` · ${source.path}` : ''} · 共 ${rows.length} 行`);
  if (errors !== undefined && errors.length > 0) {
    lines.push('');
    lines.push('上一次的列映射没有通过校验：');
    for (const error of errors) lines.push(`- ${error.message}`);
  }
  lines.push('');
  lines.push(`前 ${Math.min(rows.length, PREVIEW_ROWS)} 行：`);
  lines.push('');
  lines.push(...previewMarkdown(rows));
  lines.push('');
  if (candidates.length > 0) {
    lines.push(`可能是表头的行：${candidates.map((candidate) => `第 ${candidate.index + 1} 行`).join('、')}`);
    lines.push('');
  }
  lines.push('请任选一种方式继续：');
  lines.push('1. `headerRow`：表头在第几行（从 1 开始），我用默认列名规则解析；');
  lines.push('2. `columns`：直接给角色到列的映射，例如 `{"period":"A","principal":"C","interest":"D","balance":"F"}`；');
  lines.push('3. 把表整理成三列文本（期次、本金、利息）通过 `csvText` 传回。');
  lines.push('');
  lines.push(`合法角色：${ROLE_IDS.map((role) => `${role}${ROLES[role].required ? '（必填）' : '（可选）'}`).join('、')}`);
  return lines.join('\n');
}

function auditMarkdown({ audit, contract, source }) {
  const lines = [];
  const verdict = audit.verdict;
  if (verdict === 'match') {
    lines.push('**结论：与合同口径一致**（逐期差异均 ≤ 1 分）');
  } else if (verdict === 'mismatch') {
    const diff = audit.totals.interestDiffCents;
    const direction = diff > 0 ? '多收' : '少收';
    lines.push(`**结论：${direction}利息 ${formatCny(Math.abs(diff))}**（共 ${audit.rows.filter((row) => row.diff.interestCents !== null).length} 期，最早第 ${audit.firstDiffPeriod ?? '?'} 期开始不一致）`);
  } else {
    lines.push('**结论：无法完整比对**（文件期数与合同不符）');
  }
  lines.push('');
  if (audit.cause !== null) {
    lines.push(`**主因：${audit.cause.title}**（置信度 ${audit.cause.confidence}）`);
    lines.push('');
    lines.push(audit.cause.detail);
    lines.push('');
  }

  const changed = audit.rows.filter((row) => row.diff.interestCents !== null
    && (Math.abs(row.diff.interestCents) > 1 || Math.abs(row.diff.paymentCents ?? 0) > 1));
  const sample = changed.length === 0
    ? (audit.rows.length > 4 ? [...audit.rows.slice(0, 3), null, audit.rows.at(-1)] : audit.rows.slice())
    : changed.slice(0, 8);

  if (sample.length > 0) {
    lines.push('| 期 | 还款日 | 文件利息 | 重算利息 | 差 | 文件余额 |');
    lines.push('|---:|---|---:|---:|---:|---:|');
    for (const row of sample) {
      if (row === null) {
        lines.push(`| … | 省略 ${audit.rows.length - 4} 期（差异均为 0） | | | | |`);
        continue;
      }
      lines.push(`| ${row.period} | ${row.dueDate ?? '—'} | ${row.actual?.interestCents != null ? formatAmount(row.actual.interestCents) : '—'} | ${row.expected?.interestCents != null ? formatAmount(row.expected.interestCents) : '—'} | ${row.diff.interestCents != null ? formatAmount(row.diff.interestCents) : '—'} | ${row.actual?.balanceCents != null ? formatAmount(row.actual.balanceCents) : '—'} |`);
    }
    if (changed.length > sample.length) lines.push(`| … | 另有 ${changed.length - sample.length} 期有差异 | | | | |`);
  }

  lines.push('');
  lines.push(`> 合同：本金 ${formatCny(contract.principalCents)} · 年利率 ${(contract.annualRate * 100).toFixed(4)}% · ${contract.periods} 期 · ${METHODS[contract.method]}`);
  lines.push(`> 文件利息合计 ${formatCny(audit.totals.actualInterestCents)}，按合同重算 ${formatCny(audit.totals.expectedInterestCents)}。`);
  if (source.kind === 'text') lines.push('> 数据由文本传入，请对照原表核对。');
  for (const warning of audit.warnings) lines.push(`> ⚠️ ${warning}`);
  lines.push('> 只做数学换算，不构成法律或投资建议。');
  return lines.join('\n');
}

const loanAuditTool = {
  name: 'loan_audit',
  description:
    'Audit a bank repayment schedule against a strict recomputation: reads a CSV/TSV table (or pasted text), finds the header, ' +
    'rebuilds the schedule from the contract terms, diffs every period, and names the likely cause (rate, day-count basis, rounding). ' +
    'Excel files are NOT accepted — convert .xlsx to CSV text first (via spreadsheet tooling) and pass it as csvText. ' +
    'Use when someone suspects their loan statement does not match the contract.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to a .csv / .tsv schedule file. Mutually exclusive with csvText.' },
      csvText: { type: 'string', description: 'The table as text (headers included). Use this for converted .xlsx.' },
      headerRow: { type: 'integer', description: '1-based row holding the header. Omit to auto-detect within the first 10 rows.' },
      columns: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Explicit role → column mapping, e.g. {"period":"A","principal":"C","interest":"D","balance":"F"}. Roles: period, principal, interest (required), payment, balance, dueDate (optional).',
      },
      principal: { type: 'number', description: 'Contract principal in yuan (元).' },
      annualRate: { type: 'number', description: 'Contract annual rate as a percentage (3.5 means 3.5%).' },
      periods: { type: 'integer', description: 'Contract number of periods.' },
      method: { type: 'string', enum: METHOD_IDS, description: 'Repayment shape used by the recomputation. Default equal-installment.' },
      startDate: { type: 'string', description: 'First period start, YYYY-MM-DD. Needed for daily-accrual methods.' },
      basis: { type: 'string', enum: ['ACT/365', 'ACT/360', '30/360'], description: 'Day-count basis the contract says. Required by interest-only.' },
      rows: { type: 'integer', description: 'How many differing periods to print (default 8, max 40).' },
    },
    // Nothing is individually required: either `path` or `csvText` must be given,
    // which JSON Schema can only express with oneOf — the tool validates it and
    // says exactly which input shape it needs.
    required: [],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        status: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['markdown'],
    },
    render: (_args, value) => [{ type: 'text', text: value.markdown }],
  },
  async execute(args) {
    const { text, source } = loadScheduleText(args);

    const delimiter = detectDelimiter(text);
    const rows = parseDelimited(text, delimiter);
    if (rows.length < 2) throw new AuditError('the table needs a header row and at least one data row');

    const candidates = [];
    for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
      const scored = scoreHeaderRow(rows[index]);
      if (scored.essential >= 2) candidates.push({ index, ...scored });
    }

    // Where is the header, and how do roles map to columns?
    let headerIndex;
    let mapping;
    let mappingErrors = [];

    if (args?.columns !== undefined && args?.columns !== null) {
      headerIndex = Number.isInteger(args?.headerRow) ? args.headerRow - 1 : (findHeader(rows)?.index ?? 0);
      const validated = validateMapping(args.columns, rows[headerIndex] ?? []);
      mappingErrors = validated.errors;
      mapping = validated.resolved;
    } else if (Number.isInteger(args?.headerRow)) {
      headerIndex = args.headerRow - 1;
      mapping = scoreHeaderRow(rows[headerIndex] ?? []).mapping;
      if (mapping.period === undefined || mapping.principal === undefined || mapping.interest === undefined) {
        mappingErrors = [{ code: 'missing_role', message: `第 ${args.headerRow} 行的列名不足以识别必需角色，请用 columns 显式指定` }];
      }
    } else {
      const found = findHeader(rows);
      headerIndex = found?.index ?? -1;
      mapping = found?.mapping ?? {};
    }

    if (headerIndex < 0 || mappingErrors.length > 0) {
      return {
        status: 'needs_mapping',
        markdown: needsMappingMarkdown({ source, rows, candidates, errors: mappingErrors }),
        data: {
          status: 'needs_mapping',
          source,
          headerCandidates: candidates.map((candidate) => candidate.index + 1),
          roles: Object.fromEntries(ROLE_IDS.map((role) => [role, ROLES[role]])),
          errors: mappingErrors,
        },
      };
    }

    const { records, warnings } = coerceRows(rows, headerIndex, mapping);
    if (records.length === 0) throw new AuditError('no parsable data rows after the header');

    if (args?.principal === undefined || args?.annualRate === undefined || args?.periods === undefined) {
      return {
        status: 'needs_contract',
        markdown: [
          '**表格解析成功**，但还缺合同要素，无法重算对比。',
          '',
          `已识别：${records.length} 期，表头在第 ${headerIndex + 1} 行。`,
          '',
          '请补充：`principal`（本金，元）、`annualRate`（年利率，%）、`periods`（期数）；',
          '若为日计息产品还需 `startDate` 与 `basis`。',
          ...(warnings.length > 0 ? ['', '解析提示：', ...warnings.map((warning) => `- ${warning}`)] : []),
        ].join('\n'),
        data: { status: 'needs_contract', source, headerRow: headerIndex + 1, parsedPeriods: records.length, warnings },
      };
    }

    const method = METHODS[args?.method] !== undefined ? args.method
      : (METHOD_IDS.includes(args?.method) ? args.method : 'equal-installment');
    const contract = {
      principalCents: toCents(args.principal, 'principal'),
      annualRate: Number(args.annualRate) / 100,
      periods: args.periods,
      method,
      startDate: args?.startDate ?? null,
      basis: args?.basis ?? null,
    };

    const audit = auditSchedule({ records, contract });
    audit.warnings.unshift(...warnings);

    return {
      status: 'ok',
      markdown: auditMarkdown({ audit, contract, source }),
      data: { ...audit, source, headerRow: headerIndex + 1, mapping },
    };
  },
  presentCall: (args) => ({ card: 'generic', title: `还款计划审计：${args?.path ?? '粘贴文本'}` }),
};

/* ------------------------------------------------------------ prepayment */

function prepayMarkdown(result, view) {
  const money = (cents) => (cents === null || cents === undefined ? '—' : formatCny(cents));
  const pct = (ratio) => (ratio === null || ratio === undefined ? '—' : `${(ratio * 100).toFixed(4)}%`);
  const lines = [];

  const hero = result.fullPayoff
    ? `**结论：一次性还清，省息 ${formatCny(result.reduceTerm.savedInterestCents)}**`
    : `**结论：提前还 ${formatCny(result.prepayCents)}，净省 ${formatCny(result.reduceTerm.netSavingCents)}**（缩短期限方案）`;
  lines.push(hero);
  lines.push('');
  lines.push('| | 缩短期限（月供不变） | 减少月供（期限不变） |');
  lines.push('|---|---:|---:|');
  lines.push(`| 新月供 | ${money(result.reduceTerm.paymentCents)} | ${money(result.reducePayment.paymentCents)} |`);
  lines.push(`| 剩余期数 | ${result.reduceTerm.periods} | ${result.reducePayment.periods} |`);
  lines.push(`| 剩余总利息 | ${money(result.reduceTerm.interestCents)} | ${money(result.reducePayment.interestCents)} |`);
  lines.push(`| 省息 | ${money(result.reduceTerm.savedInterestCents)} | ${money(result.reducePayment.savedInterestCents)} |`);
  lines.push(`| 违约金 | ${money(result.penaltyCents)} | ${money(result.penaltyCents)} |`);
  lines.push(`| **净省** | **${money(result.reduceTerm.netSavingCents)}** | **${money(result.reducePayment.netSavingCents)}** |`);
  lines.push(`| 单利年化（隐含收益） | ${pct(result.reduceTerm.impliedReturn?.nominalApr)} | ${pct(result.reducePayment.impliedReturn?.nominalApr)} |`);
  lines.push(`| 复利年化（监管口径） | ${pct(result.reduceTerm.impliedReturn?.effectiveApr)} | ${pct(result.reducePayment.impliedReturn?.effectiveApr)} |`);
  lines.push(`| 回本期数 | ${result.reduceTerm.paybackPeriods ?? '—'} | ${result.reducePayment.paybackPeriods ?? '—'} |`);
  lines.push('');

  lines.push(`> 基准：剩余本金 ${money(result.baseline.principalCents)} · ${(view.annualRate * 100).toFixed(4)}% · 剩 ${result.baseline.periods} 期 · 月供 ${money(result.baseline.paymentCents)} · 剩余总利息 ${money(result.baseline.interestCents)}。`);
  lines.push('> 两个「年化」是这笔提前还款的隐含收益率：把钱留着理财，收益率要超过它，才比提前还划算。');
  if (result.comparison !== null) {
    lines.push(`> ${result.comparison.note}`);
    for (const [key, label] of [['reduceTerm', '缩短期限'], ['reducePayment', '减少月供']]) {
      const verdict = result.comparison[key];
      const text = verdict.verdict === 'prepay-wins' ? '提前还款更划算' : verdict.verdict === 'invest-wins' ? '理财更划算' : '无法比较';
      lines.push(`> ${label}：${text}（差 ${verdict.gapPoints === null ? '—' : `${(verdict.gapPoints * 100).toFixed(2)} 个百分点`}）。`);
    }
  }
  for (const warning of result.warnings) lines.push(`> ⚠️ ${warning}`);
  lines.push('> 未考虑税费、流动性、理财风险，以及提前还款后的资金需求。');
  lines.push('> 只做数学换算，不构成法律或投资建议。');
  return lines.join('\n');
}

const prepayAuditTool = {
  name: 'prepay_audit',
  description:
    'Decide whether prepaying a loan is worth it: given the outstanding principal, remaining term and rate, compute the interest saved, the penalty paid, ' +
    'and the implied annual return of the prepayment under both bank options (shorten the term vs reduce the instalment). ' +
    'The implied return is the number to compare against an investment yield — if the loan costs more than the investment earns, prepaying wins. ' +
    'Use for "should I pay off part of my mortgage early" questions.',
  parameters: {
    type: 'object',
    properties: {
      remainingPrincipal: { type: 'number', description: 'Outstanding principal today, in yuan.' },
      annualRate: { type: 'number', description: 'Contract annual rate as a percentage (4.9 means 4.9%).' },
      remainingPeriods: { type: 'integer', description: 'Periods left on the contract (1–600).' },
      prepay: { type: 'number', description: 'Amount repaid early, today, in yuan.' },
      penalty: { type: 'number', description: 'Penalty in yuan, if the contract charges a fixed amount.' },
      penaltyRate: { type: 'number', description: 'Penalty as a percentage of the prepaid amount (1 means 1%).' },
      penaltyMonths: { type: 'number', description: 'Penalty expressed as N months of interest (common in Chinese mortgages: 1–3).' },
      compareYield: { type: 'number', description: 'Alternative annual investment yield as a percentage, e.g. 2.5. Optional.' },
      strategy: {
        type: 'string',
        enum: ['both', 'reduce-term', 'reduce-payment'],
        description: 'Which bank option to highlight. Default both.',
      },
    },
    required: ['remainingPrincipal', 'annualRate', 'remainingPeriods', 'prepay'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['markdown'],
    },
    render: (_args, value) => [{ type: 'text', text: value.markdown }],
  },
  async execute(args) {
    const annualRate = Number(args?.annualRate) / 100;
    if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 1) {
      throw new PrepayError('annualRate must be a percentage between 0 and 100');
    }
    const remainingPrincipalCents = toCents(args?.remainingPrincipal, 'remainingPrincipal');
    const prepayCents = toCents(args?.prepay, 'prepay');
    const remainingPeriods = args?.remainingPeriods;
    if (!Number.isInteger(remainingPeriods)) throw new PrepayError('remainingPeriods must be an integer');

    const given = ['penalty', 'penaltyRate', 'penaltyMonths'].filter((key) => args?.[key] !== undefined && args?.[key] !== null);
    if (given.length > 1) throw new PrepayError('pass only one of penalty, penaltyRate or penaltyMonths');

    let penaltyCents = 0;
    if (args?.penalty !== undefined && args?.penalty !== null) {
      penaltyCents = toCents(args.penalty, 'penalty');
    } else if (args?.penaltyRate !== undefined && args?.penaltyRate !== null) {
      const rate = Number(args.penaltyRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new PrepayError('penaltyRate must be a percentage between 0 and 100');
      penaltyCents = roundHalfUp(prepayCents * (rate / 100), 0);
    } else if (args?.penaltyMonths !== undefined && args?.penaltyMonths !== null) {
      const months = Number(args.penaltyMonths);
      if (!Number.isFinite(months) || months < 0 || months > 12) throw new PrepayError('penaltyMonths must be between 0 and 12');
      const baseline = buildSchedule({ principalCents: remainingPrincipalCents, annualRate, periods: remainingPeriods });
      penaltyCents = roundHalfUp(baseline.rows[0].interestCents * months, 0);
    }

    const compareYield = args?.compareYield === undefined || args?.compareYield === null
      ? null : Number(args.compareYield) / 100;

    const result = planPrepayment({
      remainingPrincipalCents,
      annualRate,
      remainingPeriods,
      prepayCents,
      penaltyCents,
      compareYield,
    });

    const view = { annualRate, strategy: args?.strategy ?? 'both' };
    return { markdown: prepayMarkdown(result, view), data: result };
  },
  presentCall: (args) => ({ card: 'generic', title: `提前还款：${formatCny(toCents(args?.prepay ?? 0, 'prepay'))}` }),
};

/* ---------------------------------------------------------------- compare */

function compareMarkdown(result) {
  const pct = (ratio) => `${(ratio * 100).toFixed(2)}%`;
  const lines = [];
  lines.push(`**最便宜：${result.cheapest.name} ${pct(result.cheapest.effectiveApr)}**（复利口径），比最贵的 ${result.mostExpensive.name} 低 ${(result.spreadPoints * 100).toFixed(2)} 个百分点`);
  lines.push('');
  lines.push('| 排名 | 方案 | 本金 | 期数 | 每期还款 | 总成本 | 单利 | 复利（监管口径） |');
  lines.push('|---:|---|---:|---:|---:|---:|---:|---:|');
  for (const row of result.rows) {
    lines.push(`| ${row.rank} | ${row.name} | ${formatCny(row.principalCents)} | ${row.periods} | ${formatCny(row.paymentCents)} | ${formatCny(row.totalCostCents)} | ${pct(row.nominalApr)} | **${pct(row.effectiveApr)}** |`);
  }
  lines.push('');
  lines.push('> 排序依据是复利年化（央行〔2021〕第 3 号要求明示的口径）；单利列用于和房贷、LPR 等名义报价对照。');
  for (const warning of result.warnings) lines.push(`> ⚠️ ${warning}`);
  lines.push('> 只做数学换算，不构成法律或投资建议。');
  return lines.join('\n');
}

const aprCompareTool = {
  name: 'apr_compare',
  description:
    'Compare two or more loan offers on one yardstick: each offer (principal, term, payment or monthly fee rate) is converted to its monthly IRR, ' +
    'and they are ranked by the compounded annual rate the PBOC requires to be disclosed. ' +
    'Use when someone has several quotes — bank vs consumer finance vs card installment — and wants to know which is actually cheapest.',
  parameters: {
    type: 'object',
    properties: {
      offers: {
        type: 'array',
        minItems: 2,
        description: 'Two or more offers to rank.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Label for this offer, e.g. "A 银行". Optional.' },
            principal: { type: 'number', description: 'Amount financed, in yuan.' },
            periods: { type: 'integer', description: 'Number of installments (期).' },
            payment: { type: 'number', description: 'Fixed payment per period, in yuan. Mutually exclusive with monthlyFeeRate.' },
            monthlyFeeRate: { type: 'number', description: 'Quoted monthly fee rate as a percentage (0.6 means 0.6%/month).' },
            upfrontFee: { type: 'number', description: 'One-off fee deducted at disbursement, in yuan.' },
          },
          required: ['principal', 'periods'],
          additionalProperties: false,
        },
      },
    },
    required: ['offers'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['markdown'],
    },
    render: (_args, value) => [{ type: 'text', text: value.markdown }],
  },
  async execute(args) {
    const offers = args?.offers;
    if (!Array.isArray(offers)) throw new CompareError('offers must be an array');
    const normalized = offers.map((offer, index) => {
      const label = typeof offer?.name === 'string' && offer.name.trim() !== '' ? offer.name.trim() : `方案 ${index + 1}`;
      const hasFeeRate = offer?.monthlyFeeRate !== undefined && offer?.monthlyFeeRate !== null;
      if (hasFeeRate) {
        const rate = Number(offer.monthlyFeeRate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
          throw new CompareError(`${label}：monthlyFeeRate 必须是 0–100 的百分数`);
        }
        return {
          name: label,
          principalCents: toCents(offer.principal, `${label} principal`),
          periods: offer.periods,
          monthlyFeeRate: rate / 100,
          upfrontFeeCents: offer?.upfrontFee === undefined ? 0 : toCents(offer.upfrontFee, `${label} upfrontFee`),
        };
      }
      return {
        name: label,
        principalCents: toCents(offer?.principal, `${label} principal`),
        periods: offer?.periods,
        paymentCents: toCents(offer?.payment, `${label} payment`),
        upfrontFeeCents: offer?.upfrontFee === undefined ? 0 : toCents(offer.upfrontFee, `${label} upfrontFee`),
      };
    });

    const result = compareOffers({ offers: normalized });
    return { markdown: compareMarkdown(result), data: result };
  },
  presentCall: () => ({ card: 'generic', title: '多方案年化对比' }),
};

/* ------------------------------------------------------------- rate reset */

function lprMarkdown(result) {
  const pct = (ratio) => `${(ratio * 100).toFixed(4)}%`;
  const lines = [];
  const hasBefore = result.oldPaymentCents !== null;
  const delta = result.paymentDeltaCents;

  if (hasBefore) {
    const direction = delta < 0 ? '少' : '多';
    lines.push(`**新月供 ${formatCny(result.paymentCents)}**（比调整前${direction} ${formatCny(Math.abs(delta))}）`);
  } else {
    lines.push(`**新月供 ${formatCny(result.paymentCents)}**`);
  }
  lines.push('');
  lines.push(`利率 **${pct(result.newRate)}** = LPR ${pct(result.newLpr)} + 加点 ${result.spreadBp}bp`);
  lines.push('');
  lines.push('| 项目 | 调整前 | 调整后 |');
  lines.push('|---|---:|---:|');
  lines.push(`| LPR | ${result.oldLpr === null ? '—' : pct(result.oldLpr)} | ${pct(result.newLpr)} |`);
  lines.push(`| 执行利率 | ${result.oldRate === null ? '—' : pct(result.oldRate)} | ${pct(result.newRate)} |`);
  lines.push(`| 月供 | ${result.oldPaymentCents === null ? '—' : formatCny(result.oldPaymentCents)} | ${formatCny(result.paymentCents)} |`);
  lines.push(`| 剩余总利息 | ${result.oldInterestCents === null ? '—' : formatCny(result.oldInterestCents)} | ${formatCny(result.interestCents)} |`);
  if (result.interestDeltaCents !== null) {
    lines.push(`| 利息变化 | | ${result.interestDeltaCents < 0 ? '−' : '+'}${formatCny(Math.abs(result.interestDeltaCents))} |`);
  }
  lines.push('');
  lines.push(`> 基准：剩余本金 ${formatCny(result.principalCents)} · 剩余 ${result.periods} 期 · 等额本息。`);
  lines.push(`> 加点 ${result.spreadBp}bp（${pct(result.spreadBp / 10_000)}）在贷款期内固定，只有 LPR 随重定价变动。`);
  lines.push('> 重定价日所在的那一期，银行通常按新旧利率分段计息，实际首期金额会与新月供略有差异。');
  lines.push('> 本工具不内置 LPR 数据，LPR 由调用方提供；请确认取值日期。');
  lines.push('> 只做数学换算，不构成法律或投资建议。');
  return lines.join('\n');
}

const lprResetTool = {
  name: 'lpr_reset',
  description:
    'Recompute a Chinese mortgage after an LPR repricing: new rate = LPR + the fixed spread (加点), then the new instalment and the remaining interest. ' +
    'The spread is fixed for the life of the loan, so this answers "LPR dropped, how much does my monthly payment change". ' +
    'The LPR itself is NOT bundled — pass the LPR that applies (and optionally the previous one to see the change).',
  parameters: {
    type: 'object',
    properties: {
      remainingPrincipal: { type: 'number', description: 'Outstanding principal in yuan.' },
      remainingPeriods: { type: 'integer', description: 'Periods left on the contract (1–600).' },
      spreadBp: { type: 'integer', description: 'Fixed spread over LPR in basis points (55 means +0.55%).' },
      newLpr: { type: 'number', description: 'The LPR that applies after repricing, as a percentage (3.5 means 3.5%).' },
      oldLpr: { type: 'number', description: 'The previous LPR as a percentage, to show the change. Optional.' },
    },
    required: ['remainingPrincipal', 'remainingPeriods', 'spreadBp', 'newLpr'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['markdown'],
    },
    render: (_args, value) => [{ type: 'text', text: value.markdown }],
  },
  async execute(args) {
    const newLpr = Number(args?.newLpr) / 100;
    const oldLpr = args?.oldLpr === undefined || args?.oldLpr === null ? null : Number(args.oldLpr) / 100;
    if (!Number.isFinite(newLpr)) throw new LprError('newLpr must be a percentage');
    if (oldLpr !== null && !Number.isFinite(oldLpr)) throw new LprError('oldLpr must be a percentage');
    const spreadBp = args?.spreadBp;
    if (!Number.isInteger(spreadBp)) throw new LprError('spreadBp must be an integer number of basis points');

    const result = resetRate({
      remainingPrincipalCents: toCents(args?.remainingPrincipal, 'remainingPrincipal'),
      remainingPeriods: args?.remainingPeriods,
      spreadBp,
      newLpr,
      oldLpr,
    });
    return { markdown: lprMarkdown(result), data: result };
  },
  presentCall: () => ({ card: 'generic', title: 'LPR 重定价测算' }),
};

export function createTools() {
  return [realAprTool, loanScheduleTool, loanAuditTool, prepayAuditTool, aprCompareTool, lprResetTool];
}

/** Re-exported so tests and the panel can build the same numbers without the tool layer. */
export { aprFromInstallment, buildSchedule, IrrError, ScheduleError };
