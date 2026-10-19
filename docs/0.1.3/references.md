# 0.1.3 参考源码清单

克隆到 `/Users/wangwei/Model/nodu-refs/`（仓库外，只读），由 `tools/refs/fetch-refs.sh` 可复现拉取。移植代码必须遵守下表“可取 / 禁止”约束。

| 仓库 | 锁定提交 | 许可证 | 可取内容 | 禁止 |
| --- | --- | --- | --- | --- |
| openmv/qt-creator | `af179e44cddf396a5ab618792d71e9de5cc67032` | 插件 MIT（`src/plugins/openmv/OpenMV.json.in`，(C) 2016 OpenMV, LLC）；仓库其余部分按 Qt Creator 许可证 | `src/plugins/openmv` 下的串口连接流程（`openmvpluginio.cpp`、`openmvpluginserialport.cpp`）、终端/帧缓冲行为参考；`tools/tag*.c` 的 AprilTag 码族数据（BSD-2，University of Michigan） | `tools/qcustomplot`（GPL-3.0，不移植）；仓库其余 Qt Creator 本体代码（GPL/commercial）；分支 `openmv-qtc-14.0.2` / `openmv-qtc-20.0.2` 及更新——带非商用条款，**一律禁用** |
| sipeed/MaixPy-v1 | `d8901fd2272f000226f1c1037c1eb7c412b88e66` | MIT / Apache-2.0（`LICENSE.md`） | 稀疏拉取路径：`components/micropython/port/src/omv`（含 `ide_dbg.c` / `include/ide_dbg.h`，IDE 二进制协议固件端）、`components/micropython/port/builtin_py`、`components/micropython/port/src/standard_lib/machine`、`components/boards`、`projects/maixpy_k210`；相机与固件行为参考 | 无额外限制（保留版权声明） |
| sipeed/kflash.py | `550828c768b16ef329695d3f5eace3f6bcf14af2` | MIT | kflash 烧写协议、ISP 握手、Flash 参数 | 无额外限制（保留版权声明） |
| sipeed/MaixPy-v1_scripts | `8d7c5f98ba654d226f433d31718d852674cab08d` | MIT | MaixPy IDE 配套脚本、示例 | 无额外限制（保留版权声明） |
| micropython/mpremote | `1.25.0`（pip 包，`~/.nodu/python/lib/python3.15/site-packages/mpremote/`，本地现有 MIT 实现复用，非 nodu-refs 克隆） | MIT | raw REPL 线协议（`transport_serial.py`：`read_until`、`exec_raw_no_follow`、`enter_raw_repl`、`follow`、`exec_raw`） | 无额外限制（保留 MicroPython 版权声明） |
| MaixPy_Doc_Zh_Cn_Backup | `2734af3bcf182e3359cde4ed5a3a5d7d9b75aaf1` | **无 LICENSE 文件** | 仅作文档阅读参考 | 未澄清许可证前**不得复制内容进代码或文档** |

## 移植文件头约定

任何从上述仓库移植/改写的文件，头部必须同时写两行：

```
// Ported from <repo>@<commit>:<path> (<license>)
// Source: <repo> <commit> <path>
```

移植自本仓库既有文件（如 Python worker）时同样写 `Source:` 行，仓库名用 `k210-studio`，提交用移植基线的 git sha（当前为 `dc0aba3`）。

`check-licenses`（`desktop/scripts/check-licenses.cjs`）会校验：含 `Ported from` 头的 `.rs`/`.ts` 文件必须有 `Source:` 行且含仓库名、提交哈希与路径；同时拒绝 desktop/ 下任何 tracked 或未忽略的新文件中出现 `personal benefit` / `monetary gain` 字样（非商用条款指纹；检查脚本自身因含检测签名而豁免该项）。
