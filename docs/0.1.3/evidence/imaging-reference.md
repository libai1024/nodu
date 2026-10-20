# 图像计算参考与数值核对

基线为 `openmv/qt-creator@af179e44cddf396a5ab618792d71e9de5cc67032` 的
`src/plugins/openmv/histogram/` 和 `tools/thresholdeditor.cpp`，不是后续受限分支。

`nodu-imaging` 的输入是解码后的 RGBA 像素。RGB 先用原版的
`rb825_table` / `g826_table` 量化成 RGB565，再按字节反转的索引读取 LAB/YUV。
RGB 直方图分别使用 32、64、32 个区间；灰度为 256 个区间；LAB 的 L
为 101 个区间，A/B 各 256 个区间；YUV 各 256 个区间。

统计遵循原版：均值先按绝对值方向四舍五入；众数并列时选择较小值；
中位数和上下四分位数使用原版的整数次序统计位置；标准差使用已取整的
均值并再次取整。阈值上下界均包含，反向滑块范围按 min/max 解释。

## 已完成的核对

- `python3 tools/refs/import-imaging.py`：从固定 Git 对象提取 12 个数据数组，
  长度与预先固定的 SHA-256 全部通过。构建使用提交的二进制数据，不联网取源。
- `cargo test -p nodu-imaging`：4 个测试通过，覆盖负均值取整、ROI/量化区间、
  包含端点及反向阈值、反选、AprilTag 首个码字方向。
- 在 `desktop/native` 执行：
  `cargo run --quiet -p nodu-imaging --example reference_probe | python3 ../../tools/refs/check-imaging.py`。
  独立 Python 检查器从固定 C 表重新构造确定性像素的参考结果，四种色彩空间、
  十个通道的所有区间计数和八项统计值均一致。
- 完整 LAB/YUV 表与 `MaixPy-v1@d8901fd` 的完整数组分支逐项相同。
  该固件另有条件编译的压缩表实现；尚不能据此断言所有固件配置都逐值相同。

## 适用边界

数值核对验证的是原版 IDE 对同一组解码像素的计算。JPEG 是有损格式，
电脑上的 JPEG 像素与板端原始传感器像素可能不同，因此不能把此结果
描述为“板端原始 LAB 完全一致”。WASM 界面接入、实帧显示与原版同帧对照
仍需另外验收。
