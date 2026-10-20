// SPDX-License-Identifier: MIT
// Static parity tables for the original MaixPy IDE 0.2.5 工具/窗口/帮助 menus
// (docs/0.1.3/evidence/maixpy-ide-0.2.5-menus.txt). Board ids are the original
// reset-sequence indices (docs/0.1.3/evidence/original-private-params.md §2),
// asserted verbatim by backend-validation.cjs.

export interface ToolsMenuEntry {
    label: string;
    children?: ToolsMenuItem[];
}
export type ToolsMenuItem = ToolsMenuEntry | '-';

export interface BoardMenuEntry {
    /** Verbatim original menu label. */
    label: string;
    /** Original board/reset-sequence id 0–8 (NoduDeviceModel.boardId). */
    boardId: number;
}

/** 选择开发板 items in original display order. */
export const BOARD_MENU: readonly BoardMenuEntry[] = [
    { label: 'Sipeed Maix Dock', boardId: 2 },
    { label: 'Sipeed Maix Bit( with Mic )', boardId: 6 },
    { label: 'Sipeed Maix Bit( old )', boardId: 1 },
    { label: 'Sipeed Maixduino', boardId: 5 },
    { label: 'Sipeed Maix Go( open-ec  new CMSIS_DAP )', boardId: 3 },
    { label: 'Sipeed Maix Go( Old CMSIS-DAP )', boardId: 4 },
    { label: 'M5StickV', boardId: 7 },
    { label: 'T-Watch', boardId: 8 },
    { label: 'Kendryte KD233', boardId: 0 },
];

export interface AprilTagMenuEntry {
    label: string;
    /** TagFamily.id in browser/nodu-apriltag-generator.tsx. */
    family: string;
}

/** AprilTag生成器 family items in original order (original "ARKTOOLKIT" spelling kept). */
export const APRILTAG_MENU: readonly AprilTagMenuEntry[] = [
    { label: 'TAG16H5家族(30标签)', family: 'tag16h5' },
    { label: 'TAG25H7家族(242标签)', family: 'tag25h7' },
    { label: 'TAG25H9家族(35标签)', family: 'tag25h9' },
    { label: 'TAG36H10家族(2320标签)', family: 'tag36h10' },
    { label: 'TAG36H11家族(587标签 - 推荐)', family: 'tag36h11' },
    { label: 'ARKTOOLKIT家族(512标签)', family: 'tag36artoolkit' },
];

/** The original 工具 menu, verbatim. Nodu extras are appended after this. */
export const ORIGINAL_TOOLS_MENU: readonly ToolsMenuItem[] = [
    { label: '选择开发板', children: BOARD_MENU.map(entry => ({ label: entry.label })) },
    '-',
    { label: '将打开的脚本保存到开发板的 boot.py' },
    { label: '发送文件到开发板' },
    '-',
    { label: '打开终端', children: [{ label: '新终端' }] },
    {
        label: '机器视觉',
        children: [
            { label: '阈值编辑器' },
            { label: '关键点编辑器' },
            '-',
            { label: 'AprilTag生成器', children: APRILTAG_MENU.map(entry => ({ label: entry.label })) },
            { label: '二维码生成器' },
            { label: 'DataMatrix码生成器' },
            { label: '条码生成器' },
            '-',
            { label: 'CNN网络库' },
        ],
    },
    { label: '视频工具', children: [{ label: '转换视频文件' }, { label: '播放视频文件' }] },
];

export const ORIGINAL_WINDOW_MENU: readonly ToolsMenuItem[] = [
    { label: '最小化' },
    { label: '缩放' },
    { label: '进入全屏' },
];

export const ORIGINAL_HELP_MENU: readonly ToolsMenuItem[] = [
    { label: 'MaixPy文档' },
    { label: 'MaixPy论坛' },
];

/** Menu paths inside the '5_scope' (工具) top-level menu. */
export const TOOLS_MENU_GROUPS = {
    /** Direct submenu child of 5_scope, sorted before the group ids. */
    boardSubmenu: 'board-select',
    /** Separated group: boot.py / send-file. */
    filesGroup: 'b_file-actions',
    /** Separated group holding the three original tool submenus. */
    toolsGroup: 'c_tool-submenus',
    /** Terminal submenu inside toolsGroup. */
    terminalSubmenu: 'terminal',
    /** Vision submenu inside toolsGroup. */
    visionSubmenu: 'machine-vision',
    /** Video submenu inside toolsGroup. */
    videoSubmenu: 'video-tools',
    /** Separated trailing group for the Nodu extras. */
    noduGroup: 'd_nodu',
} as const;
