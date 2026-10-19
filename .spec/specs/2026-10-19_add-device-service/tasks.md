# 实施任务
- [x] 1. 保存基线与核查来源
  - id: task-baseline
  - boundary: 外部快照、docs来源与许可
  - verify: 快照SHA256、固定文件头许可核验
- [x] 2. 设备worker与协议
  - id: task-worker
  - boundary: resources/、test/worker*，不触碰用户文件或固件
  - verify: Python测试、真实板连接/运行/停止/文件/帧
- [x] 3. Node RPC与单例
  - id: task-backend
  - boundary: src/common、src/node、package配置
  - verify: TypeScript编译、RPC真实调用与取消/错误测试
- [x] 4. 双模式UI集成
  - id: task-frontend
  - depends-on: task-backend
  - boundary: src/browser、style设备样式
  - verify: 两种布局共享会话，连接/运行/日志/传输/帧UI
- [x] 5. 独立验收与文档
  - id: task-acceptance
  - depends-on: task-worker, task-backend, task-frontend
  - boundary: 测试、docs、验收记录
  - verify: 构建、断开重连/STOP/重复/取消、文件往返、原生UI、功能矩阵

- [ ] 6. App固件备份、烧写与恢复（待当前容量认证和实写验收）
  - id: task-firmware
  - depends-on: task-worker, task-backend, task-frontend
  - boundary: 固定官方image、完整设备备份、同一串口服务与UI；不全片擦除
  - verify: image SHA/写范围、16MiB备份与恢复包、App按钮烧写进度与读后校验、写后设备闭环
  - status: in_progress_native_app；第五次4193原生App完成当前session的21文件、目录、boot及16MiB未认证prefix保全；缓存字节均经当前远端完整SHA重新核验。首个DE明确收到2B DE/E7，联合白名单拒绝，实际ID仍未知；前序成功由严格控制流推知，非逐包抓取。已恢复REPL，以顺序硬件SHA手工复核21/21文件、目录、boot/prefix全一致并归还串口，用户编辑器恢复。未认证容量、未完整备份、未烧写；后续只在隔离目录准备E7诊断候选，不激活或盲重试。现役probe错误分支自动原件复核缺口已记录，本次由手工检查补全。

- [x] 7. 真实帧图像工具
  - id: task-image-tools
  - depends-on: task-frontend
  - boundary: browser/nodu-image*、scope-widgets与图像CSS；参数只复制，不修改用户buffer
  - verify: 8项图像/剪贴板测试、原生ROI/像素/直方图/阈值/复制/缩放/导出；JPEG与板端缓存SHA一致，详见verification.md

- [x] 8. 自动Flash身份读取的源码构建候选与协议校验
  - id: task-flash-probe-audit
  - depends-on: task-baseline
  - boundary: tools/flash-probe/、独立host协议库与离线测试、来源审查文档；暂不加载到硬件
  - verify: 固定源码/逐文件许可、RAM地址、显式构建输入、map/反汇编、CRC/边界/ID白名单失败关闭；离线完成不能代替当前设备ID和完整备份

- [x] 9. 当前状态保全与具体执行计划
  - id: task-probe-state-preservation
  - depends-on: task-flash-probe-audit
  - boundary: 已有普通raw REPL读取用户文件/boot/未认证prefix，私有本地副本、失败记录与下一阶段明确计划；不加载RAM候选、不烧写
  - verify: 所有文件/目录/boot/prefix双侧SHA一致、串口归还、当前副本不冒充完整容量认证；来源/许可/指纹/动作/退出/失败边界写入执行计划

- [x] 10. 默认相机示例与真实初始化适配
  - id: task-camera-example
  - depends-on: task-worker, task-frontend
  - boundary: examples/green-tracker、examples/gc2145-camera；不修改用户启动文件、不在缺helper时隐式回退裸reset
  - verify: 本地语法/项目清单检查、Nodu当前脚本RAM运行30帧、独立相机预览回归；多文件示例仍明确板端模块依赖
  - status: passed_current_board；新增单文件在Nodu原生App按钮RAM运行10/20/30帧320x240后正常返回，相机预览随后收到真实JPEG至205帧；已暂停并断开，截图与日志见artifacts/camera-diagnosis/20261019。绿色追踪整项目仍不冒充已验证。

- [x] 11. 新精简布局与单一入口
  - id: task-minimal-layout
  - depends-on: task-frontend
  - boundary: src/browser与style；不改变设备协议和用户文件
  - verify: 原生文件/控制台/视觉开关、设备浮层、模式切换保留编辑器与连接、正常日志不展开控制台
  - status: passed_native_macos；44px工具栏和单一入口已实现，TypeScript与Electron构建通过；4193原生窗口完成file/console/vision开关、快速连点、设备浮层草稿、未保存内容与光标跨模式保留、REPL快捷键、真实30帧运行和相机预览至36帧。测试编辑已撤销，当前画面冻结。证据见artifacts/ui-minimal/20261019；Windows未实机验证。
