# 0.1.3 遗留事项

真机验证（探针 / 备份 / 同版本烧写 / IDE→raw 批量传输切换）已于
2026-10-20 全部完成，K1.1=pass。下列事项未进入本轮真机范围，按
验收表对应条目排期。

## 1. 媒体打包入标准构建（N1.7 / H1.x，partial）

- `build:electron`（`desktop/package.json:17`）不调用 `build:media`；
  媒体二进制被 git 忽略，干净构建的产物里没有 `ffmpeg`/`ffplay`，
  运行时视频命令报 "bundled tool unavailable"。
- `scripts/build-media.cjs:14` 拒绝非 macOS 主机，且只写
  `resources/bin/darwin-<host arch>`：本机 arm64 构建时
  `darwin-x64` 目录只有两个 native 侧车，无 ffmpeg/ffplay——
  universal 打包缺切片。
- 待办：
  - `build:electron` 链路接入 `build:media`（或与
    `build:native` 并列的可选步骤，CI 显式开启）；
  - x64 媒体切片：Rosetta 下重跑 build-media，或接受
    `--arch` 参数交叉产出 `darwin-x64`；
  - universal 打包脚本把两个切片的 media 二进制一并 lipo/合并；
  - 完成后跑 H1.1/H1.2 冒烟（转换 + 播放）收尾。

## 2. Windows 10 编译与验证（X1.2，todo）

- `nodu-kflash` 两处无条件 `std::os::unix`：
  - `src/firmware.rs:10` — `DirBuilderExt.mode(0o700)`(:67)、
    `OpenOptionsExt.mode(0o600)`(:80)（备份/缓存目录与 manifest
    的权限收紧，Windows 下 NTFS 无 POSIX mode 语义）；
  - `src/kfpkg.rs:10` — `MetadataExt.mode() & 0xFFFF`(:71)
    （kfpkg 打包时记录文件权限位）。
- 修法：`#[cfg(unix)]` 条件导入 + Windows 分支降级（目录默认
  ACL、kfpkg mode 记 0o644/0o755 启发值或 0）。改动小，
  但行为差异要落到 kfpkg fixture 差分测试里。
- 待办：
  - 条件编译后 `cargo check --target x86_64-pc-windows-msvc`
    （交叉 check 即可先过编译关）；
  - Win10 实机：CH340 驱动说明、COM 口 DTR/RTS 时序、
    冒烟 + 真板回归（PLAN 阶段 8，发版阻塞项）；
  - 媒体侧车 Windows 版 ffmpeg/ffplay 来源与签名另计
    （PLAN.md:122）。

## 3. 已知低风险记录（非阻塞，不单独排期）

- 相机冷启动偶发 `OSError: Reset Failed`：固件 `sensor.reset()`
  与板上开机演示的 SCCB 时序竞争，非主机缺陷（证据见
  `realboard-readonly-20261020.md`）。
- `backup.rs` 的 `line_timeout` 常量与泵循环的 20s 停滞超时
  并存——前者死代码，语义已对齐 Python。
- mock board 不支持 `Maix.utils.flash_read`/`uhashlib`，
  `do_backupDevice` 的 worker 级端到端差分暂无桩可跑
  （当前靠真板 + 分段单元测试覆盖）。
