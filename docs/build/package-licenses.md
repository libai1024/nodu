# 安装包许可材料收集

`desktop/scripts/package-licenses.cjs` 在发布应用目录生成 `licenses/INDEX.json`、`licenses/SUMMARY.md` 和按包名、版本、来源位置隔离的原始材料。入口为：

```js
collectPackageLicenses({ desktop, workDesktop, appInput })
```

`desktop` 是本次源码的 desktop 目录，`workDesktop` 是安装固定 lockfile 并完成生产构建的独立工作目录，`appInput` 是待打包应用根目录。默认存在缺项就抛错，并先写出缺项清单。`allowMissing: true` 仅用于审计；不能据此将缺材料的应用标为通过。

## 记录范围

- 从三个工作区的生产依赖开始，递归遍历 dependencies、已安装 optionalDependencies 和 peerDependencies。版本与 package-lock.json 核对，记录 lock 路径和归档 integrity；不把工作区 devDependencies 当作根。
- 可选依赖未安装时明确记录，不当成已随包提供。包含多个版本或相同包的嵌套实例时，材料目录不会互相覆盖。
- 保留包内 LICENSE、COPYING、NOTICE、COPYRIGHT、UNLICENSE、许可目录，以及确实含授权和免责声明的 README。独立提取 IBM Plex 的 FONT-LICENSE.txt。
- 为本项目 Cargo.lock 中的 registry 依赖保存许可材料与归档 SHA-256，范围是锁文件的来源集合，包含构建依赖和非当前平台依赖，并不声称每一个 crate 都链接到安装包。读取缓存源码前核对官方缓存 `.crate` 的摘要。
- 保留本项目所用 Rust 编译器分发中的标准库版权和许可证。
- Electron 自带许可、clangd 插件、STM32 工具包、WASI 和媒体组件沿用各自独立库存及材料，不以 npm 清单替代。

## 固定来源补充

部分 npm 与 crate 发行缺少独立的完整许可文件。补充材料保存在 `desktop/scope-extension/resources/licenses/package-fallbacks/`：

1. 尽可能使用包发行对应的 npm gitHead、Cargo 源码提交，或精确版本标签解析到的不可变提交。
2. 上游仓库同样没有完整文本时，保留其原始 package.json/Cargo.toml、README 或 AUTHORS 声明，再附上固定 SPDX license-list-data 版本的标准文本。该依据在清单中明确标记，不伪造上游自己的 LICENSE 文件，不改写原作者信息。
3. manifest.json 列出适用的精确包名、版本、原始 URL、SHA-256 及补充依据。打包过程中不联网，任何材料摘要变化都会拒绝。

这些文件使分发材料可追溯，不代表已完成所有二进制内嵌组件的法律审计，也不将许可证标识或免责声明误当成法律意见。上游声明缺失、来源不明或没有材料的依赖仍列为缺项。

## Windows 离线构建输入

`resources/licenses/native-dependencies/` 是可移植的固定材料包：覆盖 Cargo.lock 全部 178 个外部 crate 与 Rust 1.98.1 标准库分发通知，共 179 条记录、363 份材料。Windows 打包端无需安装 Rust 或下载 crate，仍执行默认的完整收集门禁。

打包时先核对 Cargo.lock、rust-toolchain.toml 的 SHA-256，再比对完整 crate 名称、版本、来源、归档摘要集合及每份材料的字节数和 SHA-256。任何遗漏、篡改或锁文件变动都会拒绝，不静默降级为跳过 native 许可。

更新 Rust 或 Cargo.lock 后，在已安装对应工具链并拥有已核验 crate 归档的构建机重新采集，再导出：

```js
const { collectPackageLicenses, writeNativeLicenseBundle } = require('./desktop/scripts/package-licenses.cjs');
const result = collectPackageLicenses({ desktop, workDesktop, appInput, nativeBundleRoot: null });
writeNativeLicenseBundle({ desktop, inventoryPath: result.index });
```

导出前校验完整记录和材料，更新后的固定包与锁文件一起提交。它保留原始来源集合；不把本机运行测试等同于所有平台已验证。npm 清单则来自各平台实际安装的依赖。Universal 打包将两份清单及材料分别保留在 `licenses/arm64/` 与 `licenses/x64/`，再让两个薄包携带相同的合集后合并，不能以一方覆盖另一方。

## 检查

```sh
node --test desktop/scripts/package-licenses.test.cjs
```

覆盖生产依赖闭包、peer/optional、嵌套版本、缺材料拒绝、锁文件版本不一致、README 完整文本识别、固定材料被篡改及符号链接越界，以及无 Rust 离线打包、固定 native 材料被篡改、锁文件变化和遗漏条目的拒绝。实际发行还应核对安装包内材料、Electron 许可文件与各工具包清单存在，而非仅检查源码目录。
