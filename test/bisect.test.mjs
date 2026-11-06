import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePrintIrMarkers,
  bisectPasses,
  buildPrefix,
  extractPasses,
  groupPrintIrMarkers,
  parsePrintIrMarkers,
  passShortName,
  splitTopLevel,
  stripModuleWrapper,
} from '../lib/bisect.js';
import { createMockRunner, makeSession } from './helpers.mjs';

const CRASH_CODES = [3221225477];
const PATTERNS = ['LLVM ERROR:', 'Stack dump:'];

test('splitTopLevel：括号内的逗号不切', () => {
  assert.deepEqual(splitTopLevel('func.func(cse,canonicalize),cse'), ['func.func(cse,canonicalize)', 'cse']);
  assert.deepEqual(splitTopLevel('  '), []);
});

test('stripModuleWrapper：剥掉 builtin.module 外层', () => {
  assert.deepEqual(stripModuleWrapper('builtin.module(a,b)'), { wrapper: 'builtin.module', body: 'a,b' });
  assert.deepEqual(stripModuleWrapper('a,b'), { wrapper: null, body: 'a,b' });
});

test('extractPasses：passList 优先，嵌套会被标出来', () => {
  const fromList = extractPasses('builtin.module(x)', ['a', 'b']);
  assert.equal(fromList.source, 'passList');
  assert.deepEqual(fromList.passes, ['a', 'b']);

  const nested = extractPasses('builtin.module(func.func(cse,canonicalize))', null);
  assert.equal(nested.nested, true);
  assert.equal(nested.passes.length, 1);
  assert.match(nested.note, /嵌套/);
});

test('buildPrefix：count=0 给空 pipeline', () => {
  assert.equal(buildPrefix('builtin.module', ['a', 'b'], 0), 'builtin.module()');
  assert.equal(buildPrefix('builtin.module', ['a', 'b'], 1), 'builtin.module(a)');
  assert.equal(buildPrefix(null, ['a'], 5), 'builtin.module(a)');
});

test('parsePrintIrMarkers / group / analyze：函数级 pass 的重复 marker 合成一段', () => {
  const stderr = [
    '// -----// IR Dump After CanonicalizerPass: canonicalize{...} //----- //',
    '// -----// IR Dump After CanonicalizerPass: canonicalize{...} //----- //',
    '// -----// IR Dump After CSEPass: cse{...} //----- //',
  ].join('\n');
  const markers = parsePrintIrMarkers(stderr);
  assert.equal(markers.length, 3);
  const groups = groupPrintIrMarkers(markers);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  const analyzed = analyzePrintIrMarkers(markers, ['func.func(canonicalize)', 'cse']);
  assert.equal(analyzed.matchedIndex, 2);
  assert.match(analyzed.lastLabel, /CSEPass/);
});

test('passShortName 把段名归一', () => {
  assert.equal(passShortName('func.func(canonicalize)'), 'canonicalize');
  assert.equal(passShortName('cse'), 'cse');
  assert.equal(passShortName('CanonicalizerPass'), 'canonicalizer');
});

test('bisectPasses：5 段 pipeline 第 4 段才崩 → failingIndex=4', async () => {
  const session = makeSession('bisect');
  try {
    const irPath = session.write('input.mlir', 'module {\n  func.func @f() {\n    return\n  }\n}\n');
    const mock = createMockRunner({ crashAtPassCount: 4 });
    const passes = ['func.func(cse)', 'func.func(canonicalize)', 'func.func(loop-invariant-code-motion)', 'cse', 'canonicalize'];
    const result = await bisectPasses({
      runner: mock.run,
      optPath: 'fake-mlir-opt.exe',
      irPath,
      passes,
      wrapper: 'builtin.module',
      maxRuns: 64,
      timeoutMs: 5000,
      cwd: session.root,
      crashExitCodes: CRASH_CODES,
      crashPatterns: PATTERNS,
    });
    assert.equal(result.ok, true);
    assert.equal(result.failingIndex, 4);
    assert.equal(result.failingPass, 'cse');
    assert.equal(result.totalPasses, 5);
    assert.ok(result.runs <= 64);
    assert.ok(result.evidence.length >= 3);
    assert.equal(result.passingPrefix, 'builtin.module(func.func(cse),func.func(canonicalize),func.func(loop-invariant-code-motion))');
  } finally {
    session.cleanup();
  }
});

test('bisectPasses：单段 pass 报 PASS_NESTED', async () => {
  const session = makeSession('bisect-nested');
  try {
    const irPath = session.write('input.mlir', 'module {\n}\n');
    const mock = createMockRunner({ crashAlways: true });
    const result = await bisectPasses({
      runner: mock.run,
      optPath: 'fake-mlir-opt.exe',
      irPath,
      passes: ['func.func(cse,canonicalize)'],
      wrapper: 'builtin.module',
      maxRuns: 8,
      timeoutMs: 5000,
      cwd: session.root,
      crashExitCodes: CRASH_CODES,
      crashPatterns: PATTERNS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'PASS_NESTED');
  } finally {
    session.cleanup();
  }
});
