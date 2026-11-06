import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignature,
  classifyRun,
  describeExit,
  normalizeForSignature,
  normalizeText,
  signatureEquals,
} from '../lib/classify.js';

const CRASH_CODES = [3221225477, 3221225725, 3221226505, 3221225501, 2147483651];
const PATTERNS = ['LLVM ERROR:', 'Assertion failed:', 'Stack dump:', 'AddressSanitizer:', 'runtime error:'];

test('normalizeText 统一换行并去 ANSI', () => {
  assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(normalizeText('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(normalizeText(null), '');
});

test('describeExit 认 Windows 与 Unix 崩溃码', () => {
  assert.equal(describeExit(3221225477, null), 'EXCEPTION_ACCESS_VIOLATION');
  assert.equal(describeExit(3221225725, null), 'EXCEPTION_STACK_OVERFLOW');
  assert.equal(describeExit(139, null), 'SIGSEGV');
  assert.equal(describeExit(134, null), 'SIGABRT');
  assert.equal(describeExit(0, null), null);
});

test('classifyRun：崩溃退出码算崩溃', () => {
  const result = classifyRun({ exitCode: 3221225477, signal: null, stdout: '', stderr: '', crashExitCodes: CRASH_CODES, crashPatterns: PATTERNS });
  assert.equal(result.crashed, true);
  assert.equal(result.kind, 'signal');
  assert.match(result.reason, /EXCEPTION_ACCESS_VIOLATION/);
});

test('classifyRun：退出码 0 但有崩溃特征仍算崩溃', () => {
  const result = classifyRun({ exitCode: 0, signal: null, stdout: '', stderr: 'LLVM ERROR: boom', crashExitCodes: CRASH_CODES, crashPatterns: PATTERNS });
  assert.equal(result.crashed, true);
  assert.equal(result.kind, 'llvm-error');
  assert.equal(result.pattern, 'LLVM ERROR:');
});

test('classifyRun：断言失败归 assertion 并带上原始行', () => {
  const result = classifyRun({ exitCode: 134, signal: null, stdout: '', stderr: 'Assertion failed: (op), function getOp, file Op.cpp, line 12.', crashExitCodes: CRASH_CODES, crashPatterns: PATTERNS });
  assert.equal(result.crashed, true);
  assert.equal(result.kind, 'assertion');
  assert.match(result.errorType, /Assertion failed/);
});

test('classifyRun：sanitizer 报告优先于退出码', () => {
  const result = classifyRun({ exitCode: 139, signal: null, stdout: '', stderr: 'x', crashExitCodes: CRASH_CODES, crashPatterns: PATTERNS, sanitizerKind: 'asan' });
  assert.equal(result.crashed, true);
  assert.equal(result.kind, 'asan');
});

test('classifyRun：verifier 错误不是崩溃', () => {
  const result = classifyRun({ exitCode: 1, signal: null, stdout: '', stderr: "'func.return' op must have zero operands", crashExitCodes: CRASH_CODES, crashPatterns: PATTERNS });
  assert.equal(result.crashed, false);
  assert.equal(result.kind, 'unknown');
  assert.match(result.reason, /不是崩溃退出码/);
});

test('normalizeForSignature 去地址与 PID', () => {
  const text = '==12345==ERROR: at 0x00007ffd1234';
  const normalized = normalizeForSignature(text);
  assert.equal(normalized.includes('0x00007ffd1234'), false);
  assert.equal(normalized.includes('12345'), false);
  assert.match(normalized, /0xADDR/);
});

test('buildSignature 的 key 与 signatureEquals 一致', () => {
  const a = buildSignature({ kind: 'signal', errorType: 'EXCEPTION_ACCESS_VIOLATION', topFrame: 'f (a.cpp:1)', summary: 'x', exitCode: 3221225477 });
  const b = buildSignature({ kind: 'signal', errorType: 'EXCEPTION_ACCESS_VIOLATION', topFrame: 'f (a.cpp:1)', summary: 'x', exitCode: 3221225477 });
  const c = buildSignature({ kind: 'signal', errorType: 'EXCEPTION_ACCESS_VIOLATION', topFrame: 'g (b.cpp:2)', summary: 'x', exitCode: 3221225477 });
  assert.equal(signatureEquals(a, b), true);
  assert.equal(signatureEquals(a, c), false);
  assert.equal(a.key.split('|').length, 4);
});
