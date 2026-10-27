# GUI 回车与粘贴事件的 mapper 重放

2026-10-27，从 GUI 保存的 `patched-multiline-wrong-hover.ino` 反向还原编辑前文本与两个连续事件：函数体注释末尾按 Enter（自动缩进），再粘贴注释和 `Serial.println` 两行。`events.json` 同时记录当时 helper 的选择与精确 UTF-16 原始增量。

在隔离复制的实际 patched ALS Go 源码中，直接依次应用两个原始增量。每一步均断言插入位置后方原有 `JsonDocument`、`serializeJson`、`void loop` 的映射及 C++ 文本，6 项均通过；[实际输出](go-result.txt)与[源摘要](result.json)保留。这说明该具体原始增量序列可由 mapper 正确处理，不等于 GUI/真实 ALS 的完整同步链路已通过。

故障发生时，helper 第一步因差异边界紧邻下一行注释 `/` 返回 reopen；第二步因重同步已 pending 也走全文重开。失败日志中源第 16 行悬停到 C++ 第 22 行，而 clangd 当时第 22 行仍是旧 `serializeJson`，应核查重同步等待与发送顺序。实现者随后修订了该普通回车的分类及 flush 等待，真实协议/GUI复验由主任务另行记录。

原协议测试在 loop 尾部插入 `body_value` 并检查新增段内部，没有检查后方既有符号的移动；Unicode测试还只查询编辑点前方的 JsonDocument，未断言内容。本重放补足 mapper 层的后方符号检查，但不能替代真实协议断言。

复验时，把 `nodu_gui_tail_test.go` 复制到准备好的 patched ALS 源码 `sourcemapper/`，在该源码目录运行（不修改产品源码）：

```sh
NODU_GUI_FIXTURES=/绝对路径/本证据目录 go test -mod=vendor ./sourcemapper -run TestGuiEnterPasteTailSymbols -v
```

`before.cpp` 含与现场相同结构的 setup/loop 自动声明及路径指令。它是由已保存源文本构建的定位夹具，不声称逐字节复制了当时不可再取的旧 C++ 缓冲区。
