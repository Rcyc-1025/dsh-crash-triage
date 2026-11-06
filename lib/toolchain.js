import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

/** toolchain.json 里 mlir 相关的键名 → 可执行文件名。 */
const TOOLCHAIN_TO_EXE = {
  mlirOpt: 'mlir-opt',
  mlirReduce: 'mlir-reduce',
};

/**
 * 读 toolchain.json；永不抛错（坏文件返回 error 字符串）。
 * @param path - toolchain.json 绝对路径或空串。
 * @returns {json, error}
 */
export function loadToolchainFile(path) {
  if (typeof path !== 'string' || path.trim() === '') return { json: null, error: '未配置 toolchainJson' };
  const file = path.trim();
  if (!existsSync(file)) return { json: null, error: 'toolchain.json 不存在：' + file };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { json: parsed !== null && typeof parsed === 'object' ? parsed : null, error: null };
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
    return { json: null, error: 'toolchain.json 解析失败：' + message };
  }
}

/**
 * 自动发现 toolchain.json：<cwd>/mlir-lang/toolchain.json 优先，其次 <cwd>/toolchain.json。
 * @param cwd - 会话工作目录。
 * @returns 绝对路径或 null。
 */
export function discoverToolchain(cwd) {
  const base = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : process.cwd();
  const candidates = [resolve(base, 'mlir-lang', 'toolchain.json'), resolve(base, 'toolchain.json')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 在 PATH 上找可执行文件（Windows 按 PATHEXT 补后缀）。
 * @param exe - 可执行文件名，例如 'mlir-opt'。
 * @returns 绝对路径或 null。
 */
export function whichSync(exe) {
  const name = typeof exe === 'string' ? exe.trim() : '';
  if (name === '') return null;
  const hasExt = /.[A-Za-z0-9]+$/.test(name);
  const exts = process.platform === 'win32' && !hasExt
    ? ['.exe', '.cmd', '.bat'].concat(String(process.env.PATHEXT || '').split(';').map((item) => item.trim().toLowerCase()).filter((item) => item.startsWith('.')))
    : [''];
  const rawPath = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  const dirs = rawPath.split(delimiter).map((item) => item.trim()).filter((item) => item !== '');
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // 权限或竞态：换下一个候选。
      }
    }
  }
  return null;
}

/**
 * 解析插件要用的可执行文件。优先级（规格 2.6）：
 *   ① 显式 mlirOptPath / mlirReducePath
 *   ② toolchainJson（显式给的或自动发现的），读 llvm.tools.mlirOpt.path / llvm.tools.mlirReduce.path
 *   ③ PATH
 * 找不到也不抛错：返回 exists:false 与中文 note，由工具层转成 TOOL_NOT_FOUND。
 * @param config - resolveConfig 的结果。
 * @param cwd - 解析相对路径用。
 * @returns {{mlirOpt, mlirReduce, node, toolchainPath, source, notes, versions}}
 */
export function resolveMlirTools(config, cwd) {
  const base = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : process.cwd();
  const notes = [];
  const versions = {};
  const explicitJson = typeof config.toolchainJson === 'string' && config.toolchainJson.trim() !== ''
    ? resolve(base, config.toolchainJson.trim())
    : '';
  const toolchainPath = explicitJson !== '' ? explicitJson : discoverToolchain(base);
  const loaded = loadToolchainFile(toolchainPath);
  if (loaded.error !== null) notes.push(loaded.error);

  const fromJson = {};
  const json = loaded.json;
  if (json !== null && json.llvm !== null && typeof json.llvm === 'object') {
    const tools = json.llvm.tools !== null && typeof json.llvm.tools === 'object' ? json.llvm.tools : {};
    for (const [key, exe] of Object.entries(TOOLCHAIN_TO_EXE)) {
      const entry = tools[key];
      if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.trim() !== '') {
        fromJson[exe] = isAbsolute(entry.path) ? entry.path : resolve(base, entry.path);
        if (typeof entry.version === 'string' && entry.version.trim() !== '') versions[exe] = entry.version.trim();
      }
    }
  }

  const explicit = {
    'mlir-opt': typeof config.mlirOptPath === 'string' ? config.mlirOptPath : '',
    'mlir-reduce': typeof config.mlirReducePath === 'string' ? config.mlirReducePath : '',
  };
  const resolved = {};
  for (const exe of ['mlir-opt', 'mlir-reduce']) {
    const explicitPath = explicit[exe].trim();
    if (explicitPath !== '') {
      const path = isAbsolute(explicitPath) ? explicitPath : resolve(base, explicitPath);
      resolved[exe] = { path, source: 'config', exists: existsSync(path) };
      if (!existsSync(path)) notes.push('配置的 ' + exe + ' 路径不存在：' + path);
      continue;
    }
    if (typeof fromJson[exe] === 'string' && fromJson[exe] !== '') {
      const exists = existsSync(fromJson[exe]);
      resolved[exe] = { path: fromJson[exe], source: 'toolchain.json', exists };
      if (!exists) notes.push('toolchain.json 里的 ' + exe + ' 路径不存在：' + fromJson[exe]);
      continue;
    }
    const onPath = whichSync(exe);
    resolved[exe] = onPath === null ? { path: null, source: 'none', exists: false } : { path: onPath, source: 'PATH', exists: true };
  }

  let source = 'none';
  if (resolved['mlir-opt'].source === 'config' || resolved['mlir-reduce'].source === 'config') source = 'config';
  else if (resolved['mlir-opt'].source === 'toolchain.json' || resolved['mlir-reduce'].source === 'toolchain.json') source = 'toolchain.json';
  else if (resolved['mlir-opt'].source === 'PATH' || resolved['mlir-reduce'].source === 'PATH') source = 'PATH';

  return {
    mlirOpt: resolved['mlir-opt'],
    mlirReduce: resolved['mlir-reduce'],
    node: resolveNode(),
    toolchainPath: toolchainPath === '' ? null : toolchainPath,
    source,
    notes,
    versions,
  };
}

/**
 * 找 node 可执行文件：宿主进程本身是 node 就直接用，否则在 PATH 上找。
 * mlir-reduce 的 tester 需要 node 跑 tester.mjs（Windows 不能直接执行脚本文件）。
 * @returns {{path, source}}
 */
export function resolveNode() {
  const execPath = typeof process.execPath === 'string' ? process.execPath : '';
  if (/^node(\.exe)?$/i.test(basename(execPath))) return { path: execPath, source: 'process.execPath' };
  const onPath = whichSync('node');
  if (onPath !== null) return { path: onPath, source: 'PATH' };
  return { path: null, source: 'none' };
}
