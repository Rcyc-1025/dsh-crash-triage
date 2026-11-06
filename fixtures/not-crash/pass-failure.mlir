// 能解析、能验证，pipeline 里写错 pass 名时只有 error: 诊断（不是崩溃）。
// 用法：--pass-pipeline=builtin.module(func.func(cse),func.func(no-such-pass))
module {
  func.func @add(%a: i32, %b: i32) -> i32 {
    %0 = arith.addi %a, %b : i32
    return %0 : i32
  }
}
