# dsh-crash-triage

**把一次 MLIR 崩溃压缩成「可复现命令 + 最小 IR + 出错 pass + sanitizer 栈 + 可转交报告」。**

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)

只注册一个工具 `crash_triage`，四种动作：

| 动作 | 做什么 | 典型提问 |
| --- | --- | --- |
| `diagnose`（默认） | 复现崩溃 → 缩减 IR → 二分 pass → 写报告，一条龙 | 「这条 IR 为什么崩？」 |
| `reduce` | 只做 IR 最小化（mlir-reduce + 签名守着） | 「帮我压到最小复现」 |
| `bisect` | 只做 pass 二分，找出第一个崩的 pass | 「哪个 pass 崩的？」 |
| `parse` | 只解析 sanitizer 报告：不启动 `mlir-opt`，不复现、不缩减、不二分 | 「这份 ASan 日志说了什么？」 |

插件绝不把 `ENOENT` 抛给模型：工具缺失、IR 不存在、输出目录越界、超时、取消，全部返回 `ok:false` + 中文 `hint` + `stage`。

## 它不做什么

- 不做 core dump，不做符号化（v1 只解析**外部提供**的 sanitizer 日志）。
- 不自动修 bug、不改 IR 语义、不编造堆栈。
- 不编译 MLIR、不跑 `cmake` / `ninja`。
- 不跑任意 shell：只 argv 方式 spawn `mlir-opt`、`mlir-reduce`，以及缩减时 tester 用的 `node`。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0-0`
- LLVM/MLIR 的 `mlir-opt`（必需）与 `mlir-reduce`（缩减才需要）。开发与验收使用 LLVM 23.1.4。
- 缩减需要 `node`：插件会自己找（DSH 运行时自带的 node 优先），不依赖宿主进程的 `process.execPath`。

没有 `mlir-reduce` 时插件照常加载，但请求缩减（默认）时 `diagnose` / `reduce` 都会返回 `TOOL_NOT_FOUND`；不需要缩减就传 `reduce: { enabled: false }`（复现与 pass 二分照常跑）。

## 安装

```bash
dsh plugin --profile desktop add ./dsh-crash-triage
```

CLI 会把包加入 profile 的 `dsh.profile.bundles`，插件通过自带的 `cordis.patch.yml` 自注册。卸载：

```bash
dsh plugin --profile desktop remove dsh-crash-triage
```

> 在 `workspace-write` 沙箱会话里安装时，profile 目录可能在 workspace 之外；请在普通终端安装，或按提示授予权限。

## 配置

工具路径解析顺序：

1. 本插件 config 里的 `mlirOptPath` / `mlirReducePath`（显式覆盖，不存在**不回退** PATH，便于尽早报 `TOOL_NOT_FOUND`）；
2. `toolchainJson` 指向的文件，或自动发现的 `<cwd>/mlir-lang/toolchain.json`、`<cwd>/toolchain.json`；
3. PATH 上的 `mlir-opt` / `mlir-reduce`。

```yaml
- id: crash-triage
  name: 'dsh-crash-triage'
  config:
    mlirOptPath: D:\Code\llvm-build\bin\mlir-opt.exe      # 单引号内反斜杠不转义
    mlirReducePath: D:\Code\llvm-build\bin\mlir-reduce.exe
    timeoutMs: 120000
    keepWorkDir: true
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `timeoutMs` | `120000` | 单次子进程超时 |
| `graceMs` | `5000` | 超时后强杀前的宽限 |
| `maxTotalMs` | `900000` | 一次工具调用的总预算（含缩减、二分） |
| `maxIrBytes` | `33554432` | 输入 IR 上限，超过报 `IR_TOO_LARGE` |
| `maxOutputBytes` | `1048576` | 输出摘录上限（完整内容仍写盘） |
| `maxReduceIterations` | `200` | 期望的缩减迭代上限（mlir-reduce 无开关，靠超时兜底，仅用于提示） |
| `maxReduceTimeMs` | `600000` | 缩减时间预算 |
| `maxBisectRuns` | `64` | 二分最多跑几次 mlir-opt |
| `workDir` | `'.crash-triage'` | 产物根目录（相对会话 cwd） |
| `keepWorkDir` | `true` | `false` 且成功时删除产物目录（失败永远保留现场） |
| `toolchainJson` | `''` | 显式 toolchain.json 路径 |
| `mlirOptPath` / `mlirReducePath` | `''` | 显式可执行文件路径 |
| `sanitizerMode` | `'auto'` | `auto` / `off` / `asan` / `ubsan` |
| `maxFrames` | `10` | sanitizer 栈保留帧数 |
| `crashExitCodes` | Windows: 3221225477、3221225725、3221226505、3221225501、2147483651；Unix: 134、139、132、136 | 崩溃退出码 |
| `crashPatterns` | `LLVM ERROR:`、`Assertion failed:`、`PLEASE submit a bug report`、`Stack dump:`、`AddressSanitizer:`、`UndefinedBehaviorSanitizer:`、`runtime error:` | 崩溃特征串 |

环境变量覆盖（优先级在 config 之上）：`CRASH_TRIAGE_TIMEOUT_MS`、`CRASH_TRIAGE_MAX_OUTPUT_BYTES`、`CRASH_TRIAGE_TOOLCHAIN_JSON`。

## 工具 `crash_triage`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `diagnose`（默认）/`reduce`/`bisect`/`parse` | 做多少事 |
| `irPath` | string | 输入 IR；相对 `cwd` 解析 |
| `stdin` | string | 直接给 IR 文本，写到工作目录的 `input.mlir`（此时 `irPath` 只作为文件名） |
| `pipeline` | string | 例如 `builtin.module(func.func(cse),canonicalize)` |
| `passList` | string[]（1..64） | 顶层 pass 列表，给了就拼成 `builtin.module(<a,b,c>)`，并作为二分的切分依据 |
| `runnerArgs` | string[] | 追加给 `mlir-opt` 的参数 |
| `cwd` | string | 子进程工作目录 |
| `env` | object(string) | 追加环境变量 |
| `timeoutMs` | number（1000..600000） | 覆盖单次超时 |
| `outputDir` | string | 产物目录，**必须在会话 cwd 内**，否则 `OUTPUT_DIR_ESCAPE` |
| `keepWorkDir` | boolean | 覆盖配置 |
| `sanitizer` | object | `{mode, reportPath, inline, maxFrames}` |
| `reduce` | object | `{enabled, maxIterations, maxTimeMs, maxCandidates, testArgs}` |
| `bisect` | object | `{enabled, maxRuns, strategy: auto/prefix/print-ir, stopAtFirst}` |
| `report` | object | `{format: markdown/json/both, includeStderr}` |

### 示例

只复现 + 分类（不缩不二分，最快）：

```json
{ "action": "parse", "irPath": "tests/crash.mlir" }
```

完整诊断，指定 pipeline：

```json
{
  "irPath": "tests/crash.mlir",
  "pipeline": "builtin.module(func.func(canonicalize,cse),canonicalize)"
}
```

只要「哪个 pass 崩的」：

```json
{
  "action": "bisect",
  "irPath": "tests/crash.mlir",
  "passList": ["func.func(cse)", "func.func(canonicalize)", "cse", "canonicalize"]
}
```

带外部 sanitizer 报告：

```json
{
  "irPath": "tests/crash.mlir",
  "sanitizer": { "mode": "asan", "reportPath": "logs/asan.txt" }
}
```

只解析 sanitizer 报告（不启动 mlir-opt）：

```json
{ "action": "parse", "sanitizer": { "inline": "==1==ERROR: AddressSanitizer: heap-use-after-free ..." } }
```

内联 IR（不用先落盘，默认 diagnose）：

```json
{ "stdin": "module { func.func @f() { return } }" }
```

### 返回

`status` 取值 `diagnosed` / `reduced` / `bisected` / `parsed` / `partial` / `failed`；`ok` 只在**所有请求阶段都成功**时为 `true`。`diagnose` 里缩减失败不会阻断后续二分：结果返回 `ok:false` + `status:"partial"`，并保留已经拿到的复现/缩减结果；唯一顶层 pass 内部嵌套时同样走 `PASS_NESTED` + `partial`（`bisect.attempted:false`）。

成功时（节选）：

```json
{
  "ok": true,
  "status": "diagnosed",
  "crash": {
    "reproduced": true,
    "stable": true,
    "attempts": 3,
    "exitCode": 3221225477,
    "kind": "signal",
    "signature": { "key": "signal|EXCEPTION_ACCESS_VIOLATION|-|3221225477" }
  },
  "reducer": { "attempted": true, "ok": true, "reductionPercent": 97.4 },
  "bisect": { "attempted": true, "ok": true, "failingPass": "cse", "failingIndex": 2 },
  "reproducer": { "command": "mlir-opt --pass-pipeline=... input.mlir", "text": "..." },
  "artifacts": { "workDir": ".crash-triage/20261106-084542-access-violation", "reportPath": "...\report.md" },
  "warnings": [],
  "hints": []
}
```

失败时：

```json
{
  "ok": false,
  "status": "failed",
  "error": { "code": "NOT_A_CRASH", "message": "mlir-opt 没有崩溃（退出码 1）", "hint": "...", "stage": "baseline" },
  "artifacts": { "workDir": "...", "resultPath": "...", "reportPath": "..." }
}
```

## 产物

每次运行一个目录 `<workDir>/<YYYYMMDD-HHMMSS>-<IR 名>`：

| 文件 | 内容 |
| --- | --- |
| `input.mlir` | 本次实际执行的 IR 副本 |
| `baseline.stdout.log` / `baseline.stderr.log` | 第一次复现的原始输出 |
| `sanitizer.log` | 解析到的 sanitizer 报告（含来源） |
| `minimized.mlir` `/` `last-good.mlir` | 缩减结果（后者是签名守卫留下的最后一致版本） |
| `tester.log` / `reduce.log` | tester 每次判定的 JSON 行 / mlir-reduce 输出 |
| `passes.log` | 二分每次运行的摘要 |
| `reproducer.txt` | 可直接粘贴执行的复现命令 |
| `result.json` | 完整结构化结果（失败也写） |
| `report.md` | 七段式可转交报告：一句话结论 / 复现命令 / 输入 / 崩溃 / 最小 IR / 出错 pass / sanitizer 栈 / 产物 / 下一步 / 告警 / 提示 |

## 崩溃判定与签名

判定顺序：sanitizer 输出 > 崩溃退出码/信号 > 崩溃特征串 > 其余非零退出（只有 `error:` / verifier 诊断）归 `NOT_A_CRASH`。退出码 0 但输出里有 `LLVM ERROR:` 也算崩溃。

跑 3 次（1 + 2 次重试）都崩且签名一致才 `stable:true`；签名 `key = kind|errorType|topFrame|exitCode`，其中 `kind` ∈ `asan`、`ubsan`、`signal`、`assertion`、`llvm-error`、`unknown`。签名归一化会去掉 `0x` 地址、PID/TID、临时目录、CRLF、ANSI 颜色。

## 缩减：真实 tester 协议（和规格不同，务必看这里）

规格 3.7.3 写的是「tester 退出码 1 = 不 interesting」，**实际 MLIR 源码（`mlir/lib/Reducer/Tester.cpp`）相反**：

- `exit 1` = **interesting**（候选 IR 仍以同样签名崩溃）；
- `exit 0` = 不 interesting；
- tester 自己出错（找不到文件、参数不合法）也退出 0，并往日志写 `error` 行 —— 插件据此报 `REDUCE_TESTER_PROTOCOL`，而不是把「不 interesting」当真。

mlir-reduce 的调用形状（单横线、`=` 后用空格分隔、不能加外层引号）：

```
mlir-reduce <input.mlir> -reduction-tree=test=<node.exe> test-arg=<tester.mjs> test-arg=<tester.json> -o <out.mlir>
```

tester 子进程收到的 argv 是 `<node.exe> <tester.mjs> <test-arg…> <候选 mlir>`，候选 IR 永远在最后。缩减完成后插件用**原始 pipeline** 复验最小 IR，签名不一致就回退到 `last-good.mlir` 并报 `REDUCE_UNSTABLE`。

## 错误码

| code | 含义 |
| --- | --- |
| `INVALID_ARGUMENT` / `PIPELINE_INVALID` / `PASS_LIST_INVALID` | 参数或 pipeline 不规范 |
| `TOOL_NOT_FOUND` | 缺 `mlir-opt` / `mlir-reduce` |
| `IR_NOT_FOUND` / `IR_READ_FAILED` / `IR_TOO_LARGE` | 输入问题 |
| `OUTPUT_DIR_ESCAPE` / `WORKDIR_FAILED` | 产物目录越界或建不出来 |
| `CRASH_TIMEOUT` | 复现时超时 |
| `NOT_A_CRASH` / `NOT_REPRODUCED` / `FLAKY_CRASH` | 不崩 / 没复现出来 / 时崩时不崩 |
| `SANITIZER_NOT_FOUND` | 显式要 sanitizer 但没有报告 |
| `REDUCE_FAILED` / `REDUCE_TIMEOUT` / `REDUCE_UNSTABLE` / `REDUCE_TESTER_PROTOCOL` | 缩减失败 |
| `BISECT_FAILED` / `BISECT_INCONCLUSIVE` / `PASS_NESTED` | 二分失败 / 结论不清 / 只有一个顶层 pass |
| `CANCELLED` | 调用被取消 |

## 限制（v1）

- 不符号化：只有 `sanitizer.reportPath` / `sanitizer.inline` 里的报告，或进程自身的输出。
- 不拆嵌套 pipeline：`func.func(a,b)` 只当一个顶层段；需要更细粒度请展开成 `passList`。
- `mlir-reduce` 23.1.4 没有迭代上限开关，`maxIterations` / `maxCandidates` 只能观察和告警。
- 签名只看进程输出（退出码 + 特征串 + 顶帧），不比对 IR。
- 二分是前缀策略 + `print-ir` 交叉验证；两种证据冲突时都保留并告警。
- 崩溃退出码内置 Windows 与 Unix 常见值，可通过配置覆盖。
- **解析期崩溃（例如超深嵌套）连 @@@mlir-reduce@@@ 自己都会崩**：它会在调用 tester 之前就栈溢出，只留下空的 @@reduced.mlir@@。插件把这种情况判成 @@REDUCE_FAILED@@（消息里带 mlir-reduce 的退出码）并给出「换更小的输入 / 先按 pass 级复现」的 hint，而不是误报 @@REDUCE_UNSTABLE@@。

## 开发与验收

```bash
cd dsh-crash-triage
npm test        # 43 个单测，全部用 mock runner，不需要 LLVM
npm run smoke   # 真实 mlir-opt 冒烟；找不到工具时打印 SKIP 并 exit 0
```

冒烟用真实 `mlir-opt`（默认 `D:\Code\llvm-build\bin\mlir-opt.exe`）：

```powershell
$env:CRASH_TRIAGE_MLIR_OPT = 'D:\Code\llvm-build\bin\mlir-opt.exe'
$env:CRASH_TRIAGE_MLIR_REDUCE = 'D:\Code\llvm-build\bin\mlir-reduce.exe'
npm run smoke
```

- `test/fixtures/crash/access-violation.mlir`：约 4000 层嵌套 `scf.execute_region`，真实触发 `mlir-opt` 解析期栈溢出（`3221225477`，stderr 为空），同时验证「无 stderr 也能复现」。
- `test/fixtures/not-crash/*`：合法但很深（600 层）、verifier 报错、pass 名写错，用于确认**不会**误判成崩溃。
- 缩减与二分用 mock runner 覆盖：深度嵌套的崩溃在 `mlir-reduce` 的 tester 里同样会触发，真实工具无法拿它做缩减。

## 安全

- `outputDir` 必须在会话 cwd 内，越界直接 `OUTPUT_DIR_ESCAPE`。
- 只 spawn 白名单可执行文件（`mlir-opt` / `mlir-reduce` / tester 用的 `node`），argv 数组，不经 shell。
- `env` 只作用于子进程，不污染宿主。
- `keepWorkDir: false` 只在**成功**时删产物目录；失败永远留现场供排查。

## 许可

MIT，见 [LICENSE](LICENSE)。
