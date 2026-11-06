import { basename } from 'node:path';
import { buildSignature, classifyRun, normalizeText } from './classify.js';

/** ASan 帧： "    #0 0x00007ff in mlir::Foo::bar() D:/src/Foo.cpp:12:3" */
const ASAN_FRAME = /#(\d+)\s+0x[0-9a-fA-F]+\s+in\s+(.+?)\s+([^()\s]+):(\d+):(\d+)\s*$/;
/** 未符号化帧： "    #1 0x00007ff (mlir-opt.exe+0x1234)" */
const RAW_FRAME = /#(\d+)\s+0x[0-9a-fA-F]+\s+(\([^)]*\)|[^\s]+)\s*$/;
/** UBSan 报告行的位置前缀： "D:/src/Fold.cpp:120:15: runtime error: ..." */
const UBSAN_LINE = /^(.*?):(\d+):(\d+):\s*runtime error:\s*(.+)$/;

/**
 * 解析 sanitizer 报告（规格 3.9）。
 * 只做「从日志/内联输出里抽字段」，v1 不负责生成报告、不做符号化。
 * @param text - 报告正文（可含前后噪音）。
 * @returns {{kind, errorType, summary, frames, topFrame, address}}
 */
export function parseSanitizer(text) {
  const body = normalizeText(text);
  const result = { kind: null, errorType: null, summary: null, frames: [], topFrame: null, address: null };
  if (body === '') return result;

  const asanHeader = body.match(/AddressSanitizer:\s*([a-zA-Z0-9_-]+)/);
  const ubsanLine = findUbsanLine(body);
  if (asanHeader !== null) {
    result.kind = 'asan';
    result.errorType = asanHeader[1].toLowerCase();
    const address = body.match(/on address (0x[0-9a-fA-F]+)/);
    if (address !== null) result.address = address[0].replace('on address ', '');
    const summary = body.match(/SUMMARY:\s*AddressSanitizer:\s*([^\n]*)/);
    if (summary !== null) result.summary = 'AddressSanitizer: ' + summary[1].trim();
  } else if (ubsanLine !== null || /UndefinedBehaviorSanitizer/.test(body)) {
    result.kind = 'ubsan';
    if (ubsanLine !== null) {
      result.errorType = truncate(ubsanLine.message, 200);
      result.frames.push({ index: 0, function: null, file: ubsanLine.file, line: Number(ubsanLine.line), column: Number(ubsanLine.column), raw: ubsanLine.raw });
      result.summary = 'UndefinedBehaviorSanitizer: ' + result.errorType;
    } else {
      const summary = body.match(/SUMMARY:\s*UndefinedBehaviorSanitizer:\s*([^\n]*)/);
      if (summary !== null) result.summary = 'UndefinedBehaviorSanitizer: ' + summary[1].trim();
    }
  }

  if (result.kind === null) return result;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('#')) continue;
    const matched = line.match(ASAN_FRAME);
    if (matched !== null) {
      result.frames.push({
        index: Number(matched[1]),
        function: matched[2].trim(),
        file: matched[3],
        line: Number(matched[4]),
        column: Number(matched[5]),
        raw: line,
      });
      continue;
    }
    const raw = line.match(RAW_FRAME);
    if (raw !== null) {
      result.frames.push({ index: Number(raw[1]), function: null, file: null, line: null, column: null, raw: line, unsymbolized: raw[2] });
    }
  }

  const first = result.frames.find((frame) => typeof frame.file === 'string' && frame.line !== null);
  if (first !== undefined) {
    const label = first.function === null ? basename(first.file) : first.function;
    result.topFrame = label + ' (' + basename(first.file) + ':' + first.line + ')';
  } else if (result.errorType !== null) {
    result.topFrame = result.kind + ':' + result.errorType;
  }
  return result;
}

/** 从文本里找第一条 UBSan runtime error，并带上它的 file:line:col。 */
export function findUbsanLine(text) {
  for (const rawLine of normalizeText(text).split('\n')) {
    const line = rawLine.trim();
    const matched = line.match(UBSAN_LINE);
    if (matched !== null) {
      return { file: matched[1], line: matched[2], column: matched[3], message: matched[4], raw: line };
    }
  }
  return null;
}

/**
 * 把 sanitizer 解析结果压成输出字段（sanitizer 子对象用）。
 * @param parsed - parseSanitizer 的结果。
 * @param extra.reportPath - 外部报告路径。
 * @param extra.source - 'inline' | 'report' | 'both'。
 * @param extra.maxFrames - 最多保留几帧。
 */
export function toSanitizerOutput(parsed, extra) {
  const opts = extra !== null && typeof extra === 'object' ? extra : {};
  const maxFrames = Number.isFinite(Number(opts.maxFrames)) ? Math.max(1, Math.trunc(Number(opts.maxFrames))) : 10;
  const frames = Array.isArray(parsed.frames) ? parsed.frames.slice(0, maxFrames).map((frame) => ({
    index: frame.index,
    function: frame.function,
    file: frame.file,
    line: frame.line,
    column: frame.column,
  })) : [];
  return {
    kind: parsed.kind,
    errorType: parsed.errorType,
    summary: parsed.summary,
    topFrame: parsed.topFrame,
    address: parsed.address,
    frames,
    frameCount: Array.isArray(parsed.frames) ? parsed.frames.length : 0,
    source: typeof opts.source === 'string' ? opts.source : null,
    reportPath: typeof opts.reportPath === 'string' ? opts.reportPath : null,
  };
}

/**
 * 从任意崩溃输出里猜栈顶位置：优先 "file:line:col:" 前缀，其次 "#0 ... in fn file:line"。
 * 没有符号信息时返回 null（v1 不做符号化）。
 */
export function guessTopFrame(text) {
  const body = normalizeText(text);
  const frames = parseSanitizer(body);
  if (frames.topFrame !== null) return frames.topFrame;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const matched = line.match(ASAN_FRAME);
    if (matched !== null) return matched[2].trim() + ' (' + basename(matched[3]) + ':' + matched[4] + ')';
  }
  return null;
}

function truncate(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}
/**
 * 把一次运行结果压成「判定 + sanitizer + 签名」三件套。
 * 主流程与 mlir-reduce 的 tester 共用同一个函数，保证两边算出的签名一致。
 * @param runResult - {exitCode, signal, stdout, stderr}。
 * @param config - 至少含 crashExitCodes / crashPatterns。
 * @returns {{parsed, classified, signature}}
 */
export function buildRunSignature(runResult, config) {
  const opts = runResult !== null && typeof runResult === 'object' ? runResult : {};
  const cfg = config !== null && typeof config === 'object' ? config : {};
  const stdout = normalizeText(opts.stdout);
  const stderr = normalizeText(opts.stderr);
  const text = stderr + '\n' + stdout;
  const parsed = parseSanitizer(text);
  const classified = classifyRun({
    exitCode: opts.exitCode,
    signal: opts.signal,
    stdout,
    stderr,
    crashExitCodes: cfg.crashExitCodes,
    crashPatterns: cfg.crashPatterns,
    sanitizerKind: parsed.kind,
  });
  const topFrame = parsed.topFrame !== null ? parsed.topFrame : guessTopFrame(text);
  const signature = buildSignature({
    kind: classified.kind,
    errorType: classified.errorType,
    topFrame,
    summary: parsed.summary !== null ? parsed.summary : classified.reason,
    exitCode: opts.exitCode,
  });
  return { parsed, classified, signature };
}
