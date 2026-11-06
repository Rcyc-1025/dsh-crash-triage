import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatCommandLine } from './run.js';

/** markdown 的反引号用常量拼，避免在源码里出现三反引号围栏。 */
const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;

/** 行内代码。 */
function code(value) {
  return BT + String(value) + BT;
}

/**
 * 组装复现命令（规格 3.10 的 reproducer 字段）。
 * @param input.optPath - mlir-opt 路径。
 * @param input.irPath - 要复现的 IR（优先最小 IR）。
 * @param input.pipeline / runnerArgs / cwd / env。
 * @param input.exitCode - baseline 的退出码。
 * @returns {{command, cwd, irPath, env, exitCode, text}}
 */
export function buildReproducer(input) {
  const opts = input !== null && typeof input === 'object' ? input : {};
  const command = [opts.optPath];
  if (typeof opts.pipeline === 'string' && opts.pipeline.trim() !== '') command.push('--pass-pipeline=' + opts.pipeline.trim());
  for (const item of Array.isArray(opts.runnerArgs) ? opts.runnerArgs : []) {
    if (typeof item === 'string' && item !== '') command.push(item);
  }
  if (typeof opts.irPath === 'string' && opts.irPath !== '') command.push(opts.irPath);
  const env = opts.env !== null && typeof opts.env === 'object' ? opts.env : null;
  const exitCode = Number.isFinite(Number(opts.exitCode)) ? Math.trunc(Number(opts.exitCode)) : null;
  return {
    command,
    cwd: typeof opts.cwd === 'string' ? opts.cwd : process.cwd(),
    irPath: typeof opts.irPath === 'string' ? opts.irPath : null,
    env,
    exitCode,
    text: formatCommandLine(command),
  };
}

/** 把复现命令写成 reproducer.txt（含 cwd / env / 期望退出码），返回路径。 */
export function writeReproducer(workDir, reproducer) {
  const path = join(workDir, 'reproducer.txt');
  const lines = [
    '# dsh-crash-triage 复现命令',
    '# cwd: ' + reproducer.cwd,
    '# 期望退出码: ' + (reproducer.exitCode === null ? '(崩溃退出码)' : reproducer.exitCode),
  ];
  if (reproducer.env !== null) lines.push('# 环境变量: ' + JSON.stringify(reproducer.env));
  lines.push('', reproducer.text, '');
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

/**
 * 生成 report.md（规格 6.1 第 8 条：一句话结论 / 复现命令 / 最小 IR / 出错 pass / sanitizer 栈 / 产物 / 下一步）。
 * @param result - crash_triage 的输出对象。
 * @returns markdown 文本。
 */
export function renderReport(result) {
  const data = result !== null && typeof result === 'object' ? result : {};
  const crash = data.crash !== null && typeof data.crash === 'object' ? data.crash : {};
  const input = data.input !== null && typeof data.input === 'object' ? data.input : {};
  const reducer = data.reducer !== null && typeof data.reducer === 'object' ? data.reducer : {};
  const bisect = data.bisect !== null && typeof data.bisect === 'object' ? data.bisect : {};
  const artifacts = data.artifacts !== null && typeof data.artifacts === 'object' ? data.artifacts : {};
  const reproducer = data.reproducer !== null && typeof data.reproducer === 'object' ? data.reproducer : {};
  const sanitizer = crash.sanitizer !== null && typeof crash.sanitizer === 'object' ? crash.sanitizer : null;
  const lines = [];

  lines.push('# MLIR 崩溃分诊报告');
  lines.push('');
  lines.push('## 一句话结论');
  lines.push('');
  lines.push(oneLineConclusion(data, crash, bisect, reducer));
  lines.push('');
  lines.push('## 复现命令');
  lines.push('');
  lines.push(FENCE);
  lines.push(typeof reproducer.text === 'string' && reproducer.text !== '' ? reproducer.text : '(未生成)');
  lines.push(FENCE);
  lines.push('');
  if (typeof reproducer.cwd === 'string') lines.push('- cwd: ' + code(reproducer.cwd));
  if (reproducer.exitCode !== null && reproducer.exitCode !== undefined) lines.push('- 期望退出码: ' + code(reproducer.exitCode));
  lines.push('');
  lines.push('## 输入');
  lines.push('');
  lines.push('- IR: ' + code(input.irPath));
  lines.push('- sha256: ' + code(input.sha256));
  lines.push('- pipeline: ' + code(input.pipeline === null || input.pipeline === undefined ? '(无，仅解析/验证)' : input.pipeline));
  const runnerText = (String(input.runner === undefined ? '' : input.runner) + ' ' + (Array.isArray(input.runnerArgs) ? input.runnerArgs.join(' ') : '')).trim();
  lines.push('- runner: ' + code(runnerText));
  lines.push('');
  lines.push('## 崩溃');
  lines.push('');
  if (data.action === 'parse') {
    lines.push('- 判定: 仅解析 sanitizer 报告（未运行 mlir-opt）');
    lines.push('- 报告类型: ' + String(crash.kind === null || crash.kind === undefined ? '(未知)' : crash.kind));
  } else {
    lines.push('- 判定: ' + (crash.reproduced === true ? '已复现' : '未复现') + '，稳定: ' + (crash.stable === true ? '是' : '否') + '，尝试 ' + String(crash.attempts) + ' 次');
    lines.push('- 退出码/信号: ' + String(crash.exitCode) + ' / ' + String(crash.signal === null || crash.signal === undefined ? '(无)' : crash.signal) + '（' + String(crash.kind) + '）');
  }
  lines.push('- 签名: ' + code(crash.signature === null || crash.signature === undefined ? '(无)' : (crash.signature.key !== undefined ? crash.signature.key : crash.signature)));
  if (typeof crash.stderrExcerpt === 'string' && crash.stderrExcerpt.trim() !== '') {
    lines.push('');
    lines.push('stderr 摘录：');
    lines.push('');
    lines.push(FENCE);
    lines.push(crash.stderrExcerpt.trim());
    lines.push(FENCE);
  }
  lines.push('');
  lines.push('## 最小 IR');
  lines.push('');
  if (reducer.ok === true) {
    lines.push('- 文件: ' + code(reducer.outputPath));
    lines.push('- 体积: ' + String(reducer.originalBytes) + ' → ' + String(reducer.reducedBytes) + ' 字节（-' + String(reducer.reductionPercent) + '%）');
    lines.push('- tester 调用次数: ' + String(reducer.testedCandidates));
  } else if (reducer.attempted === true) {
    const reason = reducer.error !== undefined && reducer.error !== null ? reducer.error.message : (Array.isArray(reducer.notes) ? reducer.notes.join('；') : '未知原因');
    lines.push('- 缩减未成功：' + String(reason));
    if (Array.isArray(reducer.notes) && reducer.notes.length > 0) lines.push('- 备注: ' + reducer.notes.join('；'));
  } else {
    lines.push('- 未尝试缩减（action=' + String(data.action) + ' 或 reduce.enabled=false）');
  }
  lines.push('');
  lines.push('## 出错 pass');
  lines.push('');
  if (bisect.ok === true) {
    lines.push('- 第 ' + String(bisect.failingIndex) + ' 个 pass: ' + code(bisect.failingPass) + '（共 ' + String(bisect.totalPasses) + ' 个，跑了 ' + String(bisect.runs) + ' 次，策略 ' + String(bisect.strategy) + '）');
    lines.push('- 不崩的前缀: ' + code(bisect.passingPrefix));
    lines.push('- 崩溃的前缀: ' + code(bisect.failingPrefix));
    if (bisect.evidenceConflict === true) lines.push('- ⚠ 二分结论与 print-ir 实际顺序冲突，两边证据都保留，请人工确认');
  } else if (bisect.attempted === true) {
    lines.push('- 二分未成功：' + String(bisect.error !== undefined && bisect.error !== null ? bisect.error.message : '未知原因'));
  } else {
    lines.push('- 未尝试二分');
  }
  lines.push('');
  lines.push('## sanitizer 栈');
  lines.push('');
  if (sanitizer !== null && sanitizer.kind !== null) {
    lines.push('- 类型: ' + String(sanitizer.kind) + (sanitizer.errorType !== null ? '（' + String(sanitizer.errorType) + '）' : ''));
    if (sanitizer.summary !== null) lines.push('- 摘要: ' + String(sanitizer.summary));
    if (sanitizer.topFrame !== null) lines.push('- 栈顶: ' + code(sanitizer.topFrame));
    if (Array.isArray(sanitizer.frames) && sanitizer.frames.length > 0) {
      lines.push('');
      lines.push(FENCE);
      for (const frame of sanitizer.frames) {
        const where = frame.file === null ? '' : ' ' + frame.file + ':' + frame.line + ':' + frame.column;
        lines.push('#' + frame.index + ' ' + (frame.function === null ? '(未符号化)' : frame.function) + where);
      }
      lines.push(FENCE);
    }
  } else {
    lines.push('- 没有 sanitizer 报告（原生信号/断言崩溃，v1 不做符号化；栈信息见崩溃日志）');
  }
  lines.push('');
  lines.push('## 产物');
  lines.push('');
  for (const [key, value] of Object.entries(artifacts)) {
    if (typeof value === 'string' && value !== '') lines.push('- ' + key + ': ' + code(value));
  }
  lines.push('');
  lines.push('## 下一步');
  lines.push('');
  for (const item of nextSteps(data, crash, bisect, reducer)) lines.push('- ' + item);
  if (Array.isArray(data.warnings) && data.warnings.length > 0) {
    lines.push('');
    lines.push('## 告警');
    lines.push('');
    for (const warning of data.warnings) lines.push('- ' + warning);
  }
  if (Array.isArray(data.hints) && data.hints.length > 0) {
    lines.push('');
    lines.push('## 提示');
    lines.push('');
    for (const hint of data.hints) lines.push('- ' + hint);
  }
  lines.push('');
  return lines.join('\n');
}

/** 一句话结论：崩溃类型 + 出错 pass + 最小 IR 体积。 */
function oneLineConclusion(data, crash, bisect, reducer) {
  if (data.action === 'parse') {
    const parsedKind = String(crash.kind === null || crash.kind === undefined ? 'unknown' : crash.kind);
    const top = crash.signature !== null && typeof crash.signature === 'object' && crash.signature.topFrame !== null && crash.signature.topFrame !== undefined
      ? '，栈顶 ' + String(crash.signature.topFrame)
      : '';
    return '仅解析 sanitizer 报告：' + parsedKind + ' 报告' + top + '（未运行 mlir-opt，未复现、未缩减）。';
  }
  if (crash.reproduced !== true) {
    return '未能稳定复现崩溃（status=' + String(data.status) + '）。';
  }
  const kind = String(crash.kind === null || crash.kind === undefined ? 'unknown' : crash.kind);
  const where = bisect.ok === true ? '，出错 pass 是第 ' + String(bisect.failingIndex) + ' 个「' + String(bisect.failingPass) + '」' : '';
  const size = reducer.ok === true
    ? '，IR 已缩到 ' + String(reducer.reducedBytes) + ' 字节（-' + String(reducer.reductionPercent) + '%）'
    : (reducer.attempted === false ? '，未启用缩减' : '，未完成缩减');
  const frame = crash.signature !== null && typeof crash.signature === 'object' && crash.signature.topFrame !== null && crash.signature.topFrame !== undefined
    ? '，栈顶 ' + String(crash.signature.topFrame)
    : '';
  return 'MLIR ' + kind + ' 崩溃' + (crash.stable === true ? '（可稳定复现）' : '（复现不稳定）') + frame + where + size + '。';
}

/** 下一步建议：按「有没有最小 IR / 有没有 pass / 是不是 flaky」给可执行动作。 */
function nextSteps(data, crash, bisect, reducer) {
  const steps = [];
  if (data.action === 'parse') {
    steps.push('要复现与定位，带上 irPath + pipeline 用 action=diagnose 重跑（parse 不启动 mlir-opt）。');
    if (Array.isArray(data.hints) && data.hints.length > 0) steps.push(...data.hints);
    return steps;
  }
  if (crash.reproduced !== true) {
    steps.push('换一条确定的崩溃路径（例如带 sanitizer 的构建或已确认的断言失败）后重跑 crash_triage。');
    if (Array.isArray(data.hints) && data.hints.length > 0) steps.push(...data.hints);
    return steps;
  }
  if (reducer.ok === true) {
    steps.push('把最小 IR（' + String(reducer.outputPath) + '）附到 bug report，能显著缩小上游定位范围。');
  } else if (reducer.attempted === false) {
    steps.push('这次没有缩减（action/reduce.enabled 关掉了）：需要最小 IR 时用 action=reduce 重跑。');
  } else {
    steps.push('缩减未成功：先用 reduce.enabled=false 拿到稳定 baseline，再重试缩减。');
  }
  if (bisect.ok === true) {
    steps.push('在最小 IR 上只跑「' + String(bisect.failingPass) + '」确认；必要时把该前缀 ' + String(bisect.failingPrefix) + ' 作为 bug report 的复现 pipeline。');
  } else if (bisect.attempted === false) {
    steps.push('这次没有二分（没给 pipeline/passList 或 bisect.enabled=false）：补上顶层 pass 后重跑即可定位出错 pass。');
  } else {
    steps.push('没有锁定单个 pass：看 passes.log 里各前缀的退出码，或用 bisect.strategy=print-ir 交叉验证实际执行顺序。');
  }
  if (crash.sanitizer !== null && typeof crash.sanitizer === 'object' && crash.sanitizer.kind !== null) {
    steps.push('sanitizer 栈顶（' + String(crash.sanitizer.topFrame) + '）优先人工核对；v1 不做符号化，需要符号请用带调试信息的构建重跑。');
  } else {
    steps.push('没有 sanitizer 报告：如需栈符号，请用 ASan/UBSan 构建复现，或用 sanitizer.reportPath 收集外部报告。');
  }
  if (crash.stable !== true) {
    steps.push('复现不稳定（flaky）：先固定环境（同一构建、同一 CPU/线程数）再复现，必要时加大重试次数。');
  }
  steps.push('报告可直接转交：report.md / result.json 在 ' + String(data.artifacts !== null && typeof data.artifacts === 'object' ? data.artifacts.workDir : '(工作目录)') + '。');
  return steps;
}
