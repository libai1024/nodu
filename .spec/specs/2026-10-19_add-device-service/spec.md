# Nodu K210 real device workflow - 项目范围
## 1. 问题定义
- **项目目标**：在现有Theia双模式完成K210连接、固件信息、REPL、运行停止、文件与真实图像工具闭环。
- **目标用户**：嵌入式初学者。
- **核心价值**：从编辑器直接运行到板并看到输出与真实图像，简洁/专业共享状态。
## 2. 假设与待确认
### 2.1 已确认事实
- Nodu蓝色与双布局可用；mpremote/pyserial已有固定版本环境；MaixPy0.6.3普通raw REPL、真实脚本/文件/JPEG已完成本机与原生App验收。
- 当前物理野火CAM/GC2145与固件Sipeed_M1架构字段分开；旧黑帧由倒扣导致，正常取景已复查，不修改驱动。
### 2.2 关键假设
- 不同板型/Windows仍需专项验收，不由本机一个组合推断支持；当前只对所选K210组合作声明。
- 历史EF/17日志支持Winbond128Mbit家族，但不等于当前连接已完成容量认证。
### 2.3 待确认问题
- 无待确认问题。
## 3. 功能范围
- 核心功能：端口列表、连接/断开、固件信息、REPL、RAM脚本运行/停止、目录/读取/写入、真实相机帧、日志。
- 已纳入：真实帧ROI、像素、RGB/灰度直方图、PC LAB近似阈值预览/复制、缩放与PNG/JPEG原图导出。
### 3.3 不在范围内
- 全片擦除、修改启动文件、删除板端用户文件、未审计或来源不明的探针、容量未认证的实写、STM32/ESP编译器接入、发布安装器。
## 4. 最小实现路径
- Python持久worker复用已安装mpremote与pyserial；Node后端RPC单例；同一frontend模型跨双布局共享。
- 不复制Qt插件；不重写编辑器或串口驱动；不引入账户服务。
- 真实帧工具使用原生Canvas与MIT color-convert；参数仅复制，不自动编辑源码；JPEG导出保留实际字节。
## 5. 技术决策
- 技术栈：Theia1.76/TypeScript/Python3/mpremote/pyserial。
- 允许改动：desktop扩展、明确许可资源、测试、相关文档。
- 不应触碰：用户dirty buffers、preview仓库、板端启动文件与固件。
- Git integration branch：main（用户于2026-10-19明确要求0.1.1交接与Git管理，建立根目录开发基线）；原项目外tar快照与SHA256保留，固件任务仍未完成。
### 5.4 编排策略
- route: build
- ownership: 主线程拥有common协议、Node/RPC、集成与验收；worker lane仅resources/tests；UI lane仅browser UI；research lane仅docs。
- waiting strategy: UI与worker围绕固定common协议并行，集成前核验交接。
- verification gate: 单元测试、编译构建、隔离板端文件与原生/浏览器UI验收。
- 新增用户授权（2026-10-19）：纳入真机烧写。必须先完整备份、官方固定image/hash和覆盖范围、App入口与进度、写后回归；不能以CLI测试替代App验收。
- 自动识别接续：先审现有固件公开ID接口及官方未改ISP；两条现成路径无可核实入口后，允许离线评估从固定官方SDK源码构建的最小RAM只读适配。不得直接执行社区blob；须先完成逐文件来源/许可、明确读取协议、RAM布局、链接闭包与副作用审查，再公布具体硬件执行计划。离线构建不代表真机验证，容量门禁保持关闭。
## 6. 成功标准与验证方式
- 真实连接信息、print/停止、文件字节往返、JPEG帧验证；错误/重复/取消/重连验证；现有编辑缓冲区保留。
## 7. 风险与约束
- 单串口只能一个owner，跨进程独占锁；不自动刷写；传输限额与超时；命令串行与STOP优先；输出不可信内容按文字显示。
