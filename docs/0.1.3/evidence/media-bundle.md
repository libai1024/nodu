# 证据：LGPL-only FFmpeg 媒体工具打包（darwin-arm64 主机构建）

日期：2026-10-19。本档只记录 `build:media` 打包步骤的执行结果；**不含任何媒体 UI**，不代表发布级许可证审查/签名/公证完成。

## 来源与构建配方

- 脚本：`desktop/scripts/build-media.cjs`（新增），`npm run build:media`；普通 `compile` 不触发。
- 平台门禁：非 darwin 直接报错退出（Windows/Linux 打包未实现）。
- 源包：`https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz`，SHA256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`（下载 12,040,788 字节，哈希校验通过后解包；缓存复用已校验归档）。仅允许 HTTPS 重定向（≤5 跳，重定向响应体立即 abort），`AbortSignal.timeout(120000)`，下载上限 64 MiB；tar 条目预检要求**每一条**都位于 `ffmpeg-9.0.2/` 顶层且不含绝对路径/`..`（实际 10,525 条全部合规）。
- 构建指纹（`.nodu-configure-marker`）= 源 SHA256 + arch + `MACOSX_DEPLOYMENT_TARGET` + sdl2-compat/sdl3 的 INSTALL_RECEIPT 名称版本 + configure flags；不一致即 `make clean` 后重配重编（实测复跑因旧 marker 命中而跳过重编、沿用 minos 26.0 旧产物——现已在 marker 不一致时强制 clean）。
- 缓存：`desktop/.tools/media/`（`.tools/` 已 gitignore）。
- configure（实机 `-buildconf` 回读确认逐字一致）：
  `--disable-autodetect --disable-gpl --disable-nonfree --disable-version3 --disable-doc --disable-debug --disable-network --enable-ffplay --enable-sdl2 --enable-pthreads --enable-small --enable-static --disable-shared --cc=clang`
- `make -j8`（按宿主 CPU 上限 8）。Apple clang 21.0.0；宿主 macOS 26.3.2（Darwin 25.3.0）arm64。
- 未启用任何外部编解码器/GPL 组件；`--disable-network` 后 lavfi 等内部源仍可用。

## SDL2：改为上游源码构建（弃用 Homebrew bottle）

Homebrew `sdl2-compat`/`sdl3` bottle 的 `minos=26.0` 使包无法宣称 macOS 15 兼容，且 SDL3 为运行期 `dlopen` 隐性依赖。本次改为固定源包构建真实 SDL2：

- 源包：`https://github.com/libsdl-org/SDL/releases/download/release-2.32.10/SDL2-2.32.10.tar.gz`，SHA256 `5f5993c530f084535c65a6879e9b26ad441169b3e25d789d83287040a9ca5165`，同样的有界 HTTPS 下载/SHA 预检/tar 条目根目录 `SDL2-2.32.10/` 校验（实际条目全部合规）。SDL2 许可证为 zlib（`LICENSE.txt` 已随包）。
- 构建：缓存内私有前缀 `.tools/media/sdl2-install`；configure `--enable-shared --disable-static --disable-video-x11 --disable-video-wayland --disable-pulseaudio --disable-alsa --disable-jack --disable-libsamplerate`；env `MACOSX_DEPLOYMENT_TARGET=15.0 CFLAGS=-mmacosx-version-min=15.0 LDFLAGS=-mmacosx-version-min=15.0`；`make -j8 && make install`。SDL 构建 marker = 源 SHA+arch+target+flags。
- FFmpeg configure 经由 `PATH`/`SDL2_CONFIG` 指向 `sdl2-install/bin/sdl2-config`；FFmpeg marker 同时钉住两份源 SHA、arch、目标版本、两套 flags。
- 依赖白名单改为：系统库 + **仅 SDL2 install 前缀**（`@rpath/` 依赖叶名须在该前缀内解析），其它绝对路径即拒绝打包；dlopen/SDL3 处理与 strings 扫描已删除（真实 SDL2 无此隐性依赖）。
- 暂存全部经 临时文件+rename（新 inode）落位，规避 macOS provenance 失效问题；旧包产物 `libSDL3.dylib` 在 staging 时显式删除，`libSDL2-2.0.0.dylib` 由新 SDL2 覆盖。
- licenses 目录同步：SDL2 源包 + `sdl2-LICENSE.txt` + `build-media.cjs` 本体 + 配方 + metadata；旧 `sdl2-compat-LICENSE.txt`/`sdl3-LICENSE.txt` 已删除，清单与产物一致。

## 打包包内容（`scope-extension/resources/bin/darwin-arm64/`，gitignored）

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `ffmpeg` | 14,074,240 | sha256 `bd6775ce…` |
| `ffprobe` | 13,916,240 | sha256 `63539aeb…` |
| `ffplay` | 13,868,640 | sha256 `3f62192f…` |
| `libSDL2-2.0.0.dylib` | （自 SDL2-2.32.10 源码构建） | 真实 SDL2，zlib 许可 |

- `ffmpeg`/`ffprobe` 只依赖系统库；`ffplay` 额外引用 `@loader_path/libSDL2-2.0.0.dylib`。
- 最低系统版本（`xcrun vtool -show-build` 实测）：**ffmpeg/ffprobe/ffplay/libSDL2-2.0.0.dylib 全部 `minos=15.0`**（FFmpeg 经 `MACOSX_DEPLOYMENT_TARGET`，SDL2 另加 `CFLAGS/LDFLAGS=-mmacosx-version-min=15.0`）；脚本对全部暂存件硬性 gate `minos<=15.0`，未知或超出即 fail。macOS 15 真机运行尚未验证。
- 历史坑位记录：此前 sdl2-compat 会运行期 `dlopen` SDL3（`otool -L` 不可见），缺失时 `ffplay -version` 弹 AppKit 模态框挂死；改为源码构建真实 SDL2 后该隐性依赖不复存在，30s 验证超时兜底保留。
- 依赖重写：所有 `/opt/homebrew/…` 依赖经 `install_name_tool -change` 改为 `@loader_path/<basename>`，dylib id 同步重写；仅允许 `/opt/homebrew/` 前缀，出现其它绝对路径即 fail；basename 冲突预检。重写后 `codesign -s - -f` **ad-hoc 重签**（无发布签名/公证）。
- 递归 `otool -L` 复核：暂存文件全部依赖仅剩 `@loader_path/` 与 `/usr/lib`/`/System/`。

## 验证结果（全部实跑）

- `ffmpeg/ffprobe/ffplay -version`、`-buildconf`、`-L` 通过；`-buildconf` 配置行逐字等于上方配方；输出不含 `--enable-gpl`/`--enable-nonfree`/`--enable-version3`（脚本命中即 fail）；`-L` 自述 "GNU Lesser General Public License … version 2.1"。
- 离线冒烟（无硬件）：`ffmpeg -f lavfi -i color=c=red:size=64x48:rate=10 -t 1 -c:v mpeg4` 生成 1,146 字节 MP4；`ffprobe -show_streams` 确认 `mpeg4 64x48` 视频流；`SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy ffplay -autoexit` **干净退出**（dummy 驱动可用，未落到"不支持"分支）。
- 复跑幂等：二次执行复用已校验归档/解包树/构建树（configure marker 命中），直接重走 staging+验证+冒烟。
- 完整记录：`resources/licenses/ffmpeg/metadata.json`（版本/源 SHA/configure flags/平台/可执行与 dylib SHA/冒烟结果/时间戳）。

## 随包合规文件（`scope-extension/resources/licenses/ffmpeg/`）

`ffmpeg-9.0.2.tar.xz` 与 `SDL2-2.32.10.tar.gz`（精确源包，可复现构建）、`BUILD-RECIPE.txt`（配方）、`build-media.cjs`（构建脚本本体）、`ffmpeg-COPYING.LGPLv2.1.txt`、`sdl2-LICENSE.txt`、`metadata.json`。源包+配方随包**供审查**，是否已满足完整的对应源码义务需发布前法律确认。

## 限制与待办

- 仅 darwin-arm64；Windows/Linux 打包未实现（脚本会解释性拒绝）。
- ad-hoc 签名仅保证本机可运行；发布签名、公证、完整依赖许可证清单仍是发布时事项。
- LGPL 合规口径：动态链接 + 随包精确源代码与配方满足 2.1 节对应源码义务的技术层面；法律审查不在本档范围。
- minOS 口径：全部暂存件钉 15.0 并通过硬 gate；macOS 15 真机兼容与通用性未做机器验证。
- `nodu-device` 同目录共存，互不干扰。
