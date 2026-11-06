import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRunSignature, parseSanitizer, toSanitizerOutput } from '../lib/sanitize.js';

const ASAN_LOG = fileURLToPath(new URL('../fixtures/crash/asan-uaf.log', import.meta.url));
const UBSAN_LOG = fileURLToPath(new URL('../fixtures/crash/ubsan-overflow.log', import.meta.url));

test('parseSanitizer：ASan heap-use-after-free', () => {
  const parsed = parseSanitizer(readFileSync(ASAN_LOG, 'utf8'));
  assert.equal(parsed.kind, 'asan');
  assert.equal(parsed.errorType, 'heap-use-after-free');
  assert.match(parsed.address, /^0x/);
  assert.ok(parsed.frames.length >= 5);
  assert.match(parsed.topFrame, /OperationName::getNamespace/);
  assert.match(parsed.topFrame, /OperationSupport\.cpp:412/);
});

test('parseSanitizer：UBSan runtime error 带位置', () => {
  const parsed = parseSanitizer(readFileSync(UBSAN_LOG, 'utf8'));
  assert.equal(parsed.kind, 'ubsan');
  assert.match(parsed.errorType, /signed integer overflow/);
  assert.match(parsed.frames[0].file, /OperationSupport\.cpp$/);
  assert.equal(parsed.frames[0].line, 412);
});

test('parseSanitizer：没有报告时 kind 为 null', () => {
  const parsed = parseSanitizer('plain verifier error: op must have zero operands');
  assert.equal(parsed.kind, null);
  assert.equal(parsed.topFrame, null);
  assert.deepEqual(parsed.frames, []);
});

test('toSanitizerOutput：maxFrames 限制帧数并保留总数', () => {
  const parsed = parseSanitizer(readFileSync(ASAN_LOG, 'utf8'));
  const output = toSanitizerOutput(parsed, { reportPath: ASAN_LOG, source: 'report', maxFrames: 2 });
  assert.equal(output.frames.length, 2);
  assert.ok(output.frameCount > 2);
  assert.equal(output.source, 'report');
  assert.equal(output.reportPath, ASAN_LOG);
});

test('buildRunSignature：sanitizer 报告让签名变成 asan', () => {
  const built = buildRunSignature(
    { exitCode: 1, signal: null, stdout: '', stderr: readFileSync(ASAN_LOG, 'utf8') },
    { crashExitCodes: [3221225477], crashPatterns: ['AddressSanitizer:'] },
  );
  assert.equal(built.classified.crashed, true);
  assert.equal(built.signature.kind, 'asan');
  assert.match(built.signature.key, /^asan\|/);
});
