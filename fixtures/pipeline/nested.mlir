// 只有一个顶层 pass 段、内部嵌套两层：v1 不拆嵌套，二分应报 PASS_NESTED。
// 用法：passList=["func.func(cse,canonicalize)"] 或 pipeline=builtin.module(func.func(cse,canonicalize))
module {
  func.func @id(%a: i32) -> i32 {
    %0 = arith.addi %a, %a : i32
    return %0 : i32
  }
}
