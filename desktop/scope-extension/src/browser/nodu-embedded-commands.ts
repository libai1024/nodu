// SPDX-License-Identifier: MIT
/** Command ids of the STM32 C workbench (kept free of imports so the toolbar can use them). */
export const C_COMMANDS = {
    newModule: 'nodu.c.new-module',
    projectSettings: 'nodu.c.project-settings',
    toolkitInfo: 'nodu.c.toolkit-info',
    exportProject: 'nodu.c.export-project',
    build: 'nodu.c.build',
    openBuildLocation: 'nodu.c.open-build-location',
    rebuild: 'nodu.c.rebuild',
    run: 'nodu.c.run',
    flash: 'nodu.c.flash',
    stop: 'nodu.c.stop',
    reset: 'nodu.c.reset',
    identify: 'nodu.c.identify',
    newProject: 'nodu.c.new-project',
    togglePanel: 'nodu.c.toggle-panel',
    showProblems: 'nodu.c.show-problems',
    showMonitor: 'nodu.c.show-monitor',
    showOutput: 'nodu.c.show-output',
    methodStlink: 'nodu.c.method-stlink',
    methodUart: 'nodu.c.method-uart',
    checkToolkit: 'nodu.c.check-toolkit',
    finishBoot: 'nodu.c.finish-boot',
    downloadHelp: 'nodu.c.download-help',
};
/** 运行 ▾ for C projects; K210 keeps NODU_RUN_MENU (board memory / save to board). */
export const NODU_C_RUN_MENU = ['nodu-toolbar-run-c'];
