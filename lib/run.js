import { normalizeText } from './classify.js';

/**
 * 组装 mlir-opt 的 argv（规格 3.4）：[mlir-opt, --pass-pipeline=..., ...runnerArgs, irPath]。
 * @param input.optPath - mlir-opt 绝对路径。
 * @param input.irPath - 输入 IR。
 * @param input.pipeline - pass pipeline（可选）。
 * @param input.runnerArgs - 额外参数（原样追加）。
 * @returns argv 数组。
 */
export function buildMlirArgv(input) {
  const opts = input !== null && typeof input === 'object' ? input : {};
  const argv = [opts.optPath];
  if (typeof opts.pipeline === 'string' && opts.pipeline.trim() !== '') argv.push('--pass-pipeline=' + opts.pipeline.trim());
  const extra = Array.isArray(opts.runnerArgs) ? opts.runnerArgs : [];
  for (const item of extra) {
    if (typeof item === 'string' && item !== '') argv.push(item);
  }
  argv.push(opts.irPath);
  return argv;
}

/**
 * 跑一次 mlir-opt，把 stdout/stderr 收成字符串（超时/取消归一，不抛异常）。
 * @param runner - createSubprocessRunner 的产物。
 * @param input - 见 buildMlirArgv，另加 cwd / timeoutMs / env。
 * @returns 归一化后的运行结果。
 */
export async function runMlirOpt(runner, input) {
  const opts = input !== null && typeof input === 'object' ? input : {};
  const argv = buildMlirArgv(opts);
  const result = await runner(argv, {
    cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
    env: opts.env !== undefined && opts.env !== null ? opts.env : undefined,
    signal: opts.signal,
  });
  return { ...result, argv, stdout: normalizeText(result.stdout), stderr: normalizeText(result.stderr) };
}

/** 把 argv 拼成可直接粘贴的命令行（Windows 用 cmd 风格加引号）。 */
export function formatCommandLine(argv) {
  const list = Array.isArray(argv) ? argv : [];
  return list.map((item) => {
    const value = String(item);
    if (value === '' || /[\s"]/.test(value)) return '"' + value.replace(/"/g, '\\"') + '"';
    return value;
  }).join(' ');
}
