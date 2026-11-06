import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReduceArgv, reduceIr } from '../lib/reduce.js';
import { buildRunSignature } from '../lib/sanitize.js';
import { CRASH_STDERR, createMockRunner, makeSession } from './helpers.mjs';

const CRASH_CODES = [3221225477];
const PATTERNS = ['LLVM ERROR:', 'Stack dump:'];

function expectedKey() {
  return buildRunSignature({ exitCode: 3221225477, signal: null, stdout: '', stderr: CRASH_STDERR }, { crashExitCodes: CRASH_CODES, crashPatterns: PATTERNS }).signature.key;
}

test('buildReduceArgv：reduction-tree 的 test / test-arg 挤在同一个 argv 元素里', () => {
  const argv = buildReduceArgv({
    reducePath: 'D:/llvm/bin/mlir-reduce.exe',
    inputPath: 'D:/w/input.mlir',
    nodePath: 'C:/node/node.exe',
    testerPath: 'D:/w/tester.mjs',
    configPath: 'D:/w/tester.json',
    outPath: 'D:/w/reduced.mlir',
  });
  assert.equal(argv[0], 'D:/llvm/bin/mlir-reduce.exe');
  assert.equal(argv[1], 'D:/w/input.mlir');
  assert.equal(argv[2], '-reduction-tree=test=C:/node/node.exe test-arg=D:/w/tester.mjs test-arg=D:/w/tester.json');
  assert.deepEqual(argv.slice(3), ['-o', 'D:/w/reduced.mlir']);
});

test('reduceIr：成功缩减后写出 reduced.mlir 并复验签名', async () => {
  const session = makeSession('reduce');
  try {
    const workDir = join(session.root, 'run');
    const inputPath = session.write('run/input.mlir', 'module {\n  func.func @f() {\n    return\n  }\n}\n');
    const outPath = join(workDir, 'reduced.mlir');
    const mock = createMockRunner({ crashAlways: true });
    const result = await reduceIr({
      runner: mock.run,
      reducePath: 'fake-mlir-reduce.exe',
      optPath: 'fake-mlir-opt.exe',
      nodePath: 'node.exe',
      inputPath,
      outPath,
      pipeline: 'builtin.module(cse)',
      runnerArgs: [],
      cwd: session.root,
      workDir,
      timeoutMs: 10000,
      testerTimeoutMs: 5000,
      expectedSignatureKey: expectedKey(),
      crashExitCodes: CRASH_CODES,
      crashPatterns: PATTERNS,
      testerLogPath: join(workDir, 'tester.log'),
      reduceLogPath: join(workDir, 'reduce.log'),
      maxIterations: 10,
    });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(existsSync(outPath), true);
    assert.ok(result.reducedBytes < result.originalBytes);
    assert.ok(result.reductionPercent > 0);
    assert.equal(result.testedCandidates, 3);
    assert.equal(mock.state.reduceRuns, 1);
  } finally {
    session.cleanup();
  }
});

test('reduceIr：mlir-reduce 没写输出时报 REDUCE_FAILED', async () => {
  const session = makeSession('reduce-fail');
  try {
    const workDir = join(session.root, 'run');
    const inputPath = session.write('run/input.mlir', 'module {\n}\n');
    const mock = createMockRunner({ crashAlways: true, reduceWrites: false });
    const result = await reduceIr({
      runner: mock.run,
      reducePath: 'fake-mlir-reduce.exe',
      optPath: 'fake-mlir-opt.exe',
      nodePath: 'node.exe',
      inputPath,
      outPath: join(workDir, 'reduced.mlir'),
      pipeline: 'builtin.module(cse)',
      runnerArgs: [],
      cwd: session.root,
      workDir,
      timeoutMs: 10000,
      testerTimeoutMs: 5000,
      expectedSignatureKey: expectedKey(),
      crashExitCodes: CRASH_CODES,
      crashPatterns: PATTERNS,
      testerLogPath: join(workDir, 'tester.log'),
      reduceLogPath: join(workDir, 'reduce.log'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'REDUCE_FAILED');
  } finally {
    session.cleanup();
  }
});
test('mlir-reduce 自己崩掉、只留空文件 → REDUCE_FAILED（不误判成 REDUCE_UNSTABLE）', async () => {
  const session = makeSession('reduce-empty');
  try {
    const input = session.write('input.mlir', 'module {\n  func.func @f() {\n    return\n  }\n}\n');
    const mock = createMockRunner({ crashAlways: true, reduceWrites: 'empty', reduceExitCode: 3221225477 });
    const result = await reduceIr({
      runner: mock.run,
      reducePath: 'C:/fake/mlir-reduce.exe',
      optPath: 'C:/fake/mlir-opt.exe',
      nodePath: 'C:/fake/node.exe',
      inputPath: input,
      outPath: join(session.root, 'reduced.mlir'),
      pipeline: 'builtin.module(cse)',
      runnerArgs: [],
      cwd: session.root,
      workDir: session.root,
      timeoutMs: 10000,
      testerTimeoutMs: 5000,
      expectedSignatureKey: expectedKey(),
      crashExitCodes: CRASH_CODES,
      crashPatterns: PATTERNS,
      testerLogPath: join(session.root, 'tester.log'),
      reduceLogPath: join(session.root, 'reduce.log'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'REDUCE_FAILED');
    assert.match(result.error.message, /空文件/);
    assert.match(result.error.message, /3221225477/);
    assert.equal(result.exitCode, 3221225477);
    assert.equal(existsSync(join(session.root, 'last-good.mlir')), false);
    assert.match(readFileSync(join(session.root, 'reduce.log'), 'utf8'), /exitCode: 3221225477/);
  } finally {
    session.cleanup();
  }
});
