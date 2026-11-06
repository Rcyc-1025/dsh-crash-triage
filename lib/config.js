import { resolve } from 'node:path';

/** 平台相关的崩溃退出码：Windows 是 NTSTATUS 值，Unix 是 128+信号。 */
const WINDOWS_CRASH_CODES = [3221225477, 3221225725, 3221226505, 3221225501, 2147483651];
const UNIX_CRASH_CODES = [134, 139, 132, 136];

/** 默认崩溃文本特征。命中任意一条即视为崩溃（退出码 0 也算）。 */
const DEFAULT_CRASH_PATTERNS = [
  'LLVM ERROR:',
  'Assertion failed:',
  'PLEASE submit a bug report',
  'Stack dump:',
  'AddressSanitizer:',
  'UndefinedBehaviorSanitizer:',
  'runtime error:',
];

/**
 * 插件默认配置。数值默认值来自规格 2.4：
 * 单次 120s / 总预算 900s / IR 32MB / 输出 1MB / 缩减 200 次 600s / 二分 64 次。
 */
export const DEFAULTS = {
  timeoutMs: 120000,
  maxTotalMs: 900000,
  maxIrBytes: 33554432,
  maxOutputBytes: 1048576,
  maxReduceIterations: 200,
  maxReduceTimeMs: 600000,
  maxBisectRuns: 64,
  workDir: '.crash-triage',
  keepWorkDir: true,
  toolchainJson: '',
  mlirOptPath: '',
  mlirReducePath: '',
  sanitizerMode: 'auto',
  maxFrames: 10,
  graceMs: 5000,
  crashExitCodes: process.platform === 'win32' ? WINDOWS_CRASH_CODES.slice() : UNIX_CRASH_CODES.slice(),
  crashPatterns: DEFAULT_CRASH_PATTERNS.slice(),
};

/** 环境变量覆盖键（规格 2.5）。 */
const ENV_KEYS = {
  CRASH_TRIAGE_TIMEOUT_MS: 'timeoutMs',
  CRASH_TRIAGE_MAX_OUTPUT_BYTES: 'maxOutputBytes',
  CRASH_TRIAGE_TOOLCHAIN_JSON: 'toolchainJson',
};

/** sanitizer 允许的模式。 */
const SANITIZER_MODES = ['auto', 'off', 'asan', 'ubsan'];

/**
 * 解析插件配置：DEFAULTS < cordis config < 环境变量，数值夹到安全区间。
 * @param raw - cordis.patch.yml 里传进来的 config（可缺省）。
 * @param cwd - 会话工作目录，用于解析 workDir / 工具路径。
 * @returns 规范化后的配置；workDirRoot 是 workDir 的绝对路径。
 */
export function resolveConfig(raw, cwd) {
  const base = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : process.cwd();
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS, ...input };
  for (const [envKey, key] of Object.entries(ENV_KEYS)) {
    const value = process.env[envKey];
    if (typeof value !== 'string' || value.trim() === '') continue;
    config[key] = key === 'toolchainJson' ? value.trim() : Number(value.trim());
  }
  config.timeoutMs = clampInt(config.timeoutMs, 1000, 600000, DEFAULTS.timeoutMs);
  config.maxTotalMs = clampInt(config.maxTotalMs, 1000, 24 * 60 * 60 * 1000, DEFAULTS.maxTotalMs);
  config.maxIrBytes = clampInt(config.maxIrBytes, 1024, 512 * 1024 * 1024, DEFAULTS.maxIrBytes);
  config.maxOutputBytes = clampInt(config.maxOutputBytes, 4096, 8 * 1024 * 1024, DEFAULTS.maxOutputBytes);
  config.maxReduceIterations = clampInt(config.maxReduceIterations, 1, 10000, DEFAULTS.maxReduceIterations);
  config.maxReduceTimeMs = clampInt(config.maxReduceTimeMs, 1000, 24 * 60 * 60 * 1000, DEFAULTS.maxReduceTimeMs);
  config.maxBisectRuns = clampInt(config.maxBisectRuns, 1, 1024, DEFAULTS.maxBisectRuns);
  config.maxFrames = clampInt(config.maxFrames, 1, 200, DEFAULTS.maxFrames);
  config.graceMs = clampInt(config.graceMs, 500, 30000, DEFAULTS.graceMs);
  config.keepWorkDir = config.keepWorkDir !== false;
  config.crashExitCodes = normalizeNumbers(config.crashExitCodes, DEFAULTS.crashExitCodes);
  config.crashPatterns = normalizePatterns(config.crashPatterns);
  config.sanitizerMode = SANITIZER_MODES.includes(config.sanitizerMode) ? config.sanitizerMode : 'auto';
  config.toolchainJson = typeof config.toolchainJson === 'string' ? config.toolchainJson.trim() : '';
  config.mlirOptPath = typeof config.mlirOptPath === 'string' ? config.mlirOptPath.trim() : '';
  config.mlirReducePath = typeof config.mlirReducePath === 'string' ? config.mlirReducePath.trim() : '';
  config.workDir = typeof config.workDir === 'string' && config.workDir.trim() !== '' ? config.workDir.trim() : DEFAULTS.workDir;
  config.workDirRoot = resolve(base, config.workDir);
  return config;
}

/** 退出码数组：接受数字/字符串，去重、去非法值，空数组回落到默认值。 */
function normalizeNumbers(value, fallback) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    const number = Number(item);
    if (!Number.isFinite(number)) continue;
    const code = Math.trunc(number);
    if (!out.includes(code)) out.push(code);
  }
  return out.length > 0 ? out : fallback.slice();
}

/** 崩溃文本特征：去空、去重、保持原顺序；空数组回落到默认值。 */
function normalizePatterns(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    if (!out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out : DEFAULT_CRASH_PATTERNS.slice();
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
