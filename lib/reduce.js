import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRunSignature } from './sanitize.js';
import { runMlirOpt } from './run.js';

/** tester 模板与 sanitize 模块的绝对路径（复制出去之后仍要能 import 回来）。 */
const TESTER_TEMPLATE = fileURLToPath(new URL('./tester-template.mjs', import.meta.url));
const SANITIZE_MODULE_URL = pathToFileURL(fileURLToPath(new URL('./sanitize.js', import.meta.url))).href;

/** mlir-reduce 打印这条时说明初始模块就不 interesting。 */
const UNINTERESTED = 'uninterested module will not be reduced';

/**
 * 组装 mlir-reduce 的 argv（规格 3.7.1 + spike 实测）：
 *   [mlir-reduce, input.mlir, '-reduction-tree=test=<node> test-arg=<tester> test-arg=<cfg>', '-o', out.mlir]
 * 注意 test/ test-arg 是 reduction-tree pass 的子选项，必须放在同一个 argv 元素里用空格分隔。
 * @returns argv 数组。
 */
export function buildReduceArgv(input) {
  const opts = input !== null && typeof input === 'object' ? input : {};
  const testerOption = '-reduction-tree=test=' + opts.nodePath
    + ' test-arg=' + opts.testerPath
    + ' test-arg=' + opts.configPath;
  return [opts.reducePath, opts.inputPath, testerOption, '-o', opts.outPath];
}

/** 路径里有空格时，mlir-reduce 的选项串会被切开；把 tester 挪到无空格的临时目录。 */
function relocateIfNeeded(paths) {
  for (const value of paths) {
    if (typeof value === 'string' && /\s/.test(value)) return true;
  }
  return false;
}

/**
 * 用 mlir-reduce 缩小 IR（规格 3.7）。
 *
 * @param options.runner - subprocess runner。
 * @param options.reducePath / options.optPath / options.nodePath - 可执行文件。
 * @param options.inputPath - 工作目录里的 input.mlir。
 * @param options.outPath - reduced.mlir 目标路径。
 * @param options.pipeline / runnerArgs / cwd - 原始运行参数（tester 要复现同一 pipeline）。
 * @param options.timeoutMs - mlir-reduce 的超时。
 * @param options.expectedSignatureKey - baseline 的签名 key。
 * @param options.crashExitCodes / crashPatterns - 判定崩溃用。
 * @param options.testerLogPath / options.reduceLogPath - 日志路径。
 * @param options.maxIterations - 观察值（mlir-reduce 23.1.4 没有迭代上限开关，只用超时兜底）。
 * @returns 缩减结果；失败时 ok:false + code（不抛异常）。
 */
export async function reduceIr(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const notes = [];
  const warnings = [];
  let testerDir = opts.workDir;
  let testerPath = join(testerDir, 'tester.mjs');
  let configPath = join(testerDir, 'tester.json');
  if (relocateIfNeeded([opts.nodePath, opts.optPath, testerPath, configPath])) {
    testerDir = join(tmpdir(), 'dsh-crash-triage-tester-' + process.pid);
    testerPath = join(testerDir, 'tester.mjs');
    configPath = join(testerDir, 'tester.json');
    warnings.push('产物路径包含空格，tester 已临时放到 ' + testerDir + '（mlir-reduce 的 test= 选项按空格切分）');
  }
  try {
    mkdirSync(testerDir, { recursive: true });
    writeFileSync(testerPath, readFileSync(TESTER_TEMPLATE, 'utf8'), 'utf8');
    writeFileSync(configPath, JSON.stringify({
      optPath: opts.optPath,
      pipeline: typeof opts.pipeline === 'string' && opts.pipeline.trim() !== '' ? opts.pipeline.trim() : null,
      runnerArgs: Array.isArray(opts.runnerArgs) ? opts.runnerArgs : [],
      cwd: typeof opts.cwd === 'string' ? opts.cwd : process.cwd(),
      timeoutMs: Number.isFinite(Number(opts.testerTimeoutMs)) ? Math.trunc(Number(opts.testerTimeoutMs)) : 60000,
      maxBuffer: 64 * 1024 * 1024,
      crashExitCodes: Array.isArray(opts.crashExitCodes) ? opts.crashExitCodes : [],
      crashPatterns: Array.isArray(opts.crashPatterns) ? opts.crashPatterns : [],
      expectedSignatureKey: typeof opts.expectedSignatureKey === 'string' ? opts.expectedSignatureKey : null,
      sanitizeModuleUrl: SANITIZE_MODULE_URL,
      testerLogPath: opts.testerLogPath,
    }, null, 2), 'utf8');
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: { code: 'WORKDIR_FAILED', message: '写 tester 失败：' + describe(error), hint: '检查会话目录是否可写，或把 workDir 指到可写位置。' },
      notes,
      warnings,
    };
  }

  const argv = buildReduceArgv({
    reducePath: opts.reducePath,
    inputPath: opts.inputPath,
    nodePath: opts.nodePath,
    testerPath,
    configPath,
    outPath: opts.outPath,
  });

  let runResult;
  try {
    runResult = await opts.runner(argv, {
      cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
      timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
      signal: opts.signal,
    });
  } catch (error) {
    return { attempted: true, ok: false, error: { code: 'REDUCE_FAILED', message: '启动 mlir-reduce 失败：' + describe(error), hint: '检查 mlirReducePath 是否指向可执行的 mlir-reduce。' }, notes, warnings, command: argv };
  }

  if (typeof opts.reduceLogPath === 'string' && opts.reduceLogPath !== '') {
    try {
      writeFileSync(opts.reduceLogPath, '# mlir-reduce\n# argv: ' + JSON.stringify(argv)
        + '\n# exitCode: ' + String(runResult.exitCode === undefined ? null : runResult.exitCode)
        + '  signal: ' + String(runResult.signal === undefined || runResult.signal === null ? '(无)' : runResult.signal)
        + '\n\n[stdout]\n' + runResult.stdout + '\n\n[stderr]\n' + runResult.stderr + '\n', 'utf8');
    } catch {
      // 日志写失败不影响判定。
    }
  }

  const testedCandidates = countTestedCandidates(opts.testerLogPath);
  const base = {
    attempted: true,
    command: argv,
    testedCandidates,
    iterations: null,
    exitCode: runResult.exitCode === undefined ? null : runResult.exitCode,
    signal: runResult.signal === undefined ? null : runResult.signal,
    notes,
    warnings,
  };

  if (runResult.timedOut) {
    return { ...base, ok: false, error: { code: 'REDUCE_TIMEOUT', message: 'mlir-reduce 超时（' + opts.timeoutMs + 'ms）', hint: '调大 reduce.maxTimeMs 或先用更小的输入试。' } };
  }
  // 空输出：mlir-reduce 常常在解析/改写输入时自己就崩了（深嵌套 IR 很典型），此时 -o 只剩空文件。
  if (safeSize(opts.outPath) === 0) {
    const code = Number.isFinite(Number(runResult.exitCode)) ? Number(runResult.exitCode) : null;
    const crashed = code !== null && Array.isArray(opts.crashExitCodes) && opts.crashExitCodes.includes(code);
    return {
      ...base,
      ok: false,
      error: {
        code: 'REDUCE_FAILED',
        message: 'mlir-reduce ' + (crashed ? '自身崩溃（退出码 ' + String(code) + '）' : '没有产出内容') + '，reduced.mlir 是空文件',
        hint: '这条输入在 mlir-reduce 内部解析/改写时就会崩：换更小的输入，或先按 pass 级复现（加深嵌套深度）再缩。',
      },
    };
  }
  if (testerErrorsOnly(opts.testerLogPath) && testedCandidates > 0) {
    return { ...base, ok: false, error: { code: 'REDUCE_TESTER_PROTOCOL', message: 'tester 每次调用都报错，mlir-reduce 的 interestingness 不可信', hint: '检查 tester.log 里的 error 行（多为 mlir-opt 路径或权限问题）。' } };
  }
  if (!existsSync(opts.outPath)) {
    const detail = (runResult.stderr || '').includes(UNINTERESTED)
      ? '初始 IR 对 tester 不 interesting（签名与 baseline 不一致或根本没崩）'
      : 'mlir-reduce 没有写出结果文件';
    return {
      ...base,
      ok: false,
      error: { code: 'REDUCE_FAILED', message: detail, hint: '先确认 crash.stable 为 true，再重试；必要时把 sanitizer 报告交给插件以稳定签名。' },
    };
  }

  // 缩减完必须用原始 pipeline 复验（规格 3.7.4）。
  const originalBytes = safeSize(opts.inputPath);
  const reducedBytes = safeSize(opts.outPath);
  const verify = await runMlirOpt(opts.runner, {
    optPath: opts.optPath,
    irPath: opts.outPath,
    pipeline: opts.pipeline,
    runnerArgs: opts.runnerArgs,
    cwd: opts.cwd,
    timeoutMs: opts.testerTimeoutMs,
    signal: opts.signal,
  });
  const verified = buildRunSignature(verify, { crashExitCodes: opts.crashExitCodes, crashPatterns: opts.crashPatterns });
  const same = verified.classified.crashed === true && verified.signature.key === opts.expectedSignatureKey;
  const reductionPercent = originalBytes !== null && originalBytes > 0 && reducedBytes !== null
    ? Math.round((1 - reducedBytes / originalBytes) * 1000) / 10
    : null;

  if (!same) {
    const lastGood = join(opts.workDir, 'last-good.mlir');
    try {
      copyFileSync(opts.outPath, lastGood);
    } catch {
      // 复制失败只是少了 last-good，不改变判定。
    }
    notes.push('缩减结果复验失败：' + (verified.classified.crashed ? '签名变为 ' + verified.signature.key : '不再崩溃（' + verified.classified.reason + '）'));
    return {
      ...base,
      ok: false,
      inputPath: opts.inputPath,
      outputPath: opts.outPath,
      originalBytes,
      reducedBytes,
      reductionPercent,
      error: {
        code: 'REDUCE_UNSTABLE',
        message: '缩减后的 IR 复验不产生同一个崩溃，已保留 last-good.mlir',
        hint: '崩溃可能不稳定，或 tester 与主流程的判定条件不一致；先确认 crash.stable，再重试。',
      },
    };
  }

  return {
    ...base,
    ok: true,
    inputPath: opts.inputPath,
    outputPath: opts.outPath,
    originalBytes,
    reducedBytes,
    reductionPercent,
    signature: verified.signature,
    exitCode: verify.exitCode,
    notes,
    warnings,
  };
}

/** 统计 tester 调用次数（每行一次）。 */
function countTestedCandidates(testerLogPath) {
  if (typeof testerLogPath !== 'string' || testerLogPath === '' || !existsSync(testerLogPath)) return 0;
  try {
    return readFileSync(testerLogPath, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

/** tester 日志里是否「全是 error、没有一次正常判定」。 */
function testerErrorsOnly(testerLogPath) {
  if (typeof testerLogPath !== 'string' || testerLogPath === '' || !existsSync(testerLogPath)) return false;
  try {
    const lines = readFileSync(testerLogPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) return false;
    let errors = 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string') errors += 1;
      } catch {
        // 坏行不算错误，只忽略。
      }
    }
    return errors === lines.length;
  } catch {
    return false;
  }
}

function safeSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function describe(error) {
  return error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
}
