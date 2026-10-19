# 验收清单
- [x] 基线源码快照SHA重验与清单可用，preview仓库未改。
- [x] 新设备服务可连接并识别固件，物理板型独立，原生App验收。
- [x] REPL及当前脚本运行/停止，原生日志含真实输出。
- [x] 隔离临时文件原生上传下载4124B字节/SHA一致，启动与用户文件未覆盖。
- [x] 原生相机预览来自正常320x240真实JPEG帧。
- [x] 串口单owner、重复操作/STOP/取消/断开重连测试通过。
- [x] 两布局会话与dirty buffer保持；browser/Electron构建0errors和原生UI完成。
- [x] 功能矩阵/许可/环境安装说明有真实依据；Windows边界如实记录；独立UI复核ship、文档与设计一致性检查完成。
- [ ] 当前完整设备备份verified，恢复包可解析，官方image SHA与写范围核实。
- [ ] App固件烧写入口实测、真实进度、写后读验和相机/文件/运行回归。
- [x] 真实帧ROI/像素/直方图/PC近似LAB/参数复制/缩放/原图导出原生验收，JPEG SHA与板端缓存一致。

**验收结果**：阶段验收已完成；整体未通过，完整备份/实际烧写由容量认证阻塞，未执行实写。

## 验收证据
- 外部对标：固定MaixPy0.2.5菜单与d8901fd22协议逐项列在docs/feature-baseline.md，不以菜单或旧CLI结果冒充App能力。
- 脚本验证：npm run compile退出0；node --test后端与图像14/14通过；Python worker unittest33/33通过；browser与electron各Theia build均0errors。
- 旧新对比：从合成设计预览到原生App连接/dirty RAM loop/STOP/文件往返/正常JPEG和真实图像分析；旧暗帧与二进制误报证据保留，新正常结果见verification.md。
- 差异边界：低速rawREPL快照在脚本运行时暂停；JPEG/PC LAB近似不保证板端逐值一致；Windows/更多板型/完整备份与实写未验证。
- 行为成效：4124B UI往返SHA f019cbe2e09ff7d9fa2f4f4cfedb129bbd67cf1a26c8dd870dbeea3eb1571002；JPEG3397B UI导出与板端SHA57f63451654ebc4d5a32758089744dae78b68f160559f213d1105d7975d12db4一致；详见.impeccable/review/device-service/verification.md与原生截图。

## 自动识别接续阶段
- [x] 固定官方接口/ISP源码审计；源码构建候选8672B/314f29…b113d冻结，重复构建与最终同指纹独立复核。
- [x] 当前codec/ROM ACK规则、候选加载器、保全/恢复逻辑独立审查；Python52/52、Node14/14通过，TypeScript编译通过。原UI未改，不重复UI detector或无关构建。
- [x] 普通REPL保全21文件/16,812,721B、原boot/2,116,325B和16MiB未认证prefix；设备/主机/本地摘要及最后文件/目录稳定检查通过；串口归还，原dirty缓冲区未操作。
- [x] 来源/逐文件许可、工具链/闭包、最终BIN/布局、允许命令、失败/恢复及原程序终止风险写入docs/flash-probe-execution-plan.md。
- [ ] 当前JEDEC真机采集、容量认证、App完整备份/恢复包和实际烧写验收仍待后续阶段。第五次现役dcc候选已执行，首个DE返回2B DE/E7，联合白名单拒绝且未取得实际ID；容量门禁保持关闭。REPL恢复后21/21文件、目录、boot和未认证prefix串行摘要一致，串口归还；现役probe错误分支自动复核缺口本次由手工检查补全。证据见artifacts/flash-probe/20261019/app-execution/fifth-attempt.json，不用16MiB保全范围或历史ID放行。
