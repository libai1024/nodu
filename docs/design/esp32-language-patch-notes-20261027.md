# ALS Unicode 与行映射最小补丁审查

2026-10-27。本文记录源码审查和建议回归边界，不替代语言服务构建者的真实 Go 测试、协议及 Electron 验收结果。

## 已确认的问题

Arduino Language Server 0.7.7 使用 `go.bug.st/lsp v0.1.3`。其 `textedits.GetOffset` 将 LSP 的 UTF-16 列号直接与 Go `range` 返回的 UTF-8 字节偏移比较；列号未命中字节边界时还可能返回整份文档末尾。中文 BMP 字符也会触发，并不限于 emoji。测试里的 JavaScript `.length` 正是 UTF-16 code unit 数，不能改成 UTF-8 字节长度向 clangd 发送。

例如 `  Serial.println("测试 😀 0");` 长度为 28 个 UTF-16 code unit、34 个 UTF-8 字节。使用 `(0,28)` 替换行尾时，旧实现可能把后续 `KEEP();` 一并删除。[原始依赖源码](https://github.com/bugst/go-lsp/blob/v0.1.3/textedits/textedits.go#L50)

`SketchMapper.ApplyTextChange` 另有独立问题：`dirty = dirty || s.deleteCppLine(...)` 和 `addInoLine(...)` 在 `dirty=true` 后短路，导致余下行映射没有更新。[原始 mapper 源码](https://github.com/arduino/arduino-language-server/blob/0.7.7/sourcemapper/ino.go#L258)

官方 main（查询时为 `050dd9bcd822683f7e23e60e93339199771195e9`）及 0.8.0-rc.1 仍使用 v0.1.3 并保留这些实现。Arduino IDE 所带 `05ec308` 使用 v0.1.2，其偏移实现相同。[官方发布页](https://github.com/arduino/arduino-language-server/releases)、[旧版依赖](https://github.com/arduino/arduino-language-server/blob/05ec308/go.mod)

## 最小修改与边界

`GetOffset` 应使用单独的 UTF-16 code unit 计数；BMP rune 加 1，非 BMP rune 加 2，返回值仍是原 UTF-8 字符串的字节下标。到达换行或 EOF 后，把过大的列号夹到当前行末尾。CRLF 的列末尾位于 `\r` 前，不得吞掉换行。落在 surrogate pair 中间的非法位置应报错，不得静默移动后修改另一段代码。

保留现有负行/负列拒绝行为；建议补丁保持 ASCII 负列的 `OutOfRangeError.Max` 语义。现有 `GetLineOffset` 只识别 `\n`，本次最小补丁覆盖 LF/CRLF，不宣称新增只有裸 `\r` 的文件支持。

针对短路这一缺陷，两处修改可交换 OR 操作数，使维护函数总会执行；这不代表已经修复所有复杂 prototype 映射问题：

```go
dirty = s.deleteCppLine(cppRange.Start.Line) || dirty
dirty = s.addInoLine(cppRange.Start.Line) || dirty
```

无范围的全文 `didChange` 仍未被 ALS 支持，不能在这次补丁中默认为已解决。客户端应继续按标准增量范围发送，后续通过真实协议验证整段替换与自动声明映射。

## 已交给构建者的回归建议

建议补丁与测试草稿位于 `/tmp/nodu-als-readonly-wpuz07eo/`：`utf16-mapper-proposed.patch`、`textedits_utf16_test.go`、`ino_multiline_test.go`。草稿由源码审查生成，当时本机没有 Go；实际执行结果由构建者另行留证。

- UTF-16 偏移表覆盖 ASCII、中文、emoji 前后、emoji 后同一行编辑、LF/CRLF、行末超列、EOF 无换行及负位置；surrogate pair 中间位置必须拒绝。
- 连续替换含中文与 emoji 的行后，断言下一行 `KEEP();` 原样保留。
- mapper 在带自动函数声明的 `setup` 行前连续插入两行，断言后续 `.ino → .cpp` 行号全部平移；这能直接触发原来的 `dirty=true` 短路。
- mapper 删除两行后，断言剩余行映射正确，源尾已删除行不再有旧映射。
- 默认 `go test ./...` 跳过 vendor；需显式运行 `go test -mod=vendor go.bug.st/lsp/textedits ./sourcemapper`，并保留原有测试。

真实协议验收还应覆盖未保存的连续 Unicode 编辑、EOF 无换行、整段替换与 undo，并核对新位置 hover/definition/diagnostics。ALS 重建先 debounce 1 秒再调用 CLI，固定等待 1.5 秒不能作为同步保证；若测试依赖重建，应等待本次修改后的 progress end，并继续进行语义断言，因为失败的重建也会发出 end。


## 后续真实多行审计

构建者反馈最小补丁的 Go 回归通过，C3 连续 12 次中文/emoji 编辑及新诊断约 600 ms 完成；该结论属于构建者的实际执行结果。只读审计进一步检查了其真实 ALS 日志：`/private/tmp/nodu-arduino-e2e-20261026/language-patched-incremental/esp32c3-stderr.txt` 第 2394–2458 行。跨顶层函数的大段替换后，`JsonDocument` 实际处于生成 C++ 的第 14 行（零基），源 `.ino` 第 6 行却映射到 C++ 第 11 行，自动 prototype 别名与正文互相覆盖；第 9 行 `#line` 指令也被误映射为源码。

原因是原 `deleteCppLine` / `addInoLine` 对 `inoToCpp`、`inoPreprocessed` 等映射原地搬迁多个别名，可能覆盖尚未处理的条目。交换 OR 操作数只修复漏执行，不修复别名覆盖。此次不扩展为上游映射算法重构：保留已证明的 UTF-16 与短路补丁，普通函数体增量编辑继续快速处理；跨声明、预处理或不确定的词法结构合并为最新全文并重同步，等待真实重建后再查询语义。

初版客户端安全扫描还复现了以下误判，已通知实现者修正，并需要在最终测试中覆盖：

- `namespace`、`struct/class` 和全局 initializer 内的花括号不等于函数体，不能仅以 `depth > 0` 放行。
- 修改 `#include` 或函数名称，即使没有换行，也不能在安全分类之前直接放行。
- 宏续行、条件编译和反斜杠续行注释会改变真实词法上下文；仅逐行删 `#...` 并计数花括号不可靠。
- Raw string、未闭合引号/注释和拆在两个字符标记中间的编辑边界需保守处理；注释或字符串里的 `{}` 不能贡献函数体深度。
- 安全路径应确认编辑前后都位于同一个已识别的普通函数体，且没有跨越其闭合括号；不能把类、命名空间或 lambda 的全局初始化当作该安全域。

这里记录的是审计要求及初版复现，不替代实现者修正后的单测和实际协议结果。

## 客户端边界复验

实现者收紧安全函数体识别并处理同一行跨界与 CRLF 转换后，本审计独立调用实际 helper 的 14 项边界案例全部通过。先前列出的已知误判均已转入重同步，普通 Unicode、函数体换行和 CRLF 文字编辑仍保持增量。[完整结果、源摘要与可重复脚本](evidence/esp32-language-patch-audit-20261027/README.md)。这组复验不替代构建者的真实协议结果。
