# ESP32 Arduino 模拟烧写原始证据归档

这里保存 2026-10-27 的 12 项模拟验收关键材料。原始文件逐字节复制，未改写失败结果或命令参数；[source-manifest.json](source-manifest.json)记录每个副本的原路径、字节数与 SHA-256，[SHA256SUMS](SHA256SUMS)覆盖本目录所有材料（清单自身除外）。

## 结果对应关系

- [summary-original.json](summary-original.json)：C3 四项、S3 四项、预期故障四项，共 12 项通过的原始汇总。
- [initial-c3-and-s3-timeout/result.json](initial-c3-and-s3-timeout/result.json)：首轮 C3 完整通过；S3 两次写入/校验成功后，整片读回遇到测试模拟器寿命不足，故该轮总体 `ok=false`。该失败完整保留。
- [s3-and-failures/result.json](s3-and-failures/result.json)：提高有界模拟器寿命后，仅重跑 S3 及故障场景，总体 `ok=true`。
- [unit-tests-current.log](unit-tests-current.log)：归档时重新执行当前上传专属单测，13/13 通过。原始汇总的 `unit_tests.passed=11` 是历史值，原样保留。

两轮 result 内的命令参数仍指向当时的临时绝对路径。以下文件名与原始 command ID 一致，便于交叉核对：

| 目录 | 文件 | 内容 |
| --- | --- | --- |
| `initial-c3-and-s3-timeout` | `command-2.log`、`command-4.log` | C3 两次逐段摘要校验成功 |
| `initial-c3-and-s3-timeout` | `command-5.log` | C3 独立读取全部 4 MiB |
| `initial-c3-and-s3-timeout` | `command-6.log` | C3 保存后正常启动并输出 Hello |
| `initial-c3-and-s3-timeout` | `command-11.log` | 首轮 S3 整片读回的端点关闭错误 |
| `s3-and-failures` | `command-2.log`、`command-4.log` | S3 两次逐段摘要校验成功 |
| `s3-and-failures` | `command-5.log` | S3 独立读取全部 4 MiB |
| `s3-and-failures` | `command-6.log` | S3 保存后正常启动并输出 Hello |
| `s3-and-failures` | `command-7.log` | 实际错误芯片拒绝，退出码 2 |
| `s3-and-failures` | `command-8.log` | 无监听端点，退出码 2 |
| `s3-and-failures` | `command-9.log` | 真实写入期间取消，对应 result 的 SIGKILL |

损坏镜像在执行器的 validate 阶段被拒绝，进程调用数为 0，因此没有对应 esptool 日志；结果保存在汇总与第二轮 result。模拟器日志一并保存，以核对 ROM 下载模式及保存 Flash 的过程。

## 镜像摘要

镜像文件不纳入仓库。原始独立读回的 4,194,304 字节与保存 Flash 逐字节相同，常规启动后摘要保持不变：

- C3：`d75c70ba6b4b12aaf19b3ca33ca1c821e3680bebd45cf2f5a3625ede8f07ab7f`。
- S3：`bcad73c7e2fa4ed325880af326c7e3da1d54a6d91236b1b82561a652420bfd18`。

没有归档 4 MiB 镜像、重复的写入进度日志，也没有重新执行实体硬件操作。检查归档完整性时，在本目录执行 `shasum -a 256 -c SHA256SUMS`。
