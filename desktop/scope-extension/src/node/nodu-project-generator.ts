// SPDX-License-Identifier: MIT
import { promises as fs } from 'fs';
import { isAbsolute, join } from 'path';
import { ESP32_ARDUINO_CORE_VERSION, ESP32_ARDUINO_INDEX_URL, ESP_PROJECT_FRAMEWORKS, EspProjectFramework, PROJECT_CHIPS, ProjectChip, projectTemplates, validProjectName } from '../common/nodu-project-catalog';
import { ARDUINO_BUNDLED_LIBRARIES } from '../common/nodu-arduino-library-catalog';

export interface ProjectRequest { parent: string; name: string; chip: ProjectChip; template: string; framework?: EspProjectFramework }
export function parseProjectRequest(args: Record<string, unknown>): ProjectRequest {
    const chip = PROJECT_CHIPS.find(item => item.id === args.chip);
    if (!chip) { throw new Error('请选择芯片型号。'); }
    if (typeof args.name !== 'string' || !validProjectName(args.name)) { throw new Error('名称须以字母开头，限 40 位字母、数字、- 或 _，不能使用系统保留名称。'); }
    if (typeof args.parent !== 'string' || !isAbsolute(args.parent) || args.parent.includes('\0')) { throw new Error('请选择有效的项目位置。'); }
    const framework = chip.family === 'esp32' ? args.framework === undefined ? 'arduino' : args.framework : undefined;
    if (framework !== undefined && !ESP_PROJECT_FRAMEWORKS.some(item => item.id === framework)) { throw new Error('请选择有效的 ESP32 开发框架。'); }
    if (chip.family !== 'esp32' && args.framework !== undefined) { throw new Error('该芯片不支持 ESP32 开发框架。'); }
    if (typeof args.template !== 'string' || !projectTemplates(chip.family, chip.id, framework as EspProjectFramework | undefined).some(t => t.id === args.template)) { throw new Error('请选择与芯片兼容的项目模板。'); }
    return { name: args.name, parent: args.parent, chip, template: args.template, ...(framework ? { framework: framework as EspProjectFramework } : {}) };
}

/** Only inert source files are generated. No SDK or project scripts execute here. */
export async function createSourceProject(request: ProjectRequest): Promise<{ path: string }> {
    const { name, chip, template } = request;
    const arduino = chip.family === 'esp32' && (request.framework ?? 'arduino') === 'arduino';
    if (template !== 'empty' && template !== 'hello') { throw new Error('该模板需要搭芯工程生成器。'); }
    if (chip.family !== 'k210' && chip.family !== 'esp32') { throw new Error('该型号需要 HAL 工程生成器。'); }
    const parent = await fs.realpath(request.parent);
    const root = join(parent, name);
    try { await fs.mkdir(root); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw new Error('该位置已有同名项目。'); }
        throw error;
    }
    const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
    const files: Record<string, string> = {
        'nodu.json': json({ schema: 1, name, kind: chip.family === 'k210' ? 'k210-maixpy' : arduino ? 'esp32-arduino' : 'esp-idf', target: { mcu: chip.id } }),
        '.gitignore': 'build/\n.nodu/\n__pycache__/\nsdkconfig.old\n',
    };
    if (chip.family === 'k210') {
        files['main.py'] = template === 'hello' ? 'import time\n\nwhile True:\n    print("Hello, K210!")\n    time.sleep(1)\n' : '# MaixPy\n';
    } else if (arduino) {
        files[`${name}.ino`] = template === 'hello'
            ? '#include <Arduino.h>\n\nvoid setup() {\n    Serial.begin(115200);\n}\n\nvoid loop() {\n    Serial.println("Hello, ESP32!");\n    delay(1000);\n}\n'
            : '#include <Arduino.h>\n\nvoid setup() {\n}\n\nvoid loop() {\n}\n';
        const serialOptions = chip.id === 'esp32s3' ? ':USBMode=hwcdc,CDCOnBoot=default,UploadMode=default' : '';
        files['sketch.yaml'] = `default_profile: nodu\nprofiles:\n  nodu:\n    fqbn: esp32:esp32:${chip.id}${serialOptions}\n    platforms:\n      - platform: esp32:esp32 (${ESP32_ARDUINO_CORE_VERSION})\n        platform_index_url: ${ESP32_ARDUINO_INDEX_URL}\n`
            + (['esp32s3', 'esp32c3'].includes(chip.id) ? '    libraries:\n' + ARDUINO_BUNDLED_LIBRARIES
                .map(library => `      - ${library.direct ? '' : 'dependency: '}${library.name} (${library.version})\n`).join('') : '');
        files['.theia/settings.json'] = json({ 'files.associations': { '*.ino': 'cpp' } });
        files['.vscode/settings.json'] = files['.theia/settings.json'];
    } else {
        files['CMakeLists.txt'] = `cmake_minimum_required(VERSION 3.16)\nset(IDF_TARGET "${chip.id}")\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(${name.replace(/-/g, '_')})\n`;
        files['main/CMakeLists.txt'] = 'idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")\n';
        files['main/main.c'] = template === 'hello'
            ? '#include <stdio.h>\n#include "freertos/FreeRTOS.h"\n#include "freertos/task.h"\n\nvoid app_main(void)\n{\n    while (1) {\n        printf("Hello, ESP32!\\n");\n        vTaskDelay(pdMS_TO_TICKS(1000));\n    }\n}\n'
            : 'void app_main(void)\n{\n}\n';
        files['sdkconfig.defaults'] = `CONFIG_IDF_TARGET="${chip.id}"\n`;
        // Theia does not ship VS Code's C/C++ extension or its $gcc matcher.
        const gccMatcher = { owner: 'esp-idf', fileLocation: 'absolute', pattern: {
            regexp: '^(.*?):(\\d+):(\\d+):\\s+(warning|error|fatal error):\\s+(.*)$', file: 1, line: 2, column: 3, severity: 4, message: 5,
        } };
        const tasks = ['build', 'flash', 'monitor', 'menuconfig'].map(action => ({ label: `ESP-IDF: ${action}`, type: 'process', command: 'idf.py', args: [action], options: { cwd: '${workspaceFolder}' }, problemMatcher: action === 'build' ? [gccMatcher] : [], ...(action === 'build' ? { group: { kind: 'build', isDefault: true } } : {}) }));
        const config = json({ version: '2.0.0', tasks });
        files['.theia/tasks.json'] = config;
        files['.vscode/tasks.json'] = config;
    }
    try {
        for (const [relative, content] of Object.entries(files)) {
            const path = join(root, relative);
            await fs.mkdir(join(path, '..'), { recursive: true });
            await fs.writeFile(path, content, { flag: 'wx' });
        }
        return { path: root };
    } catch (error) {
        await fs.rm(root, { recursive: true, force: true });
        throw error;
    }
}
