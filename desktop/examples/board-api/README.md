# board-api · nodu_board.py

一个只读的板端声明查询模块（MaixPy / K210）。它通过 `Maix.config` 读取
`/flash/config.json` 里的 `type`、`config_name`、`board_info` 与
`sensor` / `lcd` / `sdcard` 段落，把逻辑别名解析为芯片 IO 号。

```python
import nodu_board
nodu_board.info()                 # {'type': 'embedfire', 'config_name': 'embedfire-k210', ...}
nodu_board.pins()                 # {'USER_LED': 17, 'BOOT_KEY': 16}
nodu_board.pin('LED')             # 依次尝试 USER_LED、LED_R
nodu_board.pin('BUTTON')          # BOOT_KEY
nodu_board.peripheral('sensor')   # 板端声明的 sensor 段（返回拷贝）
```

## 部署

没有自动安装：用应用内的"板端文件"把 `nodu_board.py` 写入 `/flash/` 即可，
`import nodu_board` 立即可用。导入本身不读写 GPIO，不调用 `fm.register`，
不复位设备，不写配置。

## 边界

- 返回值是芯片 IO 号（0–47），不是 GPIO/GPIOHS 通道号；实际驱动仍需在自己的
  代码里显式调用 `Maix.GPIO` / `fm`。
- 声明不保证极性（例如 LED 高低电平点亮）或对应外设驱动已加载。
- `config.json` 是磁盘文件；固件运行中缓存的配置可能与之不同，重启后才重新
  读取。
- 未声明的别名抛出 `ValueError`，没有默认引脚（不回退 BOOT_KEY=16 之类的猜测）。
- 运行本项目测试：`cd desktop && python3 -m unittest discover -s examples/board-api -p 'test_*.py'`。
