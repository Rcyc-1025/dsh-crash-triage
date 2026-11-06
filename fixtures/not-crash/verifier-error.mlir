// 合法词法、非法验证：func.return 少给返回值 → mlir-opt 退出码 1 且只有 error: 诊断。
module {
  func.func @f() -> i32 {
    func.return
  }
}
