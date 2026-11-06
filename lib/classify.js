/**
 * 崩溃判定与签名（规格 3.6）。
 *
 * 判定顺序：sanitizer 报告 > crashExitCodes/signal > crashPatterns > 其余非零退出码。
 * signature 用于「是不是同一个崩溃」的比较：去地址、去 PID/TID、去临时目录前缀、统一换行与颜色。
 */

/** 去掉 ANSI 颜色序列。 */
export function stripAnsi(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** 统一换行、去 ANSI、去行尾空白。 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Windows 崩溃退出码 → 可读名字。 */
const WINDOWS_CODES = {
  3221225477: 'EXCEPTION_ACCESS_VIOLATION',
  3221225725: 'EXCEPTION_STACK_OVERFLOW',
  3221226505: 'EXCEPTION_STACK_BUFFER_OVERRUN',
  3221225501: 'EXCEPTION_ILLEGAL_INSTRUCTION',
  2147483651: 'EXCEPTION_BREAKPOINT',
};

/** Unix 崩溃退出码（128+信号）→ 信号名。 */
const UNIX_CODES = {
  134: 'SIGABRT',
  139: 'SIGSEGV',
  132: 'SIGILL',
  136: 'SIGFPE',
};

/**
 * 把退出码/信号翻译成可读名字。
 * @param exitCode - 进程退出码（可为 null）。
 * @param signal - 信号名（可为 null）。
 * @returns 可读名字或 null。
 */
export function describeExit(exitCode, signal) {
  if (typeof signal === 'string' && signal !== '') return String(signal).toUpperCase();
  const code = Number(exitCode);
  if (!Number.isFinite(code)) return null;
  return WINDOWS_CODES[code] || UNIX_CODES[code] || null;
}

/**
 * 在文本里找第一条命中的崩溃特征。
 * @returns 命中的 pattern 或 null。
 */
export function matchCrashPattern(text, patterns) {
  const haystack = normalizeText(text);
  if (haystack === '') return null;
  const list = Array.isArray(patterns) ? patterns : [];
  for (const pattern of list) {
    if (typeof pattern !== 'string' || pattern === '') continue;
    if (haystack.includes(pattern)) return pattern;
  }
  return null;
}

/**
 * 判定一次运行是否崩溃（规格 3.6.1）。
 * @param input.exitCode - 进程退出码。
 * @param input.signal - 信号。
 * @param input.stdout / input.stderr - 输出。
 * @param input.crashExitCodes - 视为崩溃的退出码。
 * @param input.crashPatterns - 视为崩溃的文本特征。
 * @param input.sanitizerKind - sanitizer 解析结果（'asan'|'ubsan'|null），命中即算崩溃。
 * @returns {{crashed, kind, errorType, pattern, reason, diagnosticLines}}
 */
export function classifyRun(input) {
  const opts = input !== null && typeof input === 'object' ? input : {};
  const stdout = normalizeText(opts.stdout);
  const stderr = normalizeText(opts.stderr);
  const combined = stdout + '\n' + stderr;
  const exitCode = opts.exitCode === undefined ? null : opts.exitCode;
  const signal = opts.signal === undefined ? null : opts.signal;
  const codes = Array.isArray(opts.crashExitCodes) ? opts.crashExitCodes.map((item) => Number(item)) : [];
  const numericCode = Number(exitCode);

  const sanitizerKind = typeof opts.sanitizerKind === 'string' && opts.sanitizerKind !== '' ? opts.sanitizerKind : null;
  if (sanitizerKind !== null) {
    return {
      crashed: true,
      kind: sanitizerKind,
      errorType: extractSanitizerErrorType(combined, sanitizerKind),
      pattern: null,
      reason: 'sanitizer 报告：' + sanitizerKind,
      diagnosticLines: collectErrorLines(combined),
    };
  }

  const pattern = matchCrashPattern(combined, opts.crashPatterns);
  const codeHit = Number.isFinite(numericCode) && codes.includes(Math.trunc(numericCode));
  const signalHit = typeof signal === 'string' && signal !== null && signal !== '';

  if (codeHit || signalHit) {
    const kind = deriveKind(combined, true);
    return {
      crashed: true,
      kind,
      errorType: deriveErrorType(combined, kind, exitCode),
      pattern,
      reason: codeHit
        ? '退出码 ' + exitCode + '（' + describeExit(exitCode, null) + '）属于崩溃退出码'
        : '进程被信号 ' + signal + ' 终止',
      diagnosticLines: collectErrorLines(combined),
    };
  }

  if (pattern !== null) {
    const kind = deriveKind(combined, true);
    return {
      crashed: true,
      kind,
      errorType: deriveErrorType(combined, kind, exitCode),
      pattern,
      reason: '输出命中崩溃特征：' + pattern,
      diagnosticLines: collectErrorLines(combined),
    };
  }

  const diagnostics = collectErrorLines(combined);
  const reason = Number.isFinite(numericCode) && Math.trunc(numericCode) !== 0
    ? '退出码 ' + exitCode + ' 不是崩溃退出码，也没有崩溃特征' + (diagnostics.length > 0 ? '（只有 ' + diagnostics.length + ' 条 error 诊断）' : '')
    : '退出码 0，没有崩溃特征';
  return { crashed: false, kind: 'unknown', errorType: null, pattern: null, reason, diagnosticLines: diagnostics };
}

/** 从文本里挑出 kind：sanitizer 之外按断言 / LLVM ERROR / 信号。 */
function deriveKind(text, signalLike) {
  if (/Assertion failed:|LLVM ERROR: Assertion/i.test(text)) return 'assertion';
  if (/LLVM ERROR:/.test(text)) return 'llvm-error';
  return signalLike ? 'signal' : 'unknown';
}

/** errorType：尽量给出「什么错」，而不是「进程死了」。 */
function deriveErrorType(text, kind, exitCode) {
  if (kind === 'assertion') {
    const match = text.match(/Assertion failed:[^\n]*/i);
    if (match !== null) return truncate(match[0], 240);
  }
  if (kind === 'llvm-error') {
    const match = text.match(/LLVM ERROR:[^\n]*/);
    if (match !== null) return truncate(match[0], 240);
  }
  const exitName = describeExit(exitCode, null);
  return exitName;
}

/** sanitizer 的 errorType（ASan/UBSan 的短描述）。 */
function extractSanitizerErrorType(text, kind) {
  if (kind === 'asan') {
    const match = text.match(/AddressSanitizer:\s*([a-z0-9-]+)/i);
    if (match !== null) return match[1].toLowerCase();
  }
  if (kind === 'ubsan') {
    const match = text.match(/runtime error:\s*([^\n]+)/i);
    if (match !== null) return truncate(match[1], 160);
  }
  return null;
}

/** 收集 error/fatal error 诊断行（用于 NOT_A_CRASH 的解释）。 */
export function collectErrorLines(text) {
  const out = [];
  for (const line of normalizeText(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (/error:|fatal error:|verifier/i.test(trimmed)) out.push(trimmed);
    if (out.length >= 19) break;
  }
  return out;
}

/** 签名归一化：去地址、去 PID/TID、去临时目录前缀。 */
export function normalizeForSignature(text) {
  let value = normalizeText(text);
  value = value.replace(/0x[0-9a-fA-F]+/g, '0xADDR');
  value = value.replace(/==\d+==/g, '==PID==');
  value = value.replace(/\/(?:tmp|var\/tmp)\/[^\s:'"]+/g, '/TMP/PATH');
  value = value.replace(/[A-Za-z]:\\\\[^\s:'"]*\\\\?(?:Temp|tmp)[A-Za-z0-9_\\.\\-]*/g, 'TMP_PATH');
  return value;
}

/**
 * 生成崩溃签名（规格 3.6.2）：kind + errorType + topFrame + summary + exitCode。
 * @param input.kind - 'asan'|'ubsan'|'signal'|'assertion'|'llvm-error'|'unknown'。
 * @param input.errorType - 短描述。
 * @param input.topFrame - 栈顶帧（函数 + 文件 basename + 行号）。
 * @param input.summary - 一句话概述。
 * @param input.exitCode - 退出码。
 * @returns {{kind, errorType, topFrame, summary, exitCode, key}}
 */
export function buildSignature(input) {
  const opts = input !== null && typeof input === 'object' ? input : {};
  const kind = typeof opts.kind === 'string' && opts.kind !== '' ? opts.kind : 'unknown';
  const errorType = opts.errorType === undefined || opts.errorType === null ? null : normalizeForSignature(String(opts.errorType)).replace(/\s+/g, ' ').trim();
  const topFrame = opts.topFrame === undefined || opts.topFrame === null ? null : normalizeForSignature(String(opts.topFrame)).replace(/\s+/g, ' ').trim();
  const summary = opts.summary === undefined || opts.summary === null ? null : normalizeForSignature(String(opts.summary)).replace(/\s+/g, ' ').trim();
  const exitCode = Number.isFinite(Number(opts.exitCode)) ? Math.trunc(Number(opts.exitCode)) : null;
  const key = [kind, errorType === null ? '-' : errorType, topFrame === null ? '-' : topFrame, exitCode === null ? '-' : exitCode].join('|');
  return { kind, errorType, topFrame, summary, exitCode, key };
}

/** 两个签名是否同一个崩溃（按 key 比较）。 */
export function signatureEquals(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return a.key === b.key;
}

function truncate(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}
