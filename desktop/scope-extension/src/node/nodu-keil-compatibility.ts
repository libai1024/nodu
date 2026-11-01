// SPDX-License-Identifier: MIT
/** Shared-source contract: ISO C99 plus the attributes supported by GCC and Arm. */
export interface CompatibilityIssue { file: string; line: number; column: number; message: string; fix: string }
const headerFixes: Record<string, string> = {
    'memory.h': '改为标准头文件 <string.h>；memcpy/memset/memcmp 的声明均在其中。',
    'malloc.h': '改为标准头文件 <stdlib.h>；malloc/free 的声明均在其中。',
    'unistd.h': '这是 POSIX/newlib 接口；将依赖改为板级接口或显式提供 Arm C 库实现。',
    'sys/unistd.h': '这是 newlib 专用接口；请移植为板级接口。',
    'features.h': '这是 GCC/libc 专用内部头文件；请使用标准 C 头文件。',
    'stdatomic.h': 'AC5 不提供 C11 原子接口；用明确的临界区或 CMSIS 指令实现同步。',
    'stdalign.h': 'AC5 不提供 C11 对齐头文件；请使用经支持的 aligned 属性。',
    'stdnoreturn.h': '请使用各编译器均支持的 noreturn 属性。',
    'threads.h': 'AC5 不提供 C11 线程接口；用项目实际支持的调度/任务接口。',
};
/** Preserve line/column positions while excluding comments and strings from syntax checks. */
function masked(source: string, strings: boolean): string {
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
        match => !strings && (match.startsWith('"') || match.startsWith("'")) ? match : match.replace(/[^\r\n]/g, ' '));
}
export function sourceCompatibility(file: string, source: string): CompatibilityIssue[] {
    const issues: CompatibilityIssue[] = [], comments = masked(source, false), code = masked(source, true);
    const add = (index: number, message: string, fix: string) => {
        const before = source.slice(0, index), last = before.lastIndexOf('\n');
        issues.push({ file, line: before.split('\n').length, column: index - last, message, fix });
    };
    for (const m of comments.matchAll(/^[ \t]*#[ \t]*include\s*[<"]([^>"]+)[>"]/gm)) {
        const fix = headerFixes[m[1]]; if (fix) add(m.index!, `头文件 ${m[1]} 不符合共用源码的 Keil/C99 约定。`, fix);
    }
    for (const m of code.matchAll(/\b(_Static_assert|_Generic|_Thread_local|_Atomic|_Alignas|_Alignof|_Noreturn|__auto_type)\b/g)) {
        add(m.index!, `${m[1]} 不是 AC5/AC6 共用的 C99 写法。`, m[1] === '_Static_assert'
            ? '使用 typedef char Name[(condition) ? 1 : -1] 保留编译期检查；不能删除断言或把失败条件改成通过。'
            : '请改用 C99 写法；需要编译器专用实现时先完成明确的条件编译适配。');
    }
    return issues;
}

/** Flags that change semantics and have no established AC5/AC6 mapping must not disappear. */
export function checkCompilerArguments(args: string[], file: string): void {
    const unsupported = args.filter(a => a === '-Ofast' || a.startsWith('-f') && !/^-(?:ffunction-sections|fdata-sections|fstack-usage|fdiagnostics-[\w=-]+)$/.test(a) || a.startsWith('-m') && !/^-(?:mthumb|mcpu=cortex-m[34]|mfpu=fpv4-sp-d16|mfloat-abi=(?:soft|hard))$/.test(a) || /^-(?:f(?:pack-struct|short-enums|short-wchar|unsigned-bitfields|signed-bitfields|abi-version|ms-extensions|plan9-extensions|openmp|openacc|stack-protector|pic|pie|lto|sanitize|no-builtin)|m(?:big-endian|cmse)|include|imacros|U)|^-std=(?:gnu|c)(?:2x|23)/i.test(a));
    if (unsupported.length) throw Object.assign(new Error(`${file} 使用尚未等价映射的编译选项 ${unsupported.join(' ')}。请先移植这些选项，未生成会丢失语义的 Keil 工程。`), { code: 'keilCompiler' });
}
