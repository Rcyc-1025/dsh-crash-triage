import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../lib/config.js';
import { runTriage } from '../lib/tools.js';

/**
 * 真实 mlir-opt 冒烟：不依赖宿主 subprocess，用 spawnSync 模拟 runner 接口。
 * 说明：深度嵌套的解析崩溃在 mlir-reduce 的 verify 里同样会触发，
 * 所以冒烟只覆盖「复现 / 分类 / 日志 / 报告」，缩减与二分由 mock 单测覆盖。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MLIR_OPT = process.env.CRASH_TRIAGE_MLIR_OPT || 'D:\\Code\\llvm-build\\bin\\mlir-opt.exe';
const MLIR_REDUCE = process.env.CRASH_TRIAGE_MLIR_REDUCE || 'D:\\Code\\llvm-build\\bin\\mlir-reduce.exe';
const DEBUG = process.env.CRASH_TRIAGE_DEBUG === '1';
let runSeq = 0;
let ioDir = process.cwd();

/** 用文件承接 stdio 而不是管道：受限沙箱里管道会 EPERM。 */
function localRunner(argv, options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const startedAt = Date.now();
  const tag = String(runSeq += 1);
  const outPath = join(ioDir, 'out-' + tag + '.log');
  const errPath = join(ioDir, 'err-' + tag + '.log');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(argv[0], argv.slice(1), {
      cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
      timeout: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      env: { ...process.env, ...(opts.env !== null && typeof opts.env === 'object' ? opts.env : {}) },
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  const stderr = existsSync(errPath) ? readFileSync(errPath, 'utf8') : '';
  if (DEBUG) console.log('DEBUG run:', JSON.stringify(argv.slice(1)), '-> status=' + String(result.status) + ' signal=' + String(result.signal) + ' error=' + String(result.error && result.error.code));
  return {
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal === undefined ? null : result.signal,
    stdout,
    stderr,
    truncated: false,
    lossy: false,
    timedOut: result.error !== undefined && result.error !== null && result.error.code === 'ETIMEDOUT',
    durationMs: Date.now() - startedAt,
    error: result.error !== undefined && result.error !== null ? String(result.error.message) : null,
  };
}

if (existsSync(MLIR_OPT) === false) {
  console.log('SKIP smoke: 没找到 mlir-opt（' + MLIR_OPT + '），设置 CRASH_TRIAGE_MLIR_OPT 后再跑。');
  process.exit(0);
}

const tmpRoot = join(ROOT, 'test', '.tmp');
mkdirSync(tmpRoot, { recursive: true });
const session = mkdtempSync(join(tmpRoot, 'smoke-'));
ioDir = join(session, 'io');
mkdirSync(ioDir, { recursive: true });
const config = resolveConfig({
  mlirOptPath: MLIR_OPT,
  mlirReducePath: existsSync(MLIR_REDUCE) ? MLIR_REDUCE : '',
  timeoutMs: 60000,
}, session);

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: condition === true, detail: detail === undefined ? '' : String(detail) });
}

try {
  // 1) 不崩的 IR：正常诊断，退回 NOT_A_CRASH 而不是抛异常
  const verifier = await runTriage({ action: 'diagnose', reduce: { enabled: false }, bisect: { enabled: false }, irPath: join(ROOT, 'fixtures', 'not-crash', 'verifier-error.mlir') }, { config, runner: localRunner, sessionCwd: session });
  check('verifier-error 判定 NOT_A_CRASH（不抛异常）', verifier.ok === false && verifier.error !== undefined && verifier.error.code === 'NOT_A_CRASH', verifier.error === undefined ? '' : JSON.stringify(verifier.error));
  check('失败也写出 baseline 日志与 result.json', verifier.artifacts !== undefined
    && typeof verifier.artifacts.workDir === 'string'
    && existsSync(join(verifier.artifacts.workDir, 'baseline.stderr.log'))
    && existsSync(join(verifier.artifacts.workDir, 'result.json')));
  check('verifier 诊断能带出来', verifier.crash !== undefined && String(verifier.crash.stderrExcerpt).includes('func.return'), verifier.crash === undefined ? '' : verifier.crash.stderrExcerpt);

  // 2) 600 层嵌套：合法但很深，也不崩
  const deep = await runTriage({ action: 'diagnose', reduce: { enabled: false }, bisect: { enabled: false }, irPath: join(ROOT, 'fixtures', 'not-crash', 'deep-600.mlir') }, { config, runner: localRunner, sessionCwd: session });
  check('deep-600 不崩', deep.ok === false && deep.error !== undefined && deep.error.code === 'NOT_A_CRASH', deep.error === undefined ? '' : JSON.stringify(deep.error));

  // 3) 真实崩溃：4000 层嵌套让 mlir-opt 解析期栈溢出
  const crash = await runTriage({
    irPath: join(ROOT, 'fixtures', 'crash', 'access-violation.mlir'),
    reduce: { enabled: false },
    bisect: { enabled: false },
  }, { config, runner: localRunner, sessionCwd: session });
  check('真实崩溃复现 ok:true', crash.ok === true, crash.error === undefined ? '' : crash.error.code + ' ' + crash.error.message);
  if (crash.crash !== undefined) {
    check('crash.reproduced=true 且 stable=true', crash.crash.reproduced === true && crash.crash.stable === true, 'reproduced=' + String(crash.crash.reproduced) + ' stable=' + String(crash.crash.stable) + ' attempts=' + String(crash.crash.attempts));
    check('崩溃退出码被识别（3221225477 / signal）', crash.crash.exitCode === 3221225477 || crash.crash.kind === 'signal', 'exit=' + String(crash.crash.exitCode) + ' kind=' + String(crash.crash.kind) + ' signal=' + String(crash.crash.signal));
    check('签名 key 非空', typeof crash.crash.signature.key === 'string' && crash.crash.signature.key !== '', String(crash.crash.signature.key));
  }
  const workDir = crash.artifacts !== undefined && typeof crash.artifacts.workDir === 'string' ? crash.artifacts.workDir : null;
  check('写出 baseline 日志', workDir !== null && existsSync(join(workDir, 'baseline.stderr.log')) && existsSync(join(workDir, 'baseline.stdout.log')));
  check('写出 result.json / report.md / reproducer.txt', workDir !== null && existsSync(join(workDir, 'result.json')) && existsSync(join(workDir, 'report.md')) && existsSync(join(workDir, 'reproducer.txt')));
  check('复现命令带工作目录里的 input.mlir', crash.reproducer !== undefined && String(crash.reproducer.text).includes('input.mlir'), crash.reproducer === undefined ? '' : crash.reproducer.text);

  // 4) action=parse：只解析 sanitizer 报告，不启动 mlir-opt
  const parsed = await runTriage({ action: 'parse', sanitizer: { inline: readFileSync(join(ROOT, 'fixtures', 'crash', 'asan-uaf.log'), 'utf8') } }, { config, runner: localRunner, sessionCwd: session });
  check('parse 只解析 sanitizer → ok:true / status=parsed', parsed.ok === true && parsed.status === 'parsed', parsed.error === undefined ? '' : JSON.stringify(parsed.error));
  check('parse 解析出 asan 栈', parsed.crash !== undefined && parsed.crash.kind === 'asan' && parsed.crash.sanitizer !== undefined && parsed.crash.sanitizer.frames.length > 0, parsed.crash === undefined ? '' : String(parsed.crash.kind));
} finally {
  if (process.env.CRASH_TRIAGE_KEEP_SMOKE === '1') console.log('保留现场：' + session);
  else rmSync(session, { recursive: true, force: true });
}

for (const item of checks) console.log((item.ok === true ? 'PASS ' : 'FAIL ') + item.name + (item.detail === '' ? '' : ' — ' + item.detail));
const failed = checks.filter((item) => item.ok !== true);
console.log('');
console.log('smoke: ' + (checks.length - failed.length) + '/' + checks.length + ' 通过');
process.exit(failed.length === 0 ? 0 : 1);
