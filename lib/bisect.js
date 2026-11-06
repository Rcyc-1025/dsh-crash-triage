import { classifyRun } from './classify.js';
import { runMlirOpt } from './run.js';

/**
 * 在顶层逗号上切分（括号内的逗号不切，引号内的也不切）。
 * @param text - 例如 'func.func(cse),func.func(canonicalize)'。
 * @returns 片段数组（已 trim，空片段丢弃）。
 */
export function splitTopLevel(text) {
  const value = typeof text === 'string' ? text : '';
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of value) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/**
 * 剥掉 pipeline 最外层的 builtin.module(...)；不是这种形状时原样返回。
 * @returns {{wrapper, body}}
 */
export function stripModuleWrapper(pipeline) {
  const value = typeof pipeline === 'string' ? pipeline.trim() : '';
  const head = 'builtin.module(';
  if (!value.startsWith(head) || !value.endsWith(')')) return { wrapper: null, body: value };
  const inner = value.slice(head.length, -1);
  // 最外层括号必须闭合成对，否则说明这只是子串巧合。
  let depth = 0;
  for (const char of inner) {
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return { wrapper: null, body: value };
    }
  }
  if (depth !== 0) return { wrapper: null, body: value };
  return { wrapper: head.slice(0, -1), body: inner };
}

/**
 * 把 pipeline 拆成「可二分的前缀单元」（规格 3.8.1）。
 * passList 优先；否则从 pipeline 剥 builtin.module 外层后按顶层逗号切分。
 * @param pipeline - pass pipeline 文本。
 * @param passList - 调用方显式给的 pass 列表（可选）。
 * @returns {{passes, wrapper, source, nested, note}}
 */
export function extractPasses(pipeline, passList) {
  const explicit = Array.isArray(passList) ? passList.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : [];
  if (explicit.length > 0) {
    return { passes: explicit, wrapper: 'builtin.module', source: 'passList', nested: false, note: null };
  }
  const stripped = stripModuleWrapper(pipeline);
  const passes = splitTopLevel(stripped.body);
  const nested = passes.length <= 1 && /[()]/.test(stripped.body);
  return {
    passes,
    wrapper: stripped.wrapper !== null ? stripped.wrapper : 'builtin.module',
    source: 'pipeline',
    nested,
    note: nested ? 'pipeline 只有一层嵌套（例如 func.func(...)），v1 只拆顶层，无法继续二分' : null,
  };
}

/**
 * 拼出前 i 个 pass 组成的 pipeline（i=0 表示空 pipeline）。
 * @param wrapper - 外层模块名，默认 builtin.module。
 * @param passes - 全部 pass 片段。
 * @param count - 取前几个。
 */
export function buildPrefix(wrapper, passes, count) {
  const list = Array.isArray(passes) ? passes.slice(0, Math.max(0, Math.trunc(count))) : [];
  const moduleName = typeof wrapper === 'string' && wrapper !== '' ? wrapper : 'builtin.module';
  if (list.length === 0) return moduleName + '()';
  return moduleName + '(' + list.join(',') + ')';
}

/**
 * 解析 -mlir-print-ir-after-all 的 dump marker：
 * "// -----// IR Dump After CanonicalizerPass: canonicalize{...} //----- //"
 * @returns {{label, raw}[]} 按出现顺序。
 */
export function parsePrintIrMarkers(text) {
  const body = typeof text === 'string' ? text : '';
  const markers = [];
  const regex = /\/\/ -----\/\/ IR Dump After (.+?) \/\/----- \/\//g;
  let matched = regex.exec(body);
  while (matched !== null) {
    markers.push({ label: matched[1].trim(), raw: matched[0] });
    matched = regex.exec(body);
  }
  return markers;
}

/**
 * 把连续的相同 marker 合成一段（函数级 pass 会对每个函数打一次）。
 * @returns {{label, count, start, end}[]}
 */
export function groupPrintIrMarkers(markers) {
  const list = Array.isArray(markers) ? markers : [];
  const groups = [];
  for (let index = 0; index < list.length; index += 1) {
    const marker = list[index];
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === marker.label) {
      last.count += 1;
      last.end = index;
      continue;
    }
    groups.push({ label: marker.label, count: 1, start: index, end: index });
  }
  return groups;
}

/** 把 pass 片段归一成可比较的短名：'func.func(canonicalize)' → 'canonicalize'。 */
export function passShortName(segment) {
  const value = typeof segment === 'string' ? segment.trim() : '';
  const tail = value.match(/([A-Za-z0-9_-]+)\)*$/);
  const name = tail !== null ? tail[1] : value;
  return name.toLowerCase().replace(/-?pass$/, '');
}

/**
 * 用 dump marker 交叉验证「第几个 pass 之后崩了」。
 * @param markers - parsePrintIrMarkers 的结果。
 * @param passes - 全部 pass 片段。
 * @returns {{matchedIndex, lastLabel, groups, unmatched}}，matchedIndex 是 1-based 的 pass 序号（无匹配为 null）。
 */
export function analyzePrintIrMarkers(markers, passes) {
  const groups = groupPrintIrMarkers(markers);
  const list = Array.isArray(passes) ? passes : [];
  let matchedIndex = null;
  let unmatched = true;
  for (const group of groups) {
    const lowered = group.label.toLowerCase();
    for (let index = 0; index < list.length; index += 1) {
      const short = passShortName(list[index]);
      if (short !== '' && lowered.includes(short)) {
        matchedIndex = index + 1;
        unmatched = false;
        break;
      }
    }
  }
  const lastGroup = groups.length > 0 ? groups[groups.length - 1] : null;
  return { matchedIndex, lastLabel: lastGroup !== null ? lastGroup.label : null, groups, unmatched };
}

/**
 * 对前缀做二分，找出「加到第几个 pass 才开始崩」（规格 3.8.2/3.8.3）。
 *
 * @param options.runner - subprocess runner。
 * @param options.optPath - mlir-opt 路径。
 * @param options.irPath - 输入 IR（工作目录里的副本）。
 * @param options.passes - pass 片段数组。
 * @param options.wrapper - 外层模块名。
 * @param options.maxRuns - 最多跑几次。
 * @param options.timeoutMs - 单次超时。
 * @param options.cwd / env - 运行参数。
 * @param options.crashExitCodes / crashPatterns - 判定崩溃用。
 * @param options.stopAtFirst - 只看是否「第一个 pass 就崩」。
 * @param options.signal - 取消信号。
 * @returns 二分结果；失败时 ok:false + code。
 */
export async function bisectPasses(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const passes = Array.isArray(opts.passes) ? opts.passes : [];
  const total = passes.length;
  const maxRuns = Number.isFinite(Number(opts.maxRuns)) ? Math.max(1, Math.trunc(Number(opts.maxRuns))) : 64;
  const evidence = [];
  const notes = [];
  const observations = new Map();
  let runs = 0;

  const result = {
    attempted: true,
    ok: false,
    strategy: opts.stopAtFirst === true ? 'stop-at-first' : 'binary',
    totalPasses: total,
    runs: 0,
    failingPass: null,
    failingIndex: null,
    passingPrefix: null,
    failingPrefix: null,
    evidence,
    notes,
    error: null,
  };

  if (total === 0) {
    result.error = { code: 'PASS_LIST_INVALID', message: '没有可二分的 pass', hint: '请给 pipeline 或 passList 提供至少一个 pass。' };
    return result;
  }
  if (total === 1) {
    result.error = { code: 'PASS_NESTED', message: 'pipeline 只有一项，无法二分', hint: '把 pipeline 拆成多个顶层 pass 再试，或直接看这一项的崩溃输出。' };
    result.evidence = evidence;
    return result;
  }

  const runCount = async (count) => {
    if (observations.has(count)) return observations.get(count);
    if (runs >= maxRuns) return null;
    const pipeline = buildPrefix(opts.wrapper, passes, count);
    const runResult = await runMlirOpt(opts.runner, {
      optPath: opts.optPath,
      irPath: opts.irPath,
      pipeline,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      signal: opts.signal,
    });
    runs += 1;
    const classified = classifyRun({
      exitCode: runResult.exitCode,
      signal: runResult.signal,
      stdout: runResult.stdout,
      stderr: runResult.stderr,
      crashExitCodes: opts.crashExitCodes,
      crashPatterns: opts.crashPatterns,
    });
    const observation = { count, pipeline, crashed: classified.crashed, exitCode: runResult.exitCode, reason: classified.reason, timedOut: runResult.timedOut };
    observations.set(count, observation);
    evidence.push({ passCount: count, prefix: pipeline, exitCode: runResult.exitCode, crashed: classified.crashed, reason: classified.reason });
    return observation;
  };

  const full = await runCount(total);
  if (full === null) {
    result.runs = runs;
    result.error = { code: 'BISECT_INCONCLUSIVE', message: '跑满 maxRuns 仍未完成（完整 pipeline 都没跑成）', hint: '调大 bisect.maxRuns 或缩小 timeoutMs 后重试。' };
    return result;
  }
  result.runs = runs;
  if (full.crashed !== true) {
    result.error = { code: 'BISECT_FAILED', message: '完整 pipeline 没有复现崩溃：' + full.reason, hint: '确认 irPath + pipeline 的组合确实会崩，再二分。' };
    return result;
  }

  if (opts.stopAtFirst === true) {
    const first = await runCount(1);
    result.runs = runs;
    if (first !== null && first.crashed === true) {
      result.ok = true;
      result.failingIndex = 1;
      result.failingPass = passes[0];
      result.passingPrefix = buildPrefix(opts.wrapper, passes, 0);
      result.failingPrefix = buildPrefix(opts.wrapper, passes, 1);
      notes.push('stopAtFirst：第一个 pass 单独跑就会崩');
    } else {
      result.ok = false;
      result.error = { code: 'BISECT_FAILED', message: 'stopAtFirst 模式下第一个 pass 不崩', hint: '去掉 bisect.stopAtFirst 让插件做完整二分。' };
    }
    return result;
  }

  // 二分：找最小的 k 使前 k 个 pass 会崩；假设「加得越多越容易崩」。
  let lo = 0;
  let hi = total;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const observation = await runCount(mid);
    if (observation === null) {
      result.runs = runs;
      result.error = { code: 'BISECT_INCONCLUSIVE', message: '跑满 maxRuns（' + maxRuns + '）仍未收敛', hint: '调大 bisect.maxRuns 或换 passList 缩小范围。' };
      return result;
    }
    if (observation.crashed === true) hi = mid;
    else lo = mid;
  }
  result.runs = runs;

  // 单调性检查：观察到「少 pass 崩、多 pass 不崩」就说明假设不成立，退回线性扫描。
  let monotone = true;
  const sorted = [...observations.values()].sort((a, b) => a.count - b.count);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].crashed === true && sorted[index].crashed === false) monotone = false;
  }
  if (!monotone) {
    notes.push('检测到非单调：前 ' + lo + ' 个 pass 的状态与后段不一致，回退线性扫描');
    result.strategy = 'linear-fallback';
    for (let count = 1; count <= total; count += 1) {
      const observation = await runCount(count);
      if (observation === null) {
        result.runs = runs;
        result.error = { code: 'BISECT_INCONCLUSIVE', message: '线性回退时跑满 maxRuns（' + maxRuns + '）', hint: '调大 bisect.maxRuns。' };
        return result;
      }
      if (observation.crashed === true) {
        lo = count - 1;
        hi = count;
        break;
      }
      lo = count;
      hi = total;
    }
    result.runs = runs;
  }

  // 收敛后复验边界：hi 崩、lo 不崩（lo=0 时用空 pipeline 验证）。
  const failObs = await runCount(hi);
  const passObs = await runCount(lo);
  result.runs = runs;
  if (failObs === null || passObs === null) {
    result.error = { code: 'BISECT_INCONCLUSIVE', message: '验证边界时跑满 maxRuns（' + maxRuns + '）', hint: '调大 bisect.maxRuns。' };
    return result;
  }
  if (failObs.crashed !== true) {
    result.error = { code: 'BISECT_FAILED', message: '边界复验失败：前 ' + hi + ' 个 pass 这次没崩', hint: '崩溃可能不稳定，先确认 crash.stable，再重跑。' };
    return result;
  }
  if (passObs.crashed === true) {
    result.error = { code: 'BISECT_INCONCLUSIVE', message: '边界复验失败：前 ' + lo + ' 个 pass 也崩', hint: '崩溃点不唯一或前置 pass 之间有耦合，可以用 bisect.strategy=print-ir 看实际执行顺序。' };
    return result;
  }

  result.ok = true;
  result.failingIndex = hi;
  result.failingPass = passes[hi - 1];
  result.passingPrefix = buildPrefix(opts.wrapper, passes, lo);
  result.failingPrefix = buildPrefix(opts.wrapper, passes, hi);
  notes.push('前 ' + lo + ' 个 pass 不崩，加到第 ' + hi + ' 个（' + passes[hi - 1] + '）后崩溃');
  return result;
}

/**
 * 用 -mlir-print-ir-after-all 的实际 dump 顺序交叉验证二分结果（规格 3.8.4）。
 * @param options.runner / optPath / irPath / pipeline / cwd / timeoutMs / env
 * @returns {{ran, markers, matchedIndex, lastLabel, conflict}}；跑不出来时 ran:false。
 */
export async function crossCheckWithPrintIr(options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const runnerArgs = Array.isArray(opts.runnerArgs) ? opts.runnerArgs.slice() : [];
  runnerArgs.push('-mlir-print-ir-after-all');
  const runResult = await runMlirOpt(opts.runner, {
    optPath: opts.optPath,
    irPath: opts.irPath,
    pipeline: opts.pipeline,
    runnerArgs,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    env: opts.env,
    signal: opts.signal,
  });
  const markers = parsePrintIrMarkers(runResult.stderr + runResult.stdout);
  const analyzed = analyzePrintIrMarkers(markers, opts.passes);
  return {
    ran: true,
    markers: markers.length,
    matchedIndex: analyzed.matchedIndex,
    lastLabel: analyzed.lastLabel,
    groups: analyzed.groups.length,
    exitCode: runResult.exitCode,
  };
}
