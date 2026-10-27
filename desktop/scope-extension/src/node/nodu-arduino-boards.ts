// SPDX-License-Identifier: MIT
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { ArduinoBoard, ArduinoBoardOption, ArduinoConfigureRequest, ArduinoProjectInfo } from '../common/nodu-arduino-protocol';
import { readArduinoProject } from './nodu-arduino-project';
import { arduinoResources } from './nodu-arduino-paths';

export interface BoardCatalog { version: string; properties: Record<string, string> }
export function parseBoardProperties(text: string): Record<string, string> {
    const result: Record<string, string> = Object.create(null);
    for (const line of text.split(/\r?\n/)) {
        const index = line.indexOf('=');
        if (index <= 0 || /^\s*[#!]/.test(line)) { continue; }
        result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return result;
}
export async function installedArduinoCore(home: string, version: string): Promise<string | undefined> {
    const internal = join(home, 'data', 'internal');
    const names = (await fs.readdir(internal).catch(() => [] as string[])).filter(name => name.startsWith(`esp32_esp32_${version}_`)).sort();
    for (const path of [...names.map(name => join(internal, name)), join(home, 'data', 'packages', 'esp32', 'hardware', 'esp32', version)]) {
        if ((await fs.stat(join(path, 'boards.txt')).catch(() => undefined))?.isFile()) { return path; }
    }
    return undefined;
}
export async function boardCatalog(home: string, version: string): Promise<BoardCatalog> {
    const installed = await installedArduinoCore(home, version);
    if (installed) { return { version, properties: parseBoardProperties(await fs.readFile(join(installed, 'boards.txt'), 'utf8')) }; }
    return JSON.parse(await fs.readFile(join(arduinoResources(), `boards-${version}.json`), 'utf8'));
}
export function catalogBoards(catalog: BoardCatalog, chip: string): ArduinoBoard[] {
    return Object.entries(catalog.properties).filter(([key]) => /^[^.]+\.name$/.test(key))
        .map(([key, name]) => ({ name, fqbn: `esp32:esp32:${key.split('.')[0]}`, chip: catalog.properties[`${key.split('.')[0]}.build.mcu`] }))
        .filter(board => board.chip === chip).sort((a, b) => a.name.localeCompare(b.name));
}
export function catalogOptions(catalog: BoardCatalog, fqbn: string, chip: string): ArduinoBoardOption[] {
    const segments = fqbn.split(':'), board = segments.slice(0, 3).join(':');
    if (!catalogBoards(catalog, chip).some(item => item.fqbn === board)) { throw new Error('开发板与工程芯片不匹配。'); }
    const selected = new Map((segments[3] || '').split(',').filter(Boolean).map(pair => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)]; }));
    const options = new Map<string, ArduinoBoardOption>();
    const prefix = `${segments[2]}.menu.`;
    for (const [key, label] of Object.entries(catalog.properties)) {
        if (!key.startsWith(prefix)) { continue; }
        const tail = key.slice(prefix.length).split('.');
        if (tail.length !== 2) { continue; }
        const [id, value] = tail;
        if (!options.has(id)) { options.set(id, { id, label: catalog.properties[`menu.${id}`] || id, value: selected.get(id) ?? value, values: [] }); }
        options.get(id)!.values.push({ value, label });
    }
    for (const [id, value] of selected) { if (!options.get(id)?.values.some(item => item.value === value)) { throw new Error(`开发板参数 ${id}=${value} 不受当前 Core 支持。`); } }
    return [...options.values()];
}
async function localState(path: string): Promise<{ port?: string; monitor?: { baud?: number; encoding?: string; port?: string } }> {
    try { return JSON.parse(await fs.readFile(join(path, '.nodu', 'arduino.local.json'), 'utf8')); } catch { return {}; }
}
export async function inspectArduinoProject(home: string, path: string): Promise<ArduinoProjectInfo> {
    const project = await readArduinoProject(path), state = await localState(project.path);
    const catalog = await boardCatalog(home, project.coreVersion);
    catalogOptions(catalog, project.fqbn, project.chip);
    const boardName = catalogBoards(catalog, project.chip).find(item => item.fqbn === project.fqbn.split(':').slice(0, 3).join(':'))!.name;
    return { ...project, boardName, ready: !!await installedArduinoCore(home, project.coreVersion), port: typeof state.port === 'string' ? state.port : undefined,
        monitor: { baud: Number.isInteger(state.monitor?.baud) && state.monitor!.baud! >= 1200 && state.monitor!.baud! <= 4_000_000 ? state.monitor!.baud! : 115200,
            encoding: state.monitor?.encoding === 'gbk' ? 'gbk' : 'utf-8', port: typeof state.monitor?.port === 'string' ? state.monitor.port : undefined } };
}
export async function configureArduinoProject(home: string, request: ArduinoConfigureRequest): Promise<ArduinoProjectInfo> {
    const project = await readArduinoProject(request.path), catalog = await boardCatalog(home, project.coreVersion);
    const file = join(project.path, 'sketch.yaml'), before = await fs.readFile(file, 'utf8'), doc = parseDocument(before);
    if (request.fqbn !== undefined || request.options !== undefined) {
        let fqbn = request.fqbn ?? project.fqbn;
        const options = catalogOptions(catalog, fqbn, project.chip);
        if (request.options) {
            const selected = Object.fromEntries(options.map(option => [option.id, option.value]));
            for (const [id, value] of Object.entries(request.options)) {
                if (!options.find(option => option.id === id)?.values.some(item => item.value === value)) { throw new Error(`无效的开发板参数 ${id}。`); }
                selected[id] = value;
            }
            fqbn = fqbn.split(':').slice(0, 3).join(':') + ':' + Object.entries(selected).map(([key, value]) => `${key}=${value}`).join(',');
        }
        doc.setIn(['profiles', project.profile, 'fqbn'], fqbn);
    }
    const state = await localState(project.path);
    if (request.port !== undefined) {
        if (typeof request.port !== 'string' || request.port.length > 512 || /[\0\r\n]/.test(request.port)) { throw new Error('无效的串口。'); }
        state.port = request.port;
    }
    if (request.monitor) {
        const { baud, encoding } = request.monitor;
        if (baud !== undefined && (!Number.isInteger(baud) || baud < 1200 || baud > 4_000_000)) { throw new Error('无效的波特率。'); }
        if (encoding !== undefined && !['utf-8', 'gbk'].includes(encoding)) { throw new Error('无效的串口编码。'); }
        if (request.monitor.port !== undefined && (typeof request.monitor.port !== 'string' || request.monitor.port.length > 512 || /[\0\r\n]/.test(request.monitor.port))) { throw new Error('无效的监视串口。'); }
        state.monitor = { ...state.monitor, ...request.monitor };
    }
    // Local serial preferences must not reformat sketch.yaml or invalidate a valid build.
    const after = request.fqbn !== undefined || request.options !== undefined ? doc.toString() : before;
    const directory = join(project.path, '.nodu'), localFile = join(directory, 'arduino.local.json');
    const localBefore = await fs.readFile(localFile, 'utf8').catch(() => undefined);
    const localAfter = request.port !== undefined || request.monitor !== undefined ? JSON.stringify(state, null, 2) + '\n' : localBefore;
    const temporary = `${file}.${randomUUID()}.tmp`, localTemporary = `${localFile}.${randomUUID()}.tmp`;
    let profileWritten = false;
    try {
        if (after !== before) { await fs.writeFile(temporary, after, { flag: 'wx', mode: (await fs.stat(file)).mode }); }
        if (localAfter !== localBefore) { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(localTemporary, localAfter!, { flag: 'wx' }); }
        if (await fs.readFile(file, 'utf8') !== before || await fs.readFile(localFile, 'utf8').catch(() => undefined) !== localBefore) {
            throw new Error('工程配置已改变，请重试。');
        }
        if (after !== before) { await fs.rename(temporary, file); profileWritten = true; }
        if (localAfter !== localBefore) { await fs.rename(localTemporary, localFile); }
    } catch (error) {
        // If the second rename fails, restore only the exact revision we wrote.
        if (profileWritten && await fs.readFile(file, 'utf8').catch(() => '') === after) {
            await fs.writeFile(temporary, before); await fs.rename(temporary, file);
        }
        throw error;
    } finally { await fs.rm(temporary, { force: true }); await fs.rm(localTemporary, { force: true }); }
    return inspectArduinoProject(home, project.path);
}
