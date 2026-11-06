import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../lib/config.js';
import { runTriage } from '../lib/tools.js';
import { CRASH_STDERR, createMockRunner, makeSession, mockConfig } from './helpers.mjs';

const ASAN_LOG = fileURLToPath(new URL('../fixtures/crash/asan-uaf.log', import.meta.url));
const IR = 'module {\n  func.func @f() {\n    return\n  }\n}\n';

test('diagnose：复现 + 二分 + 产物齐全', async () => {
  const session = makeSession('tools-ok');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({ crashAtPassCount: 2 });
    const result = await runTriage({
      irPath: 'in.mlir',
      passList: ['func.func(cse)', 'func.func(canonicalize)', 'cse'],
      reduce: { enabled: false },
    }, { config: cfg, runner: mock.run, sessionCwd: session.root });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');
    assert.equal(result.action, 'diagnose');
    assert.equal(result.crash.reproduced, true);
    assert.equal(result.crash.stable, true);
    assert.equal(result.crash.attempts, 3);
    assert.equal(typeof result.crash.signature.key, 'string');
    assert.equal(result.bisect.ok, true);
    assert.equal(result.bisect.failingIndex, 2);
    assert.equal(result.reducer.attempted, false);

    const workDir = result.artifacts.workDir;
    assert.equal(existsSync(join(workDir, 'input.mlir')), true);
    assert.equal(existsSync(join(workDir, 'baseline.stderr.log')), true);
    assert.equal(existsSync(join(workDir, 'report.md')), true);
    assert.equal(existsSync(join(workDir, 'result.json')), true);
    assert.equal(existsSync(join(workDir, 'reproducer.txt')), true);
    assert.match(readFileSync(join(workDir, 'report.md'), 'utf8'), /## 一句话结论/);
    assert.match(readFileSync(join(workDir, 'report.md'), 'utf8'), /## 复现命令/);
    const saved = JSON.parse(readFileSync(join(workDir, 'result.json'), 'utf8'));
    assert.equal(saved.ok, true);
    assert.equal(saved.crash.signature.key, result.crash.signature.key);
  } finally {
    session.cleanup();
  }
});

test('diagnose + reduce：产出最小 IR', async () => {
  const session = makeSession('tools-reduce');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({ crashAlways: true });
    const result = await runTriage({
      irPath: 'in.mlir',
      pipeline: 'builtin.module(cse)',
      bisect: { enabled: false },
    }, { config: cfg, runner: mock.run, sessionCwd: session.root });

    assert.equal(result.ok, true, JSON.stringify(result.reducer));
    assert.equal(result.reducer.ok, true);
    assert.equal(result.reducer.attempted, true);
    assert.equal(existsSync(result.reducer.outputPath), true);
    assert.equal(result.artifacts.minimizedIrPath, result.reducer.outputPath);
    assert.ok(result.reducer.reductionPercent > 0);
  } finally {
    session.cleanup();
  }
});

test('不崩的输入报 NOT_A_CRASH，并保留现场', async () => {
  const session = makeSession('tools-nocrash');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({});
    const result = await runTriage({ irPath: 'in.mlir', pipeline: 'builtin.module(cse)' }, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'NOT_A_CRASH');
    assert.equal(result.crash.reproduced, false);
    assert.equal(existsSync(join(result.artifacts.workDir, 'baseline.stderr.log')), true);
  } finally {
    session.cleanup();
  }
});

test('outputDir 逃出会话目录直接拒绝', async () => {
  const session = makeSession('tools-escape');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({ crashAlways: true });
    const result = await runTriage({
      irPath: 'in.mlir',
      pipeline: 'builtin.module(cse)',
      outputDir: '..',
    }, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'OUTPUT_DIR_ESCAPE');
    assert.equal(result.error.stage, 'workspace');
  } finally {
    session.cleanup();
  }
});

test('keepWorkDir=false 在成功后删掉产物目录', async () => {
  const session = makeSession('tools-clean');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({ crashAlways: true });
    const result = await runTriage({
      irPath: 'in.mlir',
      pipeline: 'builtin.module(cse)',
      reduce: { enabled: false },
      bisect: { enabled: false },
      keepWorkDir: false,
    }, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(result.ok, true);
    assert.equal(result.artifacts.workDir, null);
    assert.equal(existsSync(join(session.root, '.crash-triage')), true); // 根目录还在，只是这次运行目录被删
    assert.ok(result.warnings.some((item) => item.includes('keepWorkDir=false')));
  } finally {
    session.cleanup();
  }
});

test('参数错误归一成 INVALID_ARGUMENT，不抛异常', async () => {
  const session = makeSession('tools-invalid');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({});
    const result = await runTriage({ action: 'bogus', irPath: 'in.mlir' }, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_ARGUMENT');

    const missing = await runTriage({ irPath: 'nope.mlir' }, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(missing.error.code, 'IR_NOT_FOUND');
  } finally {
    session.cleanup();
  }
});

test('找不到 mlir-opt 报 TOOL_NOT_FOUND + 中文 hint', async () => {
  const session = makeSession('tools-notool');
  try {
    session.write('in.mlir', IR);
    const cfg = resolveConfig({ mlirOptPath: join(session.root, 'missing', 'mlir-opt.exe') }, session.root);
    const mock = createMockRunner({});
    const result = await runTriage({ irPath: 'in.mlir', pipeline: 'builtin.module(cse)' }, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TOOL_NOT_FOUND');
    assert.match(result.error.hint, /mlirOptPath|toolchain\.json/);
  } finally {
    session.cleanup();
  }
});

test('两次运行对同一输入得到相同 sha256 与签名（确定性）', async () => {
  const session = makeSession('tools-deterministic');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({ crashAlways: true });
    const args = { irPath: 'in.mlir', pipeline: 'builtin.module(cse)', reduce: { enabled: false }, bisect: { enabled: false } };
    const first = await runTriage(args, { config: cfg, runner: mock.run, sessionCwd: session.root });
    const second = await runTriage(args, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(first.input.sha256, second.input.sha256);
    assert.equal(first.crash.signature.key, second.crash.signature.key);
    assert.notEqual(first.artifacts.workDir, second.artifacts.workDir);
  } finally {
    session.cleanup();
  }
});

test('sanitizer.inline：解析出 ASan 栈并写进 crash.sanitizer', async () => {
  const session = makeSession('tools-sanitizer');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({ crashAlways: true });
    const result = await runTriage({
      irPath: 'in.mlir',
      pipeline: 'builtin.module(cse)',
      reduce: { enabled: false },
      bisect: { enabled: false },
      sanitizer: { inline: readFileSync(ASAN_LOG, 'utf8'), maxFrames: 3 },
    }, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(result.ok, true);
    assert.equal(result.crash.sanitizer.kind, 'asan');
    assert.equal(result.crash.sanitizer.frames.length, 3);
    assert.match(result.crash.sanitizer.topFrame, /OperationName::getNamespace/);
    // 签名按进程自身输出算（tester 也只能看到进程输出），外部 sanitizer 报告只进 crash.sanitizer。
    assert.match(result.crash.signature.key, /^llvm-error\|/);
    assert.match(readFileSync(join(result.artifacts.workDir, 'report.md'), 'utf8'), /sanitizer 栈/);
  } finally {
    session.cleanup();
  }
});

test('显式 asan 但没有任何报告 → SANITIZER_NOT_FOUND', async () => {
  const session = makeSession('tools-sanitizer-missing');
  try {
    session.write('in.mlir', IR);
    const cfg = mockConfig(session.root);
    const mock = createMockRunner({ crashAlways: true });
    const result = await runTriage({
      irPath: 'in.mlir',
      pipeline: 'builtin.module(cse)',
      reduce: { enabled: false },
      bisect: { enabled: false },
      sanitizer: { mode: 'asan', inline: 'just plain text' },
    }, { config: cfg, runner: mock.run, sessionCwd: session.root });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SANITIZER_NOT_FOUND');
  } finally {
    session.cleanup();
  }
});
test('apply() 只注册一个 crash_triage 工具，dispose 时逐个回收', async () => {
  const session = makeSession('apply');
  try {
    const registered = [];
    const disposed = [];
    const ctx = {
      subprocess: { spawn: () => { throw new Error('apply 阶段不应启动子进程'); } },
      tools: { register: (definition) => { registered.push(definition); return () => disposed.push(definition.name); } },
      on: (event, handler) => { if (event === 'dispose') ctx.disposeHandler = handler; },
    };
    const { apply } = await import('../lib/index.js');
    apply(ctx, { mlirOptPath: join(session.root, 'fake-mlir-opt.exe') });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'crash_triage');
    assert.equal(registered[0].parameters.type, 'object');
    assert.deepEqual(registered[0].parameters.properties.action.enum, ['diagnose', 'reduce', 'bisect', 'parse']);
    assert.equal(typeof registered[0].execute, 'function');
    assert.equal(typeof ctx.disposeHandler, 'function');
    ctx.disposeHandler();
    assert.deepEqual(disposed, ['crash_triage']);
  } finally {
    session.cleanup();
  }
});
