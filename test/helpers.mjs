import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resolveConfig } from '../lib/config.js';

/** 崩溃默认 stderr（含 LLVM 特征行，classify 判 llvm-error）。 */
export const CRASH_STDERR = 'LLVM ERROR: boom\nStack dump:\n  0. Running pass "canonicalize" on "func.func"\n';

/** 建一个可用的临时会话目录（测完删）。 */
export function makeSession(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'crash-triage-' + (prefix || 'test') + '-'));
  return {
    root,
    write(relativePath, content) {
      const target = join(root, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      return target;
    },
    read(relativePath) {
      return readFileSync(join(root, relativePath), 'utf8');
    },
    exists(relativePath) {
      return existsSync(join(root, relativePath));
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 临时目录删不掉不影响测试结论。
      }
    },
  };
}

/** 数 pipeline 里顶层 pass 段数：builtin.module(a,b(c),d) → 3。 */
export function countTopPasses(pipeline) {
  const text = typeof pipeline === 'string' ? pipeline.trim() : '';
  if (text === '') return 0;
  const head = 'builtin.module(';
  const body = text.startsWith(head) && text.endsWith(')') ? text.slice(head.length, -1) : text;
  if (body.trim() === '') return 0;
  let depth = 0;
  let count = 1;
  for (const char of body) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) count += 1;
  }
  return count;
}

/** 统一的结果形状（和宿主 runner 的返回体一致）。 */
function result(exitCode, stdout, stderr) {
  return { exitCode, signal: null, stdout, stderr, truncated: false, lossy: false, timedOut: false, durationMs: 1, error: null };
}

/**
 * 造一个 mlir-opt / mlir-reduce 的假 runner，用来在无 LLVM 的机器上验流程。
 * plan.crashAlways：每次 mlir-opt 都崩。
 * plan.crashAtPassCount：pipeline 里顶层 pass 数 >= n 才崩（二分用）。
 * plan.crashWhenIrIncludes：IR 里含该字符串才崩。
 * plan.reduceWrites=false：mlir-reduce 不写 -o 输出（验 REDUCE_FAILED）。
 * plan.reduceWrites='empty'：mlir-reduce 自己崩了，-o 只剩空文件（reduceExitCode 指定退出码）。
 */
export function createMockRunner(plan) {
  const options = plan !== null && typeof plan === 'object' ? plan : {};
  const state = { runs: 0, optRuns: 0, reduceRuns: 0, pipelines: [], argv: [] };
  const crashExit = Number.isFinite(Number(options.crashExitCode)) ? Number(options.crashExitCode) : 3221225477;
  const crashStderr = typeof options.crashStderr === 'string' ? options.crashStderr : CRASH_STDERR;

  async function run(argv, spawnOptions) {
    state.runs += 1;
    state.argv.push(argv);
    const exe = basename(String(argv[0])).toLowerCase();
    if (exe.includes('mlir-reduce')) {
      state.reduceRuns += 1;
      const outIndex = argv.indexOf('-o');
      const outPath = outIndex >= 0 ? argv[outIndex + 1] : null;
      const testerLog = join(dirname(String(outPath)), 'tester.log');
      if (options.reduceWrites === 'empty') {
        // 模拟 mlir-reduce 自己崩掉：退出码是崩溃码、-o 留下空文件。
        if (typeof outPath === 'string') writeFileSync(outPath, '', 'utf8');
        return result(Number.isFinite(Number(options.reduceExitCode)) ? Number(options.reduceExitCode) : 3221225477, '', '');
      }
      if (options.reduceWrites !== false && typeof outPath === 'string') {
        writeFileSync(outPath, 'module {\n}\n', 'utf8');
        writeFileSync(testerLog, [1, 2, 3].map((index) => JSON.stringify({ candidate: 'c' + index, crashed: true, interesting: true })).join('\n') + '\n', 'utf8');
      }
      return result(0, '', '');
    }

    state.optRuns += 1;
    const irPath = String(argv[argv.length - 1]);
    let irText = '';
    if (existsSync(irPath)) {
      try {
        irText = readFileSync(irPath, 'utf8');
      } catch {
        irText = '';
      }
    }
    const pipelineArg = argv.find((item) => typeof item === 'string' && item.startsWith('--pass-pipeline='));
    const pipeline = pipelineArg === undefined ? '' : pipelineArg.slice('--pass-pipeline='.length);
    state.pipelines.push(pipeline);

    let crashed = options.crashAlways === true;
    if (Number.isFinite(Number(options.crashAtPassCount)) && countTopPasses(pipeline) >= Number(options.crashAtPassCount)) crashed = true;
    if (typeof options.crashWhenIrIncludes === 'string' && irText.includes(options.crashWhenIrIncludes)) crashed = true;
    if (crashed) return result(crashExit, '', crashStderr);
    return result(0, 'module {\n}\n', '');
  }

  return { run, state };
}

/** 用 mock 工具链组装一份「能通过工具、fake 可执行文件」的配置。 */
export function mockConfig(sessionRoot, extra) {
  const cfg = resolveConfig({
    mlirOptPath: join(sessionRoot, 'fake-mlir-opt.exe'),
    mlirReducePath: join(sessionRoot, 'fake-mlir-reduce.exe'),
    ...(extra !== null && typeof extra === 'object' ? extra : {}),
  }, sessionRoot);
  // resolveMlirTools 会检查 existsSync；测试里直接标可执行文件存在。
  writeFileSync(join(sessionRoot, 'fake-mlir-opt.exe'), 'fake', 'utf8');
  writeFileSync(join(sessionRoot, 'fake-mlir-reduce.exe'), 'fake', 'utf8');
  return cfg;
}
