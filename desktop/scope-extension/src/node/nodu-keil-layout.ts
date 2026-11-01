// SPDX-License-Identifier: MIT
// Translate the supported GNU memory/section contract; never fall back over a custom layout.
import { promises as fs } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import type { ProjectStatus } from '../common/nodu-embedded-protocol';

const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'keilLayout' }); };
const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
const uncomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
export interface KeilLayout {
    flashBase: number; flashSize: number; ramBase: number; ramSize: number;
    stack: number; heap: number; vectorAssertion?: boolean; ramVectors: boolean; ramFunctions: boolean; source?: string; unusedCcm?: { base: number; size: number };
}
export function parseLinkerLayout(text: string, limits: { flashSize: number; ramSize: number; ccmSize?: number }): KeilLayout {
    const s = uncomment(text);
    const number = (value: string): number => {
        const m = /^(0x[\da-f]+|\d+)\s*([KkMm])?$/.exec(value.trim());
        if (!m) return fail(`链接脚本中的表达式“${value.trim()}”不能等价转换；请使用明确的地址或大小。`);
        return Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1024 : m[2]?.toLowerCase() === 'm' ? 1048576 : 1);
    };
    const memory = /\bMEMORY\s*\{([^}]+)\}/.exec(s)?.[1];
    if (!memory) return fail('链接脚本缺少 MEMORY，未生成猜测的 Keil 内存布局。');
    const regions = [...memory.matchAll(/(\w+)\s*(?:\([^)]*\))?\s*:\s*ORIGIN\s*=\s*([^,]+),\s*LENGTH\s*=\s*([^\r\n}]+)/g)]
        .map(m => ({ name: m[1], base: number(m[2]), size: number(m[3]) }));
    const flash = regions.find(r => r.name === 'FLASH'), ram = regions.find(r => r.name === 'RAM');
    if (!flash || !ram || regions.some(r => r.name !== 'FLASH' && r.name !== 'RAM' && r.name !== 'CCM')) return fail('当前链接脚本包含未适配的内存区域；需要先提供对应的 Keil scatter，不能丢弃这些区域。');
    const ccm = regions.find(r => r.name === 'CCM');
    if (ccm && (ccm.base !== 0x10000000 || ccm.size <= 0 || ccm.size > (limits.ccmSize ?? 0) || />\s*CCM\b/.test(s))) return fail('CCM 的自定义放置规则尚未适配，未忽略该区域。');
    if (flash.base < 0x08000000 || flash.base + flash.size > 0x08000000 + limits.flashSize
        || ram.base < 0x20000000 || ram.base + ram.size > 0x20000000 + limits.ramSize || flash.size <= 0 || ram.size <= 0) return fail('链接脚本的内存范围超过所选芯片容量。');
    const setting = (name: string, fallback: number) => {
        const m = new RegExp(`\\b${name}\\s*=\\s*([^;]+);`).exec(s);
        return m ? number(m[1]) : fallback;
    };
    const stack = setting('_Min_Stack_Size', 0x800), heap = setting('_Min_Heap_Size', 0x200);
    if (stack < 8 || stack % 8 || heap % 8 || stack + heap >= ram.size) return fail('堆栈大小无效或超过 RAM，未生成工程。');
    const sections = [...s.matchAll(/(?:^|\n)\s*(\.[\w.]+)\s*(?:\([^)]*\))?\s*:/g)].map(m => m[1]);
    const supported = new Set(['.isr_vector', '.text', '.ARM.extab', '.ARM.exidx', '.preinit_array', '.init_array', '.fini_array', '.ram_vectors', '.data', '.bss', '._user_heap_stack', '.ARM.attributes']);
    const unknown = sections.filter(n => !supported.has(n));
    if (unknown.length) return fail(`链接脚本含未适配的段 ${unknown.join('、')}；未生成会改变布局的 Keil 工程。`);
    if (/\b(INCLUDE|OVERLAY|INSERT|PHDRS)\b/.test(s)) return fail('链接脚本包含 INCLUDE/OVERLAY/INSERT/PHDRS，需先适配对应的 scatter。');
    const vectorAssert = /\bASSERT\(\s*SIZEOF\(\.isr_vector\)\s*<=\s*SIZEOF\(\.ram_vectors\)\s*,\s*"[^"]*"\s*\)/g;
    const hasVectorAssert = vectorAssert.test(s);
    if (/\bASSERT\s*\(/.test(s.replace(vectorAssert, ''))) return fail('链接脚本含尚未等价转换的 ASSERT 条件，未删除该检查。');
    const vectors = /\.ram_vectors\s*\(NOLOAD\)\s*:\s*\{[\s\S]*?\}\s*>\s*RAM/.test(s);
    if (s.includes('.ram_vectors') && !vectors) return fail('RAM 向量表没有使用已适配的 NOLOAD/RAM 布局。');
    // Only the standard stack-at-RAM-top contract is safe to map to __initial_sp.
    const estack = /\b_estack\s*=\s*([^;]+);/.exec(s)?.[1].replace(/\s/g, '');
    if (estack && estack !== 'ORIGIN(RAM)+LENGTH(RAM)') return fail('自定义 _estack 表达式需要对应的 Keil 启动配置，未忽略该设置。');
    return { flashBase: flash.base, flashSize: flash.size, ramBase: ram.base, ramSize: ram.size, stack, heap, unusedCcm: ccm && { base: ccm.base, size: ccm.size },
        ramVectors: vectors, vectorAssertion: hasVectorAssert, ramFunctions: /\*\s*\(\s*\.RamFunc\*?\s*\)/.test(s) };
}

export async function readLinkerLayout(project: ProjectStatus, compileFile: string): Promise<KeilLayout> {
    const root = await fs.realpath(project.path);
    const ninja = await fs.readFile(join(dirname(compileFile), 'build.ninja'), 'utf8').catch(() => '');
    const flags = /^  LINK_FLAGS = (.+)$/m.exec(ninja)?.[1].replace(/\$ /g, ' ').replace(/\$\$/g, '$') ?? '';
    const unsafe = /--(?:wrap|defsym|section-start|undefined)|-nostdlib|-nodefaultlibs/.exec(flags);
    if (unsafe) return fail(`链接参数 ${unsafe[0]} 尚未等价映射到 Arm，未忽略此设置。`);
    const libraries = /^  LINK_LIBRARIES = (.+)$/m.exec(ninja)?.[1] ?? '';
    if (/\.a(?:\s|$)|-l(?![cm](?:\s|$))/.test(libraries)) return fail('工程链接了额外库，需要提供对应的 Arm 编译版本，未丢弃这些库。');
    const tokens = (flags.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(t => t.replace(/^["']|["']$/g, ''));
    const linked = tokens.flatMap((t, i) => t === '-T' ? [tokens[i + 1]] : t.startsWith('-T') ? [t.slice(2)] : []);
    if (linked.length > 1) return fail('实际链接参数包含多个 GNU 链接脚本，需要先适配，未只选取其中一个。');
    const target = await fs.readFile(join(root, 'cmake/nodu-target.cmake'), 'utf8').catch(() => '');
    const configured = /set\(NODU_LINKER_SCRIPT\s+"?([^"\s)]+)/.exec(target)?.[1];
    let file: string | undefined;
    if (linked.length) file = resolve(root, linked[0]);
    else if (configured) file = resolve(root, configured);
    else {
        const files = (await fs.readdir(join(root, 'Linker')).catch(() => [])).filter(n => n.endsWith('.ld'));
        if (files.length > 1) fail('Linker 中有多个链接脚本，无法确定实际使用的文件。请重新配置工程。');
        if (files.length === 1) file = join(root, 'Linker', files[0]);
    }
    if (!file) return fail('找不到实际 GNU 链接脚本，请先在 Nodu 配置工程；不能用默认 64KB 布局代替。');
    const rel = relative(root, file);
    if (rel.startsWith('..') || /^(?:[A-Za-z]:|\/)/.test(rel)) fail('链接脚本必须随项目携带，不能引用本机目录外的文件。');
    const actual = await fs.realpath(file);
    if ((await fs.lstat(file)).isSymbolicLink() || relative(root, actual).startsWith('..')) fail('链接脚本不能通过符号链接引用外部文件。');
    return { ...parseLinkerLayout(await fs.readFile(file, 'utf8'), { flashSize: project.chip.flash.size, ramSize: project.chip.ram.size, ccmSize: project.chip.id === 'STM32F407ZGTx' ? 65536 : 0 }), source: rel.replace(/\\/g, '/') };
}

export function scatterFor(layout: KeilLayout, startup: string, vectorBytes = 0): string {
    const { flashBase: f, flashSize: fs, ramBase: r, ramSize: rs, stack } = layout;
    if (layout.vectorAssertion && (!vectorBytes || vectorBytes > 0x200)) fail('无法确定 Arm 向量表长度，未忽略原链接脚本的检查。');
    const vectorSize = layout.ramVectors ? 0x200 : 0;
    return `; Nodu: translated from ${layout.source ?? 'GNU linker layout'}; preserve application/config boundary.\nLR_IROM1 ${hex(f)} ${hex(fs)} {\n  ER_IROM1 ${hex(f)} ${hex(fs)} {\n    ${startup.replace(/\.s$/i, '.o')} (RESET, +First)\n    *(InRoot$$Sections)\n    .ANY (+RO)\n  }\n${layout.ramVectors ? `  RAM_VECTORS ${hex(r)} UNINIT ${hex(vectorSize)} { *(.ram_vectors) }\n` : ''}${layout.vectorAssertion ? `  ScatterAssert(ImageLength(RAM_VECTORS) >= ${hex(vectorBytes)})\n` : ''}  RW_IRAM1 ${hex(r + vectorSize)} ${hex(rs - stack - vectorSize)} {\n${layout.ramFunctions ? '    *(.RamFunc*)\n' : ''}    .ANY (+RW +ZI)\n  }\n  ARM_STACK ${hex(r + rs - stack)} UNINIT ${hex(stack)} { ${startup.replace(/\.s$/i, '.o')} (STACK) }\n}\n`;
}
