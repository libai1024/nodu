# Bounded sidecars
- worker: Goal实现持久Python设备worker；Scope resources/nodu_device_worker.py与test/worker*；Excluded源码UI/Node glue、刷固件/用户文件/凭据；Output worker协议与测试；Verify Python测试并交由root实机。
- frontend: Goal共享设备模型与双模式接入；Scope browser/device*、scope-widgets.tsx/workbench.tsx与style/device.css；Excluded common/Node/resources与dirty窗口；Output patch；Verify compile，root集成验收。
- research: Goal固定协议与依赖许可、能力矩阵；Scope docs/device-reuse.md；Excluded实现与设备串口；Output许可版本/命令清单；Verify primary源码文件头与文档。

## 2026-10-19 continuation
- vision-tools: Goal对真实JPEG帧实现ROI、像素、直方图、LAB阈值预览与复制、缩放与导出；Scope新browser/nodu-image*、scope-widgets.tsx与新style/image-tools.css、相关离线算法测试；Excluded Node/worker、串口、原始dirty窗口、用户源码修改；Output前端组件与明确JPEG/PC近似边界；Verify compile、固定颜色与ROI测试，root原生UI验收。
- documentation: Goal同步真实能力矩阵；Scope docs/feature-baseline.md、PRODUCT.md、desktop/README.md、docs/device-reuse.md；Excluded代码、spec验收勾选、串口；Output按App/服务/CLI/旧IDE区分的状态，保留缺项；Verify逐条核本地证据与root提供的原生验收结果。
- capacity-research: Goal复核现有官方工具/固件公开接口与合法无写容量查询；Scope docs/device-capacity-status.md；Excluded串口、vendor、探针二进制、启动/用户数据、其他代码；Output明确可行接口或阻塞证据；Verify固定源码与官方资料，不推测容量。

## 自动 Flash 识别接续（2026-10-19）
- official-isp-audit: Goal核验官方未改RAM ISP是否支持实际ID/SFDP查询；Scope docs/automatic-flash-source-audit.md及私有临时源码缓存；Excluded硬件访问、执行预编译loader、产品代码与用户文件；Output固定提交、逐文件许可、构建链、协议和副作用；Verify原始源码与依赖交叉检查。由device_sources及其许可子代理负责。
- current-firmware-id-audit: Goal独立核实当前固定MaixPy公开接口能否无重启读取ID；Scope docs/current-firmware-id-audit.md及临时源码缓存；Excluded串口、寄存器访问、猜测地址、其他文件修改；Output实际导出及调用链证据；Verify固定源码和文件许可。由firmware_id_audit负责。
- integration: root独占串口和实现决策。先将拟用工具的固定来源、精确命令、RAM布局、Flash副作用与可验证读取边界记为审查材料，再决定实现。现有容量/备份门禁不因研究完成而自动解除；未审计二进制不得执行。原dirty窗口、板端启动和用户文件保持不动。
- source-build-candidate: firmware_id_audit独占tools/flash-probe/，基于固定官方SDK建立显式源文件清单和离线构建。沿用已有D2/D7/DE通信格式，SLIP不复制GPL实现，不包括Flash写入/擦除/状态写/任意地址执行命令。Excluded串口、resources运行时加载路径、UI与用户文件；Verify输入hash/许可、链接map/反汇编、未知命令拒绝与候选二进制hash；未真机运行。
- host-protocol: root拥有resources/nodu_flash_protocol.py与test/worker_flash_protocol_test.py，建立有界SLIP/CRC/ID白名单离线校验。Excluded新硬件访问与门禁解除；Verify坏帧/CRC/长度/未知ID/容量不匹配拒绝，明确合成fixture不是设备证据。
