// 5 段顶层 pipeline 的输入：二分用例期望 failingIndex=4。
// 用法：--pass-pipeline=builtin.module(func.func(cse),func.func(canonicalize),func.func(loop-invariant-code-motion),cse,canonicalize)
module {
  func.func @mix(%a: i32, %b: i32) -> i32 {
    %c0 = arith.constant 0 : i32
    %0 = arith.addi %a, %b : i32
    %1 = arith.muli %0, %c0 : i32
    %2 = arith.addi %1, %a : i32
    return %2 : i32
  }
}
