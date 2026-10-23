# 纯函数执行检查

2026-10-24 起接入现有“检查片段”和动态教学片段检查。只测试内置 `sht30-pure-v1` 契约，不增加工具入口，不执行模型提供的命令、测试脚本或工程构建配置。语法检查、纯函数测试、固件编译、下载、串口证据保持独立。

## 执行边界

Rust tree-sitter 从当前 C 缓冲区提取唯一的 `sht30_crc8`、`sht30_convert` 定义，以及课程中三个数字常量。条件预处理、函数调用、内联汇编、编译器属性、重复定义等不进入执行器。头文件和全局代码不会复制；缺少外部定义返回无法独立编译，不推测补齐。采用课程中固定的 uint8_t / uint16_t / sht30_raw_t / sht30_reading_t 类型契约，并非验证工程自定义头文件的所有语义。

后端使用 WASI SDK 34 的 clang 23.1.0 编译到 `wasm32-wasip1`，指定 `-nostdlib -nostdinc -fno-builtin`，不搜索工程头文件。运行时固定 Wasmtime 50.0.0，仅调用内置 `run_tests`。测试产物必须没有 import section，因而不使用任何 WASI 系统调用。没有目录预打开、环境变量继承、网络、时钟、终端或硬件访问。也不接受预编译 cwasm。

每个子进程有 5 秒墙钟限制、16 KB 输出限制；POSIX 进程组在取消或超限时终止。全进程执行器并发最多 2。Wasm 限制 200 万 fuel、16 MiB 线性内存、256 KB 产物。源码仍受前置 32 KB 限制。临时目录权限 0700、文件 0600，结束后清除。主机编译器依旧是原生进程，不能把时间/输入限制描述成完整操作系统沙箱或主机内存限额。

目前 Windows 没有接入 Job Object 进程树回收，因此显式返回不可用，不启动编译器。已实际测试的平台只有 macOS arm64。其它平台不可据此标记已通过。

## 判断与证据

CRC 有 193 个固定测试，换算有 3 个。仅出现一个已实现函数时只运行该函数对应集合，不把缺失函数算作通过。测试不证明算法对所有输入正确，也不证明传感器接线或固件运行。

结果绑定完整缓冲区 SHA256、当前工程和文件，保留 60 秒供模型上下文引用。修改源码、切换工程、过期均不会提供旧执行结论。执行失败或不可用时，动态教学不自动推进；成功也只是受控函数测试证据，后续编译/下载/运行仍要独立验证。不会在每次按键时启动编译器。

## 本地工具配置与复跑

工具目录结构为 `sdk/bin/clang`（保留 SDK 自身目录结构）及 `runtime/wasmtime`。默认读取扩展资源 `resources/wasi/<platform>-<arch>`，开发环境可显式指定 `NODU_TUTOR_WASI_DIR`。不从 PATH 猜测任意版本，不自动联网下载。

本次使用此前 M0 按官方 SHA256 下载的本机缓存，以 Git 外的 `~/.codex/nodu-nightly-20261024/wasi-kit` 两个目录链接引用，未复制大体积依赖、未发布安装包。应用分发侧的工具安装、摘要校验、许可随包和其它平台集成仍待完成；没有工具时界面如实显示不可用。

```sh
NODU_TUTOR_WASI_DIR=/absolute/path/to/wasi-kit npm run test:tutor-wasi --prefix desktop/scope-extension
npm run test:tutor --prefix desktop/scope-extension
```

产品测试覆盖参考代码 196/196、错误 CRC 多项式 35/196、无限循环 fuel 耗尽、越界内存 trap、缺少常量、畸形产物、外部 import、取消、超时、输出超限、并发额度和释放、过期证据。首次替换本机检查器二进制后出现一次冷启动超时，正确返回 unavailable，未被当作通过；同一二进制再次运行全部完成，两个结果均保存。

参考：[Wasmtime CLI](https://docs.wasmtime.dev/cli-options.html)、[WASI SDK 官方版本](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34)。CLI 的 invoke 文本输出不是稳定公共协议，因此固定版本且严格解析单一整数，格式改变即不可用。
