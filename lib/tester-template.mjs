/**
 * mlir-reduce 的 interestingness tester（由 dsh-crash-triage 在运行时复制到产物目录）。
 *
 * 调用协议（实测，LLVM 23.1.4）：
 *   mlir-reduce <input.mlir> '-reduction-tree=test=<node.exe> test-arg=<本文件> test-arg=<config.json>' -o <out.mlir>'
 * mlir-reduce 通过 ExecuteAndWait 启动 tester，argv 布局是
 *   [node.exe, 本文件, <test-arg...>, 候选 IR]
 * 第一个 testCase 被当成 argv[0] 吃掉，候选 IR 在最后一位 —— 所以这里从后往前找 .mlir。
 *
 * 退出码语义（以 mlir/lib/Reducer/Tester.cpp:78-81 为准）：
 *   非零 = interesting（仍有同一个崩溃）
 *   0    = 不 interesting
 * tester 自身出错时返回 0（不 interesting），避免 mlir-reduce 把故障当成 interesting 保留垃圾。
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const configPath = process.argv[2];

function log(path, payload) {
  if (typeof path !== 'string' || path === '') return;
  try {
    appendFileSync(path, JSON.stringify(payload) + '\n');
  } catch {
    // 日志写不进去不影响 interestingness 判定。
  }
}

function findCandidate(configPath_) {
  for (let index = process.argv.length - 1; index >= 3; index -= 1) {
    const value = process.argv[index];
    if (value === configPath_) continue;
    if (!/\.mlir$/i.test(value)) continue;
    if (existsSync(value)) return value;
  }
  for (let index = process.argv.length - 1; index >= 3; index -= 1) {
    const value = process.argv[index];
    if (value === configPath_) continue;
    if (existsSync(value)) return value;
  }
  return null;
}

async function main() {
  if (typeof configPath !== 'string' || !existsSync(configPath)) return 0;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const candidate = findCandidate(configPath);
  if (candidate === null) {
    log(config.testerLogPath, { error: 'tester 找不到候选 IR', argv: process.argv });
    return 0;
  }

  const { buildRunSignature } = await import(config.sanitizeModuleUrl);
  const args = [];
  if (typeof config.pipeline === 'string' && config.pipeline.trim() !== '') args.push('--pass-pipeline=' + config.pipeline.trim());
  for (const item of Array.isArray(config.runnerArgs) ? config.runnerArgs : []) {
    if (typeof item === 'string' && item !== '') args.push(item);
  }
  args.push(candidate);

  const startedAt = Date.now();
  const result = spawnSync(config.optPath, args, {
    cwd: config.cwd,
    encoding: 'utf8',
    timeout: config.timeoutMs,
    maxBuffer: config.maxBuffer,
    windowsHide: true,
  });

  if (result.error !== undefined && result.error !== null) {
    log(config.testerLogPath, {
      error: 'spawn 失败：' + String(result.error.message || result.error),
      candidate,
      args,
      stdout: typeof result.stdout === 'string' ? result.stdout.slice(0, 4000) : '',
    });
    return 0;
  }

  const outcome = {
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal === undefined ? null : result.signal,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
  const { signature, parsed, classified } = buildRunSignature(outcome, config);
  const interesting = classified.crashed === true && signature.key === config.expectedSignatureKey;

  log(config.testerLogPath, {
    candidate,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    crashed: classified.crashed,
    kind: classified.kind,
    sanitizer: parsed.kind,
    signatureKey: signature.key,
    interesting,
    durationMs: Date.now() - startedAt,
  });
  return interesting ? 1 : 0;
}

let code = 0;
try {
  code = await main();
} catch (error) {
  log(process.argv[2], { error: 'tester 内部异常：' + String(error !== null && typeof error === 'object' ? error.message : error) });
  code = 0;
}
process.exit(code);
