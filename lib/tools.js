import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.js';
import { resolveMlirTools } from './toolchain.js';
import { runMlirOpt, formatCommandLine } from './run.js';
import { buildSignature, normalizeText } from './classify.js';
import { buildRunSignature, toSanitizerOutput, parseSanitizer } from './sanitize.js';
import { extractPasses, bisectPasses, crossCheckWithPrintIr } from './bisect.js';
import { reduceIr } from './reduce.js';
import { buildReproducer, writeReproducer, renderReport } from './report.js';

/** 插件版本（从 package.json 读，读不到就退化成 0.0.0）。 */
const VERSION = readVersion();

/** baseline 的重试次数（规格 3.8：默认重试 2 次，签名相同才算稳定）。 */
const RETRIES = 2;

/** 一次分诊里允许的 action。 */
const ACTIONS = ['diagnose', 'reduce', 'bisect', 'parse'];

const REPORT_FORMATS = ['markdown', 'json', 'both'];

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 带错误码的内部异常；execute 里统一转成 ok:false 的返回体。 */
class TriageError extends Error {
  constructor(code, message, hint, stage, detail) {
    super(message);
    this.name = 'TriageError';
    this.code = code;
    this.hint = hint === undefined ? null : hint;
    this.stage = stage === undefined ? null : stage;
    if (detail !== undefined) this.detail = detail;
  }
}

function fail(code, message, hint, stage, detail) {
  throw new TriageError(code, message, hint, stage, detail);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false;
}

function truncate(text, maxBytes) {
  const value = typeof text === 'string' ? text : '';
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Math.trunc(Number(maxBytes)) : 1048576;
  if (Buffer.byteLength(value, 'utf8') <= limit) return { text: value, truncated: false };
  // 按字节粗略截断后再回退到合法 UTF-8 边界。
  let cut = value.slice(0, limit);
  while (Buffer.byteLength(cut, 'utf8') > limit && cut.length > 0) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/** 从崩溃日志里挑出可读的摘录（崩溃特征行 + 末尾若干行）。 */
function excerpt(text, patterns, limit) {
  const lines = String(text === null || text === undefined ? '' : text).split('\n');
  const picked = [];
  const pool = Array.isArray(patterns) ? patterns : [];
  for (const line of lines) {
    if (pool.some((pattern) => typeof pattern === 'string' && pattern !== '' && line.includes(pattern))) picked.push(line);
  }
  const tail = lines.slice(-12).filter((line) => line.trim() !== '');
  const merged = [];
  for (const line of picked.concat(tail)) {
    if (merged.includes(line)) continue;
    merged.push(line);
  }
  const text2 = merged.join('\n').slice(0, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 2000);
  return text2.trim();
}

/** YYYYMMDD-HHMMSS（本地时间）。 */
function timestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

/** 目录名里的 IR slug：只留 [a-z0-9-_]，最长 32。 */
function irSlug(irPath, fallback) {
  const name = typeof irPath === 'string' && irPath !== '' ? basename(irPath, extname(irPath)) : String(fallback || 'input');
  const slug = String(name).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return slug === '' ? 'input' : slug;
}

/** 找一个不冲突的产物目录（同名加 -2/-3，绝不覆盖）。 */
function claimRunDir(base, name) {
  mkdirSync(base, { recursive: true });
  const first = join(base, name);
  if (!existsSync(first)) {
    mkdirSync(first, { recursive: true });
    return first;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = join(base, name + '-' + index);
    if (!existsSync(candidate)) {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    }
  }
  fail('WORKDIR_FAILED', '无法为产物分配目录（同名目录过多）：' + base, '清理 ' + base + ' 下的旧产物后重试。', 'workspace');
}

/** 会话 cwd：优先宿主给的，兜底 process.cwd()。 */
function resolveSessionCwd(exec) {
  const header = exec !== null && typeof exec === 'object' && exec.agent !== undefined && exec.agent !== null && exec.agent.session !== undefined && exec.agent.session !== null
    ? exec.agent.session.header
    : undefined;
  if (header !== null && typeof header === 'object' && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd;
  return process.cwd();
}

/** 判断 child 是否在 parent 之内（含相等）。 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return rel.split(/[\\/]+/).every((part) => part !== '..') && isAbsolute(rel) === false;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function safeSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function describe(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

/** 校验 pipeline 的括号是否配平（mlir-opt 自己会报语法错，这里只挡明显坏输入）。 */
function balanced(text) {
  let depth = 0;
  for (const char of String(text)) {
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * crash_triage 工具定义（规格 3.x）。
 * @param config - 已 resolveConfig 的插件配置。
 * @param runner - createSubprocessRunner 的产物。
 * @returns 工具定义数组（插件只提供一个工具）。
 */
export function buildCrashTriageTools(config, runner) {
  const cfg = isPlainObject(config) ? config : {};
  return [{
    name: 'crash_triage',
    description: '把一次 MLIR 崩溃压缩成可复现命令 + 最小 IR + 出错 pass + sanitizer 栈 + 可转交报告。用 mlir-opt 跑给定 IR 与 pass pipeline，判定崩溃并算归一化签名；按需用 mlir-reduce 缩小 IR（tester 只保留仍产生同一签名的候选）、用 pass 前缀二分锁定出错 pass；产出 workDir 下的 baseline 日志、reduced.mlir、passes.log、report.md、result.json。不做 core dump / 符号化 / 自动修 bug / 编译 MLIR。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'diagnose=全流程（默认）；reduce=只缩 IR；bisect=只二分 pass；parse=只解析 sanitizer 报告（不启动 mlir-opt）。' },
        irPath: { type: 'string', description: '要分诊的 .mlir 文件路径（相对 cwd 或绝对）；除 action=parse 外必填（parse 可只给 sanitizer）。' },
        pipeline: { type: 'string', description: '传给 mlir-opt 的 --pass-pipeline 内容，如 builtin.module(func.func(cse,canonicalize))。' },
        passList: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64, description: '顶层 pass 段列表（二分用）。给了就以它为 pipeline；未给 pipeline 时也以它组装。' },
        runner: { type: 'string', enum: ['mlir-opt'], description: '固定 mlir-opt（插件 v1 只支持它）。' },
        runnerArgs: { type: 'array', items: { type: 'string' }, description: '追加给 mlir-opt 的额外参数（原样放在 IR 路径之前）。' },
        cwd: { type: 'string', description: '运行 mlir-opt 的工作目录，默认会话 cwd。' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: '额外环境变量（覆盖式合并到子进程环境）。' },
        stdin: { type: 'string', description: '直接把 IR 文本作为输入（此时按 stdout/stderr 判定，不读 irPath 的内容）。' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: '单次 mlir-opt 超时，默认 120000。' },
        outputDir: { type: 'string', description: '产物根目录（必须在会话 cwd 内），默认 <cwd>/.crash-triage。' },
        keepWorkDir: { type: 'boolean', description: '成功后是否保留产物目录，默认 true。' },
        sanitizer: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['auto', 'off', 'asan', 'ubsan'], description: 'auto=有报告就解析（默认）；off=不解析；asan/ubsan=必须解析到对应报告，否则报 SANITIZER_NOT_FOUND。' },
            reportPath: { type: 'string', description: '外部 sanitizer 报告文件（相对路径按 cwd 解析；v1 不做符号化，只解析这份日志）。' },
            inline: { type: 'string', description: '直接给一段 sanitizer 报告文本。' },
            maxFrames: { type: 'integer', minimum: 1, maximum: 200, description: '最多保留几帧栈，默认 10。' },
          },
          additionalProperties: false,
        },
        reduce: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: '是否用 mlir-reduce 缩小 IR，默认 true（action=reduce/diagnose 时生效）。' },
            maxIterations: { type: 'integer', minimum: 1, maximum: 10000, description: '观察值（mlir-reduce 23.1.4 没有迭代开关，只用超时兜底）。' },
            maxTimeMs: { type: 'integer', minimum: 1000, maximum: 86400000, description: '缩减时间上限，默认 600000。' },
            maxCandidates: { type: 'integer', minimum: 1, maximum: 100000, description: 'tester 调用次数上限（超出记告警，不强制中断）。' },
            testArgs: { type: 'array', items: { type: 'string' }, description: '额外传给 tester 的参数（v1 仅记录）。' },
          },
          additionalProperties: false,
        },
        bisect: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: '是否二分 pass，默认 true（action=bisect/diagnose 时生效）。' },
            maxRuns: { type: 'integer', minimum: 1, maximum: 1024, description: '二分最多跑几次 mlir-opt，默认 64。' },
            strategy: { type: 'string', enum: ['auto', 'prefix', 'print-ir'], description: 'auto=二分（非单调时回退线性）；prefix=只按前缀；print-ir=用 print-ir 标记交叉验证。' },
            stopAtFirst: { type: 'boolean', description: '遇到第一个崩溃前缀就停（不做最小化），默认 false。' },
          },
          additionalProperties: false,
        },
        report: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: REPORT_FORMATS, description: 'report.md / result.json / both（默认 both）。' },
            includeStderr: { type: 'boolean', description: '报告里是否附 stderr 摘录，默认 true。' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
      anyOf: [
        { required: ['irPath'] },
        { properties: { action: { const: 'parse' } }, required: ['action', 'sanitizer'] },
      ],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
    },
    timeoutMs: Number.isFinite(Number(cfg.maxTotalMs)) ? Math.trunc(Number(cfg.maxTotalMs)) : 900000,
    async execute(rawArgs, exec) {
      const sessionCwd = resolveSessionCwd(exec);
      const signal = exec !== null && typeof exec === 'object' && exec.signal !== undefined ? exec.signal : undefined;
      return await runTriage(rawArgs, { config: cfg, runner, sessionCwd, signal });
    },
  }];
}

/** 给模型看的紧凑摘要（完整数据仍写进 result.json）。 */
function renderSummary(value) {
  if (!isPlainObject(value)) return String(value);
  const lines = [];
  const status = typeof value.status === 'string' && value.status !== '' ? value.status : null;
  const codeText = value.error !== undefined && value.error !== null ? ' [' + value.error.code + ']' : '';
  lines.push('crash_triage: ' + (value.ok === true ? 'ok' + (status === null ? '' : ' (' + status + ')') : (status === null ? 'failed' : status) + codeText));
  if (value.error !== undefined && value.error !== null) {
    lines.push('message: ' + String(value.error.message));
    if (value.error.hint !== null && value.error.hint !== undefined) lines.push('hint: ' + String(value.error.hint));
  }
  const crash = value.crash;
  if (isPlainObject(crash)) {
    lines.push('crash: reproduced=' + String(crash.reproduced) + ' stable=' + String(crash.stable) + ' kind=' + String(crash.kind) + ' exit=' + String(crash.exitCode) + ' signal=' + String(crash.signal));
    if (isPlainObject(crash.signature)) lines.push('signature: ' + String(crash.signature.key));
    if (isPlainObject(crash.sanitizer) && crash.sanitizer.kind !== null && crash.sanitizer.kind !== undefined) lines.push('sanitizer: ' + String(crash.sanitizer.kind) + ' top=' + String(crash.sanitizer.topFrame));
  }
  const reducer = value.reducer;
  if (isPlainObject(reducer) && reducer.attempted === true) {
    lines.push('reduce: ok=' + String(reducer.ok) + ' ' + String(reducer.originalBytes) + ' -> ' + String(reducer.reducedBytes) + ' bytes (-' + String(reducer.reductionPercent) + '%) ' + String(reducer.outputPath === undefined ? '' : reducer.outputPath));
  }
  const bisect = value.bisect;
  if (isPlainObject(bisect) && bisect.attempted === true) {
    lines.push('bisect: ok=' + String(bisect.ok) + ' failing=' + String(bisect.failingPass) + ' index=' + String(bisect.failingIndex) + '/' + String(bisect.totalPasses) + ' runs=' + String(bisect.runs));
  }
  const reproducer = value.reproducer;
  if (isPlainObject(reproducer) && typeof reproducer.text === 'string' && reproducer.text !== '') lines.push('reproduce: ' + reproducer.text);
  const artifacts = value.artifacts;
  if (isPlainObject(artifacts)) {
    for (const key of ['workDir', 'reportPath', 'resultPath', 'minimizedIrPath', 'crashLogPath', 'passLogPath']) {
      if (typeof artifacts[key] === 'string' && artifacts[key] !== '') lines.push(key + ': ' + artifacts[key]);
    }
  }
  if (Array.isArray(value.warnings)) for (const warning of value.warnings) lines.push('warning: ' + String(warning));
  if (Array.isArray(value.hints)) for (const hint of value.hints) lines.push('hint: ' + String(hint));
  if (Number.isFinite(Number(value.durationMs))) lines.push('durationMs: ' + String(value.durationMs));
  return lines.join('\n');
}

/**
 * 主流程（规格第 5 章）。永不抛异常：任何失败都转成 ok:false 的返回体。
 * @param rawArgs - 工具入参。
 * @param options.config / options.runner / options.sessionCwd / options.signal。
 * @returns crash_triage 的输出对象。
 */
export async function runTriage(rawArgs, options) {
  const args = isPlainObject(rawArgs) ? rawArgs : {};
  const opts = isPlainObject(options) ? options : {};
  const sessionCwd = typeof opts.sessionCwd === 'string' && opts.sessionCwd !== '' ? opts.sessionCwd : process.cwd();
  const cfg = isPlainObject(opts.config) ? opts.config : resolveConfig({}, sessionCwd);
  const runner = typeof opts.runner === 'function' ? opts.runner : null;
  const startedAt = Date.now();
  const warnings = [];
  const hints = [];
  let stage = 'validate';
  const artifacts = {};
  // 已成功但被降级的阶段（diagnose 里 reduce/bisect 失败、PASS_NESTED）：status=partial、ok=false，但保留已有结果。
  const degraded = [];

  const elapsed = () => Date.now() - startedAt;
  const maxTotalMs = Number.isFinite(Number(cfg.maxTotalMs)) ? Math.trunc(Number(cfg.maxTotalMs)) : 900000;
  const deadline = startedAt + maxTotalMs;
  const remaining = () => deadline - Date.now();

  if (runner === null) {
    return { ok: false, status: 'failed', error: { code: 'INTERNAL', message: '插件没有拿到 subprocess 执行器', hint: '这是安装问题：确认插件申请了 subprocess 能力（inject 含 subprocess）。', stage: 'init' }, artifacts, warnings, durationMs: 0 };
  }

  try {
    stage = 'validate';
    const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'diagnose';
    if (ACTIONS.includes(action) === false) fail('INVALID_ARGUMENT', '未知的 action：' + action, 'action 只能是 ' + ACTIONS.join(' / ') + '。', 'validate');
    if (args.runner !== undefined && args.runner !== null && args.runner !== 'mlir-opt') fail('INVALID_ARGUMENT', 'runner 只支持 mlir-opt（v1）', '去掉 runner 或传 mlir-opt。', 'validate');
    if (args.report !== undefined && args.report !== null && isPlainObject(args.report) && args.report.format !== undefined && REPORT_FORMATS.includes(args.report.format) === false) {
      fail('INVALID_ARGUMENT', 'report.format 只能是 ' + REPORT_FORMATS.join(' / '), '改 format 或去掉该字段。', 'validate');
    }
    const timeoutMs = clampNumber(args.timeoutMs, 1000, 600000, cfg.timeoutMs);
    const runnerArgs = Array.isArray(args.runnerArgs) ? args.runnerArgs.filter((item) => typeof item === 'string' && item !== '') : [];
    const runCwd = typeof args.cwd === 'string' && args.cwd !== '' ? resolve(sessionCwd, args.cwd) : sessionCwd;
    if (existsSync(runCwd) === false) fail('INVALID_ARGUMENT', 'cwd 不存在：' + runCwd, '传一个存在的目录，或省略 cwd 用会话目录。', 'validate');
    const env = isPlainObject(args.env) ? args.env : null;
    const maxOutputBytes = Number.isFinite(Number(cfg.maxOutputBytes)) ? Math.trunc(Number(cfg.maxOutputBytes)) : 1048576;

    // pipeline / passList（规格 3.5）
    let passList = null;
    if (args.passList !== undefined && args.passList !== null) {
      if (Array.isArray(args.passList) === false) fail('PASS_LIST_INVALID', 'passList 必须是字符串数组', '传 ["cse","canonicalize"] 这种形式。', 'validate');
      passList = args.passList.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
      if (passList.length === 0) fail('PASS_LIST_INVALID', 'passList 不能为空', '至少给一个 pass 段。', 'validate');
      if (passList.length > 64) fail('PASS_LIST_INVALID', 'passList 最多 64 段（收到 ' + passList.length + '）', '把相邻 pass 合并或分批二分。', 'validate');
    }
    let pipeline = typeof args.pipeline === 'string' ? args.pipeline.trim() : '';
    if (passList !== null) pipeline = 'builtin.module(' + passList.join(',') + ')';
    if (pipeline !== '' && balanced(pipeline) === false) fail('PIPELINE_INVALID', 'pipeline 括号不配平：' + pipeline, '检查 --pass-pipeline 的括号层级。', 'validate');
    const bisectRequested = action === 'bisect' || (action === 'diagnose' && isPlainObject(args.bisect) && args.bisect.enabled !== false);
    if (pipeline === '' && bisectRequested) {
      fail('PIPELINE_INVALID', 'action=' + action + ' 需要 pipeline 或 passList', '传 pipeline=builtin.module(...)、passList=[...]，或用 bisect.enabled=false 关掉二分。', 'validate');
    }

    // action=parse：只解析 sanitizer，不解析工具链、不启动 mlir-opt（规格 3.4 / 3.5 第 0、7 步）
    if (action === 'parse') {
      const spec = isPlainObject(args.sanitizer) ? args.sanitizer : {};
      const inline = typeof spec.inline === 'string' && spec.inline !== '' ? spec.inline : null;
      const reportRaw = typeof spec.reportPath === 'string' && spec.reportPath !== '' ? spec.reportPath : null;
      if (inline === null && reportRaw === null) {
        fail('INVALID_ARGUMENT', 'action=parse 需要 sanitizer.inline 或 sanitizer.reportPath', '把 ASan/UBSan 报告文本传进 sanitizer.inline，或把报告文件路径放进 sanitizer.reportPath。', 'validate');
      }
      stage = 'workspace';
      const irHint = typeof args.irPath === 'string' && args.irPath !== '' ? (isAbsolute(args.irPath) ? args.irPath : resolve(runCwd, args.irPath)) : null;
      const parseWorkDir = claimWorkDir(resolveBaseDir(args, sessionCwd, cfg), irHint);
      artifacts.workDir = parseWorkDir;

      stage = 'sanitizer';
      const maxFrames = clampNumber(spec.maxFrames, 1, 200, cfg.maxFrames);
      let text = '';
      let source = 'inline';
      let reportPath = null;
      if (inline !== null) {
        text = normalizeText(inline);
      } else {
        reportPath = isAbsolute(reportRaw) ? reportRaw : resolve(runCwd, reportRaw);
        if (existsSync(reportPath) === false) {
          fail('SANITIZER_NOT_FOUND', 'sanitizer 报告不存在：' + reportPath, '检查 sanitizer.reportPath（相对 cwd 解析）；v1 只解析外部日志，不生成 sanitizer 报告。', 'sanitizer');
        }
        try {
          text = normalizeText(readFileSync(reportPath, 'utf8'));
        } catch (error) {
          fail('SANITIZER_PARSE_FAILED', '读 sanitizer 报告失败：' + describe(error), '确认文件是 UTF-8 文本且可读。', 'sanitizer');
        }
        source = 'report';
      }
      const parsed = parseSanitizer(text);
      if (parsed === null || parsed.kind === null) {
        fail('SANITIZER_PARSE_FAILED', '报告里没有可解析的 ASan/UBSan 片段', '确认这是 ASan/UBSan 输出（含 ERROR: AddressSanitizer 或 runtime error:）；只想看普通崩溃输出时用 action=diagnose。', 'sanitizer');
      }
      if ((spec.mode === 'asan' || spec.mode === 'ubsan') && parsed.kind !== spec.mode) {
        fail('SANITIZER_NOT_FOUND', '报告类型是 ' + parsed.kind + '，与请求的 ' + spec.mode + ' 不一致', '改用 sanitizer.mode=auto，或换成对应类型的报告。', 'sanitizer');
      }
      const sanitizerOutput = toSanitizerOutput(parsed, { reportPath, source, maxFrames });
      const sanitizerLogPath = safeWrite(() => {
        const target = join(parseWorkDir, 'sanitizer.log');
        writeFileSync(target, text, 'utf8');
        return target;
      });
      artifacts.sanitizerReportPath = reportPath !== null ? reportPath : sanitizerLogPath;
      let inputSha = null;
      if (irHint !== null && existsSync(irHint) === true) {
        try {
          inputSha = sha256(readFileSync(irHint));
        } catch {
          inputSha = null;
        }
      }
      const signature = buildSignature({ kind: parsed.kind, errorType: parsed.errorType, topFrame: parsed.topFrame, summary: parsed.summary, exitCode: null });
      const parseCrash = {
        reproduced: null,
        stable: null,
        attempts: 0,
        exitCode: null,
        signal: null,
        kind: parsed.kind,
        signature,
        sanitizer: sanitizerOutput,
        stderrExcerpt: '',
        logPath: reportPath !== null ? reportPath : sanitizerLogPath,
      };
      hints.push('这只是 sanitizer 报告解析结果：要复现与定位出错 pass，用 action=diagnose 传 irPath + pipeline 再跑一次。');
      const parseResult = {
        ok: true,
        status: 'parsed',
        action,
        version: VERSION,
        input: { irPath: irHint, sha256: inputSha, pipeline: null, runner: null, runnerArgs: [] },
        crash: parseCrash,
        reducer: { attempted: false, ok: false, inputPath: null, outputPath: null, originalBytes: null, reducedBytes: null, reductionPercent: null, iterations: null, testedCandidates: 0, command: null, logPath: null, notes: ['action=parse 不缩减'] },
        bisect: { attempted: false, ok: false, strategy: null, totalPasses: 0, runs: 0, failingPass: null, failingIndex: null, passingPrefix: null, failingPrefix: null, evidence: [], notes: ['action=parse 不二分'] },
        reproducer: null,
        artifacts,
        warnings,
        hints,
        durationMs: elapsed(),
      };
      finalize({ result: parseResult, workDir: parseWorkDir, artifacts, args, cfg, kind: 'parse' });
      return parseResult;
    }

    stage = 'toolchain';
    const tools = resolveMlirTools(cfg, runCwd);
    if (tools.mlirOpt.exists !== true) {
      fail('TOOL_NOT_FOUND', '找不到 mlir-opt（来源：' + tools.mlirOpt.source + '）', '安装 MLIR 后把 mlirOptPath 指到 mlir-opt 可执行文件，或把含 mlirOpt/mlirReduce 的 toolchain.json 放进 <cwd>/mlir-lang/toolchain.json 或 <cwd>/toolchain.json。', 'toolchain');
    }
    const needsReduce = (action === 'reduce' || action === 'diagnose') && (isPlainObject(args.reduce) === false || args.reduce.enabled !== false);
    if (needsReduce && tools.mlirReduce.exists !== true) {
      fail('TOOL_NOT_FOUND', '找不到 mlir-reduce（来源：' + tools.mlirReduce.source + '）', '缩减需要 mlir-reduce：装好后设置 mlirReducePath，或改用 reduce.enabled=false 只做诊断。', 'toolchain');
    }
    if (typeof tools.mlirOpt.path !== 'string' || tools.mlirOpt.path === '') {
      fail('TOOL_NOT_FOUND', 'mlir-opt 路径为空', '显式设置 mlirOptPath。', 'toolchain');
    }

    // 输入 IR（规格 3.2 / 5.1）
    stage = 'input';
    let sourcePath = null;
    let inputBytes = null;
    let inputSha = null;
    const stdinText = typeof args.stdin === 'string' && args.stdin !== '' ? args.stdin : null;
    if (typeof args.irPath === 'string' && args.irPath !== '') {
      sourcePath = isAbsolute(args.irPath) ? args.irPath : resolve(runCwd, args.irPath);
      if (existsSync(sourcePath) === false) fail('IR_NOT_FOUND', 'IR 文件不存在：' + sourcePath, '检查 irPath 是否相对会话 cwd；也可以用 stdin 直接传 IR 文本。', 'input');
      try {
        inputBytes = readFileSync(sourcePath);
      } catch (error) {
        fail('IR_READ_FAILED', '读不了 IR 文件：' + describe(error), '检查文件权限，或换一个可读路径。', 'input');
      }
      const size = inputBytes.length;
      if (size > Number(cfg.maxIrBytes)) fail('IR_TOO_LARGE', 'IR 太大（' + size + ' 字节，上限 ' + cfg.maxIrBytes + '）', '先裁掉无关顶层 op，或调大 maxIrBytes。', 'input');
      inputSha = sha256(inputBytes);
    } else if (stdinText !== null) {
      inputBytes = Buffer.from(stdinText, 'utf8');
      if (inputBytes.length > Number(cfg.maxIrBytes)) fail('IR_TOO_LARGE', 'stdin 里的 IR 太大（' + inputBytes.length + ' 字节）', '先裁掉无关顶层 op，或调大 maxIrBytes。', 'input');
      inputSha = sha256(inputBytes);
    } else if (action !== 'parse') {
      fail('INVALID_ARGUMENT', '缺少 irPath', '传 irPath（.mlir 文件）或用 stdin 传 IR 文本。', 'input');
    }

    // 产物目录（规格 4 + 3.9）
    stage = 'workspace';
    const baseDir = resolveBaseDir(args, sessionCwd, cfg);
    const workDir = claimWorkDir(baseDir, sourcePath);
    artifacts.workDir = workDir;
    const inputPath = join(workDir, 'input.mlir');
    try {
      if (inputBytes !== null) writeFileSync(inputPath, inputBytes);
    } catch (error) {
      fail('WORKDIR_FAILED', '写 input.mlir 失败：' + describe(error), '检查产物目录写权限。', 'workspace');
    }

    // baseline（规格 3.6 / 3.8）
    stage = 'baseline';
    const baselineStdout = join(workDir, 'baseline.stdout.log');
    const baselineStderr = join(workDir, 'baseline.stderr.log');
    artifacts.crashLogPath = baselineStderr;
    const attempts = [];
    let firstRun = null;
    let firstSignature = null;
    for (let attempt = 1; attempt <= RETRIES + 1; attempt += 1) {
      if (remaining() <= 0) fail('CANCELLED', '超过总时间预算 maxTotalMs=' + maxTotalMs, '调大 maxTotalMs，或先缩小输入。', 'baseline');
      const runResult = await runMlirOpt(runner, {
        optPath: tools.mlirOpt.path,
        irPath: inputPath,
        pipeline,
        runnerArgs,
        cwd: runCwd,
        timeoutMs: Math.min(timeoutMs, Math.max(1000, remaining())),
        env,
        signal: opts.signal,
      });
      if (runResult.timedOut) {
        try {
          writeFileSync(baselineStdout, runResult.stdout, 'utf8');
          writeFileSync(baselineStderr, runResult.stderr, 'utf8');
        } catch {
          // 日志写不下不影响判定。
        }
        fail('CRASH_TIMEOUT', 'mlir-opt 单次超时（' + timeoutMs + 'ms），超时不能证明崩溃', '调大 timeoutMs，或先缩小 IR。', 'baseline');
      }
      const built = buildRunSignature(runResult, { crashExitCodes: cfg.crashExitCodes, crashPatterns: cfg.crashPatterns });
      attempts.push({ attempt, exitCode: runResult.exitCode, signal: runResult.signal, crashed: built.classified.crashed, signatureKey: built.signature.key, stdout: runResult.stdout, stderr: runResult.stderr });
      if (attempt === 1) {
        firstRun = runResult;
        firstSignature = built.signature;
        try {
          writeFileSync(baselineStdout, runResult.stdout, 'utf8');
          writeFileSync(baselineStderr, runResult.stderr, 'utf8');
        } catch (error) {
          fail('WORKDIR_FAILED', '写 baseline 日志失败：' + describe(error), '检查产物目录写权限。', 'baseline');
        }
      }
      if (attempt === 1 && built.classified.crashed === false) break;
      if (attempt > 1 && (runResult.exitCode !== firstRun.exitCode || built.classified.crashed === false)) continue;
    }

    const crashedAttempts = attempts.filter((item) => item.crashed === true);
    const crashed = crashedAttempts.length > 0;
    const sameSignature = crashedAttempts.every((item) => item.signatureKey === crashedAttempts[0].signatureKey);
    const stable = crashed && crashedAttempts.length === attempts.length && sameSignature;
    const classified = buildRunSignature(firstRun, { crashExitCodes: cfg.crashExitCodes, crashPatterns: cfg.crashPatterns }).classified;
    const signature = firstSignature;
    const stderrExcerptRaw = excerpt(firstRun.stderr + '\n' + firstRun.stdout, cfg.crashPatterns, 2000);
    const truncatedExcerpt = truncate(stderrExcerptRaw, maxOutputBytes);
    if (truncatedExcerpt.truncated) warnings.push('OUTPUT_TRUNCATED: 崩溃输出超过 maxOutputBytes，摘录已截断（完整内容见 baseline.stderr.log）');

    const crashInfo = {
      reproduced: crashed,
      stable,
      attempts: attempts.length,
      exitCode: firstRun.exitCode,
      signal: firstRun.signal,
      kind: classified.kind,
      signature,
      sanitizer: null,
      stderrExcerpt: truncatedExcerpt.text,
      logPath: baselineStderr,
    };

    if (crashed === false) {
      writeFailureArtifacts({ workDir, artifacts, action, inputPath, sourcePath, sha256: inputSha, pipeline, runnerArgs, rebuff: null, crash: crashInfo, warnings, hints, startedAt, cfg, renderOpts: args.report });
      return failureEnvelope({
        code: 'NOT_A_CRASH',
        message: 'mlir-opt 没有崩溃（退出码 ' + String(firstRun.exitCode) + '）',
        hint: '这条 IR + pipeline 只是普通诊断/成功：看 baseline.stderr.log；或换一条能稳定崩溃的输入。',
        stage: 'baseline',
      }, { artifacts, warnings, hints, durationMs: elapsed(), crash: crashInfo });
    }
    if (stable === false) {
      const code = crashedAttempts.length === attempts.length ? 'FLAKY_CRASH' : 'NOT_REPRODUCED';
      const message = code === 'FLAKY_CRASH'
        ? '每次崩溃的签名不一致（' + attempts.map((item) => String(item.signatureKey)).join(' / ') + '）'
        : '只有 ' + crashedAttempts.length + '/' + attempts.length + ' 次崩溃，复现不稳定';
      writeFailureArtifacts({ workDir, artifacts, action, inputPath, sourcePath, sha256: inputSha, pipeline, runnerArgs, crash: crashInfo, warnings, hints, startedAt, cfg });
      return failureEnvelope({
        code,
        message,
        hint: '固定构建/环境后重跑；崩溃不稳定时缩减与二分都不可信。',
        stage: 'baseline',
      }, { artifacts, warnings, hints, durationMs: elapsed(), crash: crashInfo });
    }

    // sanitizer（规格 3.11 / 6.1 第 4 条）
    stage = 'sanitizer';
    const sanitizerResolution = resolveSanitizer(args, cfg, firstRun, workDir, runCwd, warnings);
    if (sanitizerResolution.error !== null) {
      writeFailureArtifacts({ workDir, artifacts, action, inputPath, sourcePath, sha256: inputSha, pipeline, runnerArgs, crash: crashInfo, warnings, hints, startedAt, cfg });
      return failureEnvelope(sanitizerResolution.error, { artifacts, warnings, hints, durationMs: elapsed(), crash: crashInfo });
    }
    crashInfo.sanitizer = sanitizerResolution.output;
    if (typeof sanitizerResolution.reportPath === 'string') artifacts.sanitizerReportPath = sanitizerResolution.reportPath;

    // reproducer（规格 3.10）
    const reproducer = buildReproducer({
      optPath: tools.mlirOpt.path,
      irPath: inputPath,
      pipeline,
      runnerArgs,
      cwd: runCwd,
      env,
      exitCode: firstRun.exitCode,
    });

    // parse 到此结束（规格第 5 章）
    if (action === 'parse') {
      const reproducerPath = safeWrite(() => writeReproducer(workDir, reproducer));
      if (typeof reproducerPath === 'string') artifacts.reproducerPath = reproducerPath;
      const result = {
        ok: true,
        status: 'ok',
        action,
        version: VERSION,
        input: { irPath: sourcePath !== null ? sourcePath : inputPath, sha256: inputSha, pipeline: pipeline === '' ? null : pipeline, runner: 'mlir-opt', runnerArgs },
        crash: crashInfo,
        reducer: { attempted: false, ok: false, inputPath, outputPath: null, originalBytes: safeSize(inputPath), reducedBytes: null, reductionPercent: null, iterations: null, testedCandidates: 0, command: null, logPath: null, notes: ['action=parse 不缩减'] },
        bisect: { attempted: false, ok: false, strategy: null, totalPasses: 0, runs: 0, failingPass: null, failingIndex: null, passingPrefix: null, failingPrefix: null, evidence: [], notes: ['action=parse 不二分'] },
        reproducer,
        artifacts,
        warnings,
        hints,
        durationMs: elapsed(),
      };
      finalize({ result, workDir, artifacts, args, cfg, kind: 'parse' });
      return result;
    }

    // 缩减（规格 3.7）
    stage = 'reduce';
    const reduceSpec = isPlainObject(args.reduce) ? args.reduce : {};
    let reducer = {
      attempted: false,
      ok: false,
      inputPath,
      outputPath: null,
      originalBytes: safeSize(inputPath),
      reducedBytes: null,
      reductionPercent: null,
      iterations: null,
      testedCandidates: 0,
      command: null,
      logPath: null,
      notes: [],
      warnings: [],
    };
    const wantReduce = action === 'reduce' || (action === 'diagnose' && reduceSpec.enabled !== false);
    if (wantReduce) {
      const reduceTimeout = Math.max(1000, Math.min(clampNumber(reduceSpec.maxTimeMs, 1000, 86400000, cfg.maxReduceTimeMs), Math.max(1000, remaining())));
      const reduceResult = await reduceIr({
        runner,
        reducePath: tools.mlirReduce.path,
        optPath: tools.mlirOpt.path,
        nodePath: tools.node.path,
        inputPath,
        outPath: join(workDir, 'reduced.mlir'),
        pipeline,
        runnerArgs,
        cwd: runCwd,
        workDir,
        timeoutMs: reduceTimeout,
        testerTimeoutMs: timeoutMs,
        expectedSignatureKey: signature.key,
        crashExitCodes: cfg.crashExitCodes,
        crashPatterns: cfg.crashPatterns,
        testerLogPath: join(workDir, 'tester.log'),
        reduceLogPath: join(workDir, 'reduce.log'),
        signal: opts.signal,
        maxIterations: clampNumber(reduceSpec.maxIterations, 1, 10000, cfg.maxReduceIterations),
      });
      reducer = { ...reducer, ...reduceResult, warnings: Array.isArray(reduceResult.warnings) ? reduceResult.warnings : [] };
      if (Array.isArray(reducer.warnings)) warnings.push(...reducer.warnings);
      if (Array.isArray(reducer.notes)) hints.push(...reducer.notes);
      if (reducer.ok === true) {
        artifacts.minimizedIrPath = reducer.outputPath;
        artifacts.crashReproducerPath = reducer.outputPath;
      }
      const candidatesCap = clampNumber(reduceSpec.maxCandidates, 1, 100000, 0);
      if (candidatesCap > 0 && Number(reducer.testedCandidates) > candidatesCap) warnings.push('tester 调用次数 ' + reducer.testedCandidates + ' 超过 reduce.maxCandidates=' + candidatesCap + '（mlir-reduce 无迭代上限开关，只能观察）');
      if (reducer.ok !== true && isPlainObject(reducer.error)) {
        if (action === 'reduce') {
          writeFailureArtifacts({ workDir, artifacts, action, inputPath, sourcePath, sha256: inputSha, pipeline, runnerArgs, crash: crashInfo, reducer, warnings, hints, startedAt, cfg });
          return failureEnvelope(reducer.error, { artifacts, warnings, hints, durationMs: elapsed(), crash: crashInfo, reducer });
        }
        // diagnose：缩减失败不阻断后续 bisect，整体降级为 status=partial（规格 3.5 第 8 步）。
        degraded.push({ stage: 'reduce', error: reducer.error });
        warnings.push('缩减未成功（' + reducer.error.code + '）：' + reducer.error.message + '（diagnose 继续做 pass 二分）');
        if (reducer.error.hint !== undefined && reducer.error.hint !== null) hints.push(String(reducer.error.hint));
      }
    } else {
      reducer.notes = ['未请求缩减'];
    }

    // 二分（规格 3.8 / 3.9）
    stage = 'bisect';
    const bisectSpec = isPlainObject(args.bisect) ? args.bisect : {};
    let bisect = {
      attempted: false,
      ok: false,
      strategy: null,
      totalPasses: 0,
      runs: 0,
      failingPass: null,
      failingIndex: null,
      passingPrefix: null,
      failingPrefix: null,
      evidence: [],
      notes: [],
    };
    const wantBisect = action === 'bisect' || (action === 'diagnose' && bisectSpec.enabled !== false);
    const passInfo = extractPasses(pipeline, passList);
    const bisectIr = reducer.ok === true && typeof reducer.outputPath === 'string' ? reducer.outputPath : inputPath;
    if (wantBisect) {
      if (passInfo.passes.length < 2) {
        if (passInfo.nested === true) {
          // 规格 3.8.1：只有一项且内部嵌套 -> warning PASS_NESTED、status=partial，但保留复现/缩减结果。
          const nestedError = {
            code: 'PASS_NESTED',
            message: 'pipeline 只有 1 个顶层 pass 且内部嵌套，v1 不拆嵌套，无法继续二分',
            hint: '用 passList=[...] 逐项列出顶层 pass（例如 ["func.func(cse)","func.func(canonicalize)"]）后重跑；也可以直接看这一个 pass 的崩溃输出。',
            stage: 'bisect',
          };
          warnings.push('PASS_NESTED：pipeline 只有 1 个顶层 pass 且内部嵌套，二分未启动（bisect.attempted=false）');
          hints.push(nestedError.hint);
          bisect.notes.push('跳过：唯一顶层 pass 内部嵌套（PASS_NESTED）');
          degraded.push({ stage: 'bisect', error: nestedError });
        } else if (action === 'bisect') {
          writeFailureArtifacts({ workDir, artifacts, action, inputPath, sourcePath, sha256: inputSha, pipeline, runnerArgs, crash: crashInfo, reducer, warnings, hints, startedAt, cfg });
          return failureEnvelope({
            code: 'PIPELINE_INVALID',
            message: 'pipeline 里没有可二分的顶层 pass',
            hint: '用 passList=[...] 明确列出顶层 pass，或把 pipeline 展开成多个顶层段。',
            stage: 'bisect',
          }, { artifacts, warnings, hints, durationMs: elapsed(), crash: crashInfo, reducer });
        } else {
          warnings.push('pipeline 没有可二分的顶层 pass（' + (passInfo.note === undefined ? '只有 ' + passInfo.passes.length + ' 段' : passInfo.note) + '），跳过二分');
          bisect.notes.push('跳过：顶层 pass 少于 2 段');
        }
      } else {
        const maxRuns = clampNumber(bisectSpec.maxRuns, 1, 1024, cfg.maxBisectRuns);
        const strategy = typeof bisectSpec.strategy === 'string' ? bisectSpec.strategy : 'auto';
        const bisectResult = await bisectPasses({
          runner,
          optPath: tools.mlirOpt.path,
          irPath: bisectIr,
          passes: passInfo.passes,
          wrapper: passInfo.wrapper,
          runnerArgs,
          maxRuns,
          timeoutMs,
          cwd: runCwd,
          env,
          crashExitCodes: cfg.crashExitCodes,
          crashPatterns: cfg.crashPatterns,
          stopAtFirst: bisectSpec.stopAtFirst === true || strategy === 'prefix',
          signal: opts.signal,
          logPath: join(workDir, 'passes.log'),
        });
        bisect = { ...bisect, ...bisectResult, evidence: Array.isArray(bisectResult.evidence) ? bisectResult.evidence : [], notes: Array.isArray(bisectResult.notes) ? bisectResult.notes : [] };
        if (typeof bisectResult.logPath === 'string') artifacts.passLogPath = bisectResult.logPath;
        else artifacts.passLogPath = join(workDir, 'passes.log');
        if (bisect.ok === true) {
          // print-ir 交叉验证（规格 3.9.3）：两边证据都保留，冲突就标出来。
          const cross = await crossCheckWithPrintIr({
            runner,
            optPath: tools.mlirOpt.path,
            irPath: bisectIr,
            pipeline: buildPrefixSafe(passInfo, passInfo.passes.length),
            passes: passInfo.passes,
            cwd: runCwd,
            timeoutMs,
            env,
            crashExitCodes: cfg.crashExitCodes,
            crashPatterns: cfg.crashPatterns,
            signal: opts.signal,
            runnerArgs,
            logPath: join(workDir, 'passes.log'),
          });
          if (cross.ran === true) {
            bisect.printIr = { matchedIndex: cross.matchedIndex, lastLabel: cross.lastLabel, groups: cross.groups };
            if (cross.matchedIndex !== null && bisect.failingIndex !== null && cross.matchedIndex !== bisect.failingIndex) {
              bisect.evidenceConflict = true;
              warnings.push('二分结论（第 ' + bisect.failingIndex + ' 个 pass）与 print-ir 实际顺序（第 ' + cross.matchedIndex + ' 个）冲突，两边证据都保留');
            }
          }
        } else if (isPlainObject(bisect.error)) {
          if (action === 'bisect') {
            writeFailureArtifacts({ workDir, artifacts, action, inputPath, sourcePath, sha256: inputSha, pipeline, runnerArgs, crash: crashInfo, reducer, bisect, warnings, hints, startedAt, cfg });
            return failureEnvelope(bisect.error, { artifacts, warnings, hints, durationMs: elapsed(), crash: crashInfo, reducer, bisect });
          }
          degraded.push({ stage: 'bisect', error: bisect.error });
          warnings.push('二分未成功（' + bisect.error.code + '）：' + bisect.error.message);
          hints.push(bisect.error.hint !== undefined && bisect.error.hint !== null ? String(bisect.error.hint) : '看 passes.log 里各前缀的退出码，或改 bisect.strategy=print-ir 交叉验证。');
        }
      }
    } else {
      bisect.notes.push('未请求二分');
    }

    // 收尾（规格 3.12 / 4）
    stage = 'report';
    const finalReducer = {
      attempted: reducer.attempted === true,
      ok: reducer.ok === true,
      inputPath: reducer.inputPath === undefined ? inputPath : reducer.inputPath,
      outputPath: reducer.outputPath === undefined ? null : reducer.outputPath,
      originalBytes: reducer.originalBytes === undefined ? null : reducer.originalBytes,
      reducedBytes: reducer.reducedBytes === undefined ? null : reducer.reducedBytes,
      reductionPercent: reducer.reductionPercent === undefined ? null : reducer.reductionPercent,
      iterations: reducer.iterations === undefined ? null : reducer.iterations,
      testedCandidates: reducer.testedCandidates === undefined ? 0 : reducer.testedCandidates,
      command: reducer.command === undefined ? null : reducer.command,
      logPath: join(workDir, 'reduce.log'),
      notes: Array.isArray(reducer.notes) ? reducer.notes : [],
    };
    const finalBisect = {
      attempted: bisect.attempted === true,
      ok: bisect.ok === true,
      strategy: bisect.strategy === undefined ? null : bisect.strategy,
      totalPasses: bisect.totalPasses === undefined ? passInfo.passes.length : bisect.totalPasses,
      runs: bisect.runs === undefined ? 0 : bisect.runs,
      failingPass: bisect.failingPass === undefined ? null : bisect.failingPass,
      failingIndex: bisect.failingIndex === undefined ? null : bisect.failingIndex,
      passingPrefix: bisect.passingPrefix === undefined ? null : bisect.passingPrefix,
      failingPrefix: bisect.failingPrefix === undefined ? null : bisect.failingPrefix,
      evidence: Array.isArray(bisect.evidence) ? bisect.evidence : [],
      notes: Array.isArray(bisect.notes) ? bisect.notes : [],
    };
    if (bisect.evidenceConflict === true) finalBisect.evidenceConflict = true;
    if (isPlainObject(bisect.printIr)) finalBisect.printIr = bisect.printIr;

    const reproducerPath = safeWrite(() => writeReproducer(workDir, reproducer));
    if (typeof reproducerPath === 'string') artifacts.reproducerPath = reproducerPath;

    // status 按请求阶段命名；diagnose 里任一阶段失败 -> partial + ok:false，但保留已有结果（规格 3.5 / 3.10）。
    const okStatus = action === 'diagnose' ? 'diagnosed' : (action === 'reduce' ? 'reduced' : 'bisected');
    const partial = degraded.length > 0;
    const primaryFailure = partial ? degraded[0].error : null;
    const result = {
      ok: partial === false,
      status: partial ? 'partial' : okStatus,
      action,
      version: VERSION,
      input: { irPath: sourcePath !== null ? sourcePath : inputPath, sha256: inputSha, pipeline: pipeline === '' ? null : pipeline, runner: 'mlir-opt', runnerArgs },
      crash: crashInfo,
      reducer: finalReducer,
      bisect: finalBisect,
      reproducer,
      artifacts,
      warnings,
      hints,
      durationMs: elapsed(),
    };
    if (primaryFailure !== null) {
      result.error = {
        code: String(primaryFailure.code),
        message: String(primaryFailure.message),
        hint: primaryFailure.hint === undefined ? null : primaryFailure.hint,
        stage: primaryFailure.stage === undefined ? null : primaryFailure.stage,
      };
      if (degraded.length > 1) result.failedStages = degraded.map((item) => ({ stage: item.stage, code: item.error.code }));
    }
    finalize({ result, workDir, artifacts, args, cfg, kind: partial ? 'partial' : 'success' });
    return result;
  } catch (error) {
    stage = error instanceof TriageError && error.stage !== null ? error.stage : stage;
    if (typeof artifacts.workDir === 'string' && artifacts.workDir !== '') {
      writeFailureArtifacts({ workDir: artifacts.workDir, artifacts, action: (typeof args.action === 'string' && args.action !== '' ? args.action : 'diagnose'), inputPath: null, sourcePath: null, sha256: null, pipeline: '', runnerArgs: [], crash: null, warnings, hints, startedAt, cfg });
    }
    const envelope = error instanceof TriageError
      ? failureEnvelope({ code: error.code, message: error.message, hint: error.hint, stage, detail: error.detail === undefined ? undefined : error.detail }, { artifacts, warnings, hints, durationMs: elapsed() })
      : failureEnvelope({ code: 'INTERNAL', message: describe(error), hint: '这是插件内部错误：把 result.json 和 stderr 一起反馈。', stage }, { artifacts, warnings, hints, durationMs: elapsed() });
    return envelope;
  }
}

/** 产物根目录：outputDir（必须落在会话 cwd 内）或配置里的 workDirRoot。 */
function resolveBaseDir(args, sessionCwd, cfg) {
  if (typeof args.outputDir === 'string' && args.outputDir !== '') {
    const target = resolve(sessionCwd, args.outputDir);
    if (isInside(sessionCwd, target) === false) fail('OUTPUT_DIR_ESCAPE', 'outputDir 越界：' + target, 'outputDir 必须落在会话 cwd（' + sessionCwd + '）之内。', 'workspace');
    return target;
  }
  return typeof cfg.workDirRoot === 'string' && cfg.workDirRoot !== '' ? cfg.workDirRoot : resolve(sessionCwd, '.crash-triage');
}

/** 认领一个本次运行的产物目录（<base>/<timestamp>-<ir-slug>，同名加 -2/-3）。 */
function claimWorkDir(baseDir, sourcePath) {
  try {
    return claimRunDir(baseDir, timestamp(new Date()) + '-' + irSlug(sourcePath, 'stdin'));
  } catch (error) {
    if (error instanceof TriageError) throw error;
    fail('WORKDIR_FAILED', '建产物目录失败：' + describe(error), '检查会话目录写权限，或用 outputDir 指到可写目录。', 'workspace');
  }
}

/** 无异常地跑一个写盘动作。 */
function safeWrite(fn) {
  try {
    const value = fn();
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) === false) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

/** 失败时的返回体（规格 3.12）。 */
function failureEnvelope(error, extra) {
  const info = isPlainObject(extra) ? extra : {};
  const out = {
    ok: false,
    status: 'failed',
    error: {
      code: String(error.code),
      message: String(error.message),
      hint: error.hint === undefined ? null : error.hint,
      stage: error.stage === undefined ? null : error.stage,
    },
    artifacts: isPlainObject(info.artifacts) ? info.artifacts : {},
    warnings: Array.isArray(info.warnings) ? info.warnings : [],
    durationMs: Number.isFinite(Number(info.durationMs)) ? Math.trunc(Number(info.durationMs)) : 0,
  };
  if (error.detail !== undefined) out.error.detail = error.detail;
  if (isPlainObject(info.crash)) out.crash = info.crash;
  if (isPlainObject(info.reducer)) out.reducer = info.reducer;
  if (isPlainObject(info.bisect)) out.bisect = info.bisect;
  if (Array.isArray(info.hints)) out.hints = info.hints;
  return out;
}

/** 写 result.json / report.md（失败路径也用，保证现场可查）。 */
function writeFailureArtifacts(input) {
  const info = isPlainObject(input) ? input : {};
  try {
    const partial = {
      ok: false,
      status: 'failed',
      action: info.action,
      version: VERSION,
      input: { irPath: info.sourcePath, sha256: info.sha256, pipeline: info.pipeline === '' ? null : info.pipeline, runner: 'mlir-opt', runnerArgs: info.runnerArgs },
      crash: info.crash,
      reducer: info.reducer === undefined ? null : info.reducer,
      bisect: info.bisect === undefined ? null : info.bisect,
      ...(isPlainObject(info.error) ? { error: info.error } : {}),
      artifacts: info.artifacts,
      warnings: info.warnings,
      hints: info.hints,
      durationMs: Date.now() - (Number.isFinite(Number(info.startedAt)) ? Number(info.startedAt) : Date.now()),
    };
    const resultPath = join(info.workDir, 'result.json');
    writeFileSync(resultPath, JSON.stringify(partial, null, 2), 'utf8');
    info.artifacts.resultPath = resultPath;
    const reportPath = join(info.workDir, 'report.md');
    writeFileSync(reportPath, renderReport(partial), 'utf8');
    info.artifacts.reportPath = reportPath;
  } catch {
    // 现场都写不了就只返回内存里的结果。
  }
}

/** 成功路径的收尾：写 result.json / report.md，按 keepWorkDir 决定是否清理。 */
function finalize(input) {
  const info = isPlainObject(input) ? input : {};
  const result = info.result;
  const artifacts = info.artifacts;
  const args = isPlainObject(info.args) ? info.args : {};
  const cfg = isPlainObject(info.cfg) ? info.cfg : {};
  const workDir = info.workDir;
  try {
    const resultPath = join(workDir, 'result.json');
    writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    artifacts.resultPath = resultPath;
  } catch {
    // result.json 写不下不算失败。
  }
  const format = isPlainObject(args.report) && typeof args.report.format === 'string' ? args.report.format : 'both';
  if (format !== 'json') {
    try {
      const reportPath = join(workDir, 'report.md');
      writeFileSync(reportPath, renderReport(result), 'utf8');
      artifacts.reportPath = reportPath;
    } catch {
      // report.md 写不下不算失败。
    }
  }
  const keep = args.keepWorkDir !== undefined ? args.keepWorkDir !== false : cfg.keepWorkDir !== false;
  // 规格 4.3：keepWorkDir=false 只在成功后清理；失败/降级仍保留现场。
  if (keep === false && result.ok === true) {
    try {
      rmSync(workDir, { recursive: true, force: true });
      for (const key of Object.keys(artifacts)) artifacts[key] = null;
      result.warnings.push('keepWorkDir=false：产物目录已删除（' + workDir + '）');
    } catch (error) {
      result.warnings.push('删除产物目录失败：' + describe(error));
    }
  }
}

/** 组装前缀 pipeline（bisect 内部也用同样规则，这里只给 print-ir 交叉验证用）。 */
function buildPrefixSafe(passInfo, count) {
  const info = isPlainObject(passInfo) ? passInfo : {};
  const passes = Array.isArray(info.passes) ? info.passes : [];
  const take = Math.max(0, Math.min(passes.length, Number.isFinite(Number(count)) ? Math.trunc(Number(count)) : 0));
  const body = passes.slice(0, take).join(',');
  const wrapped = info.wrapper === null || info.wrapper === undefined ? body : String(info.wrapper) + '(' + body + ')';
  return wrapped;
}

/**
 * 解析 sanitizer（规格 3.11 / 6.1 第 4 条）：显式 asan/ubsan 或 reportPath 找不到报告就报错，auto 只告警。
 * @returns {output, error, reportPath}
 */
function resolveSanitizer(args, cfg, baseline, workDir, runCwd, warnings) {
  const spec = isPlainObject(args.sanitizer) ? args.sanitizer : {};
  const mode = ['auto', 'off', 'asan', 'ubsan'].includes(spec.mode) ? spec.mode : (cfg.sanitizerMode || 'auto');
  if (mode === 'off') return { output: null, error: null, reportPath: null };
  const explicit = mode === 'asan' || mode === 'ubsan' || (typeof spec.reportPath === 'string' && spec.reportPath !== '');
  let text = '';
  let source = 'stderr';
  let reportPath = null;
  if (typeof spec.reportPath === 'string' && spec.reportPath !== '') {
    reportPath = isAbsolute(spec.reportPath) ? spec.reportPath : resolve(runCwd, spec.reportPath);
    if (existsSync(reportPath) === false) {
      return { output: null, reportPath: null, error: { code: 'SANITIZER_NOT_FOUND', message: 'sanitizer 报告不存在：' + reportPath, hint: '检查 sanitizer.reportPath（相对 cwd 解析）；v1 只解析外部日志，不生成 sanitizer 报告。', stage: 'sanitizer' } };
    }
    try {
      text = normalizeText(readFileSync(reportPath, 'utf8'));
      source = 'report';
    } catch (error) {
      return { output: null, reportPath: null, error: { code: 'SANITIZER_PARSE_FAILED', message: '读 sanitizer 报告失败：' + describe(error), hint: '确认文件是 UTF-8 文本且可读。', stage: 'sanitizer' } };
    }
  } else if (typeof spec.inline === 'string' && spec.inline !== '') {
    text = normalizeText(spec.inline);
    source = 'inline';
  } else {
    text = normalizeText((baseline.stderr || '') + '\n' + (baseline.stdout || ''));
  }
  const parsed = parseSanitizer(text);
  if (parsed === null || parsed.kind === null) {
    if (explicit) {
      return { output: null, reportPath: null, error: { code: 'SANITIZER_NOT_FOUND', message: '请求了解析 ' + mode + ' 报告，但输入里没有 sanitizer 报告', hint: '把 ASan/UBSan 的日志写到文件后传 sanitizer.reportPath，或改用 sanitizer.mode=auto。', stage: 'sanitizer' } };
    }
    warnings.push('SANITIZER_NOT_FOUND: 没有 sanitizer 报告，按原生信号/断言崩溃继续（v1 只收外部报告）');
    return { output: null, error: null, reportPath: null };
  }
  if ((mode === 'asan' && parsed.kind !== 'asan') || (mode === 'ubsan' && parsed.kind !== 'ubsan')) {
    return { output: null, reportPath: null, error: { code: 'SANITIZER_NOT_FOUND', message: '报告类型是 ' + parsed.kind + '，与请求的 ' + mode + ' 不一致', hint: '改用 sanitizer.mode=auto，或换成对应类型的报告。', stage: 'sanitizer' } };
  }
  const maxFrames = clampNumber(spec.maxFrames, 1, 200, cfg.maxFrames);
  try {
    writeFileSync(join(workDir, 'sanitizer.log'), text, 'utf8');
  } catch {
    // 写不下 sanitizer.log 不影响解析结果。
  }
  return { output: toSanitizerOutput(parsed, { reportPath, source, maxFrames }), error: null, reportPath: reportPath === null ? join(workDir, 'sanitizer.log') : reportPath };
}
