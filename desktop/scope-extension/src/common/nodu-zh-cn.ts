// SPDX-License-Identifier: MIT
// English default values used by stock Theia/Monaco strings → Simplified Chinese.
// Consumed in two ways:
//  - frontend preload (TextReplacementContribution): keys are matched against the
//    `defaultValue` argument of every nls.localize / localizeByDefault call, so the
//    keys below must be the exact English defaults rendered in the UI.
//  - backend (LocalizationContribution): each key is resolved to its vscode nls key
//    via nls.getDefaultKey() so a real zh-cn language pack is registered as well.
// Keys are validated against the compiled Theia libs in test/backend-validation.cjs.

export const NODU_ZH_CN: Record<string, string> = {
    'recently opened': '最近打开',
    'file results': '文件',
    // ---- menubar ----
    'File': '文件',
    'Edit': '编辑',
    'Selection': '选择',
    'View': '查看',
    'Go': '转到',
    'Terminal': '终端',
    'Help': '帮助',

    // ---- File menu ----
    'New Text File': '新建文本文件',
    'New File...': '新建空白文件...',
    'New Folder...': '新建文件夹...',
    'New Window': '新建窗口',
    'Open...': '打开文件...',
    'Open File': '打开文件',
    'Open Folder': '打开文件夹',
    'Open Workspace from File...': '从文件打开工作区...',
    'Open Workspace from File': '从文件打开工作区',
    'Open Recent Workspace...': '打开最近的工作区...',
    'Add Folder to Workspace...': '将文件夹添加到工作区...',
    'Save Workspace As...': '工作区另存为...',
    'Save': '保存',
    'Save All': '全部保存',
    'Save As...': '另存为...',
    'Auto Save': '自动保存',
    'Upload Files...': '上传文件...',
    'Preferences': '首选项',
    'Close Editor': '关闭',
    'Close Workspace': '关闭工作区',

    // ---- Preferences submenu ----
    'Settings': '设置',
    'Keyboard Shortcuts': '键盘快捷方式',
    'Color Theme': '颜色主题',
    'File Icon Theme': '文件图标主题',

    // ---- Edit menu ----
    'Undo': '撤销',
    'Redo': '重做',
    'Cut': '剪切',
    'Copy': '复制',
    'Paste': '粘贴',
    'Copy Path': '复制路径',
    'Select All': '全选',
    'Replace in Files': '在文件中替换',

    // ---- Selection menu ----
    'Expand Selection': '扩大选择范围',
    'Shrink Selection': '缩小选择范围',
    'Copy Line Up': '向上复制行',
    'Copy Line Down': '向下复制行',
    'Move Line Up': '向上移动行',
    'Move Line Down': '向下移动行',
    'Duplicate Selection': '复制选定内容',
    'Add Cursor Above': '在上方添加光标',
    'Add Cursor Below': '在下方添加光标',
    'Add Cursors to Line Ends': '在行尾添加光标',
    'Add Next Occurrence': '添加下一个匹配项',
    'Add Previous Occurrence': '添加上一个匹配项',
    'Select All Occurrences': '选择所有匹配项',

    // ---- View menu ----
    'Command Palette...': '命令面板...',
    'Open View...': '打开视图...',
    'Appearance': '外观',
    'Toggle Maximized': '切换最大化',
    'Toggle Menu Bar': '切换菜单栏',
    'Toggle Bottom Panel': '切换底部面板',
    'Toggle Status Bar Visibility': '切换状态栏可见性',
    'Collapse All Side Panels': '折叠所有侧面板',
    'Collapse Side Panel': '折叠侧面板',
    'Editor Layout': '编辑器布局',
    'Split Editor Right': '向右拆分编辑器',
    'Split Editor Left': '向左拆分编辑器',
    'Split Editor Up': '向上拆分编辑器',
    'Split Editor Down': '向下拆分编辑器',
    'Split Editor Horizontal': '水平拆分编辑器',
    'Split Editor Vertical': '垂直拆分编辑器',
    'Explorer': '资源管理器',
    'Outline': '大纲',
    'Output': '输出',
    'Problems': '问题',
    'Search': '搜索',
    'View: Toggle Word Wrap': '查看：切换自动换行',
    'Toggle Minimap': '切换缩略图',
    'Toggle Breadcrumbs': '切换面包屑导航',
    'Toggle Render Whitespace': '切换呈现空格',
    'Toggle Sticky Scroll': '切换粘性滚动',

    // ---- Go menu ----
    'Go Back': '后退',
    'Go Forward': '前进',
    'Last Edit Location': '上一处编辑位置',
    'Switch Group': '切换组',
    'Group 1': '组 1',
    'Group 2': '组 2',
    'Group 3': '组 3',
    'Group 4': '组 4',
    'Group 5': '组 5',
    'Next Group': '下一组',
    'Previous Group': '上一组',
    'Go to File...': '转到文件...',
    'Go to Symbol in Workspace...': '转到工作区中的符号...',
    'Go to Symbol in Editor...': '转到编辑器中的符号...',
    'Go to Definition': '转到定义',
    'Go to Declaration': '转到声明',
    'Go to Type Definition': '转到类型定义',
    'Go to Implementations': '转到实现',
    'Go to References': '转到引用',
    'Go to Line/Column...': '转到行/列...',
    'Go to Bracket': '转到括号',
    'Next Problem': '下一个问题',
    'Previous Problem': '上一个问题',

    // ---- Terminal menu ----
    'New Terminal': '新建终端',
    'New Terminal (With Profile)...': '新建终端(使用配置文件)...',
    'Choose Default Profile...': '选择默认配置文件...',

    // ---- tab context menu ----
    'Close': '关闭',
    'Close Others': '关闭其他',
    'Close to the Right': '关闭右侧标签页',
    'Close Saved': '关闭已保存',
    'Close All': '全部关闭',
    'Pin': '固定',
    'Unpin': '取消固定',
    'Split Up': '向上拆分',
    'Split Down': '向下拆分',
    'Split Left': '向左拆分',
    'Split Right': '向右拆分',

    // ---- editor context menu (Theia + Monaco builtins) ----
    'Peek': '速览',
    'Peek Definition': '速览定义',
    'Peek Declaration': '速览声明',
    'Peek Type Definition': '速览类型定义',
    'Peek Implementations': '速览实现',
    'Peek References': '速览引用',
    'Rename Symbol': '重命名符号',
    'Change All Occurrences': '更改所有匹配项',
    'Format Document': '格式化文档',
    'Format Selection': '格式化选定内容',

    // ---- Output / console context menu ----
    'Copy All': '全部复制',
    'Clear Output': '清除输出',
    'Clear Console': '清除控制台',

    // ---- dialogs ----
    'Do you want to save the changes you made to {0}?': '是否保存对 {0} 所做的更改？',
    'Do you want to save the changes to the following {0} files?': '是否保存对以下 {0} 个文件所做的更改？',
    "Don't Save": '不保存',
    'Cancel': '取消',

    // ---- status bar / misc ----
    'Ln {0}, Col {1}': '行 {0}，列 {1}',
    'Spaces: {0}': '空格：{0}',
    'Open Editors': '打开的编辑器',
    'Replace': '替换',
    'Find': '查找',
    'Follow link': '跟踪链接',
    'Collapse All': '全部折叠',
    'Restart': '重启',

    // ---- quick pickers / search panel ----
    'Select Color Theme': '选择颜色主题',
    'Select File Icon Theme': '选择文件图标主题',
    'Select File Type or Enter File Name...': '选择文件类型或输入文件名...',
    'Create New File ({0})': '新建文件({0})',
    'files to include': '要包含的文件',
    'files to exclude': '要排除的文件',
    'e.g. *.ts, src/**/include': '例如 *.ts、src/**/include',
    'e.g. *.ts, src/**/exclude': '例如 *.ts、src/**/exclude',
    'dark themes': '深色主题',
    'light themes': '浅色主题',
    'high contrast themes': '高对比度主题',
    'You have not yet added a folder to the workspace.\n{0}': '尚未将文件夹添加到工作区。\n{0}',
    'No Problems': '无问题',
    'More Actions...': '更多操作...',
    'No Notifications': '无通知',
    'Turn Auto Scrolling Off': '关闭自动滚动',
    'Turn Auto Scrolling On': '打开自动滚动',
    'Editor content': '编辑器内容',
    'Select End of Line Sequence': '选择行尾序列',
    'Select Language Mode': '选择语言模式',
    'Select Encoding': '选择编码',

    // ---- Electron additions (native menu / window commands) ----
    'Toggle Developer Tools': '切换开发者工具',
    'Reload Window': '重新加载窗口',
    'Zoom In': '放大',
    'Zoom Out': '缩小',
    'Reset Zoom': '重置缩放',
    'Close Window': '关闭窗口',
    'Full Screen': '进入全屏'
};
