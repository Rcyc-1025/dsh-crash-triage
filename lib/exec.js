/** 单次调用最多收集 8MB；真正返回给模型的正文由 maxOutputBytes 再截断一次。 */
const COLLECT_BYTES = 8 * 1024 * 1024;

/**
 * 把宿主的 subprocess.spawn 包成「永不抛 ENOENT」的执行器：
 * 超时 / 取消都归一成 {exitCode:null, timedOut}，而不是异常。
 * @param spawn - (spec) => {done, collected}。
 * @param graceMs - 终止信号的宽限期。
 * @param defaultTimeoutMs - 未指定 timeoutMs 时的上限。
 */
export function createSubprocessRunner(spawn, graceMs, defaultTimeoutMs) {
  return async function run(argv, options) {
    const opts = options !== null && typeof options === 'object' ? options : {};
    const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : defaultTimeoutMs;
    const controller = new AbortController();
    const signals = [controller.signal];
    if (opts.signal !== undefined && opts.signal !== null) signals.push(opts.signal);
    const signal = signals.length === 1 ? controller.signal : AbortSignal.any(signals);
    let timedOut = false;
    let envIgnored = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('timeout after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    const startedAt = Date.now();
    let handle = null;

    const readStream = (stream) => {
      try {
        return stream !== null && stream !== undefined && typeof stream.readFrom === 'function' ? stream.readFrom(0) : null;
      } catch {
        return null;
      }
    };
    const finish = (outcome, aborted, error) => {
      const stdout = readStream(handle !== null ? handle.collected.stdout : null);
      const stderr = readStream(handle !== null ? handle.collected.stderr : null);
      return {
        exitCode: timedOut || aborted ? null : (outcome !== null && typeof outcome === 'object' ? (outcome.exitCode ?? null) : null),
        signal: outcome !== null && typeof outcome === 'object' ? (outcome.signal ?? null) : null,
        stdout: stdout !== null && typeof stdout.text === 'string' ? stdout.text : '',
        stderr: stderr !== null && typeof stderr.text === 'string' ? stderr.text : '',
        truncated: (stdout !== null && stdout.truncated === true) || (stderr !== null && stderr.truncated === true),
        lossy: (stdout !== null && stdout.lossy === true) || (stderr !== null && stderr.lossy === true),
        timedOut,
        durationMs: Date.now() - startedAt,
        error: error === undefined ? null : String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error),
      };
    };

    const spec = {
      argv,
      cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
      stdio: { stdin: 'ignore', stdout: { maxBytes: COLLECT_BYTES }, stderr: { maxBytes: COLLECT_BYTES } },
      graceMs,
      signal,
    };
    const hasEnv = opts.env !== null && typeof opts.env === 'object';
    if (hasEnv) spec.env = { ...process.env, ...opts.env };

    try {
      try {
        handle = spawn(spec);
      } catch (error) {
        // 宿主 subprocess 不认 env 时退回不带 env 的调用，并在结果里标出来。
        if (hasEnv !== true) throw error;
        delete spec.env;
        envIgnored = true;
        handle = spawn(spec);
      }
      const outcome = await handle.done;
      const finished = finish(outcome, false, undefined);
      return envIgnored ? { ...finished, envIgnored: true } : finished;
    } catch (error) {
      if (signal.aborted) return finish(null, true, timedOut ? 'timeout after ' + timeoutMs + 'ms' : signal.reason);
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
}
