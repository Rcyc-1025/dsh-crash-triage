import { resolveConfig } from './config.js';
import { createSubprocessRunner } from './exec.js';
import { buildCrashTriageTools } from './tools.js';

/**
 * dsh-crash-triage —— MLIR 崩溃分诊插件。
 *
 * 只注册一个工具 crash_triage：给定 IR 与 pass pipeline，复现崩溃、解析 sanitizer 报告、
 * 用 mlir-reduce 缩小 IR、二分出错 pass，最后写出可转交的 report.md 与 result.json。
 * 执行走宿主 subprocess 服务（argv 数组、无 shell），零运行时依赖；
 * 工具缺失时插件照常加载，execute 返回 ok:false + 中文 hint。
 *
 * @module dsh-crash-triage
 */

/** cordis 服务注入：apply 里要用 ctx.subprocess 与 ctx.tools。 */
export const name = 'crash-triage';
export const inject = ['subprocess', 'tools'];

/**
 * 插件入口：解析配置、封装 subprocess 执行器、注册 crash_triage。
 * @param ctx - 宿主上下文（至少含 subprocess.spawn 与 tools.register）。
 * @param config - cordis.patch.yml 里的 config（可缺省）。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config, process.cwd());
  const runner = createSubprocessRunner((spec) => ctx.subprocess.spawn(spec), cfg.graceMs, cfg.timeoutMs);
  const disposers = [];
  for (const definition of buildCrashTriageTools(cfg, runner)) {
    disposers.push(ctx.tools.register(definition));
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) dispose();
    });
  }
}
