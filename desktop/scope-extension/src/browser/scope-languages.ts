// SPDX-License-Identifier: MIT
// Basic, local syntax support. This does not provide Python analysis or execution.
import * as monaco from '@theia/monaco-editor-core';

let registered = false;

/** Register the languages needed by the sample workspace without replacing installed providers. */
export function registerScopeLanguages(): void {
    if (registered) {
        return;
    }
    registered = true;

    if (!monaco.languages.getLanguages().some(language => language.id === 'python')) {
        registerPython();
    }
    if (!monaco.languages.getLanguages().some(language => language.id === 'json')) {
        registerJson();
    }
}

function registerPython(): void {
    monaco.languages.register({
        id: 'python',
        aliases: ['Python', 'python'],
        extensions: ['.py', '.pyw', '.pyi'],
        mimetypes: ['text/x-python'],
        firstLine: '^#!.*\\bpython[0-9.]*\\b'
    });

    monaco.languages.setLanguageConfiguration('python', {
        comments: { lineComment: '#' },
        brackets: [['(', ')'], ['[', ']'], ['{', '}']],
        autoClosingPairs: [
            { open: '(', close: ')' },
            { open: '[', close: ']' },
            { open: '{', close: '}' },
            { open: '"', close: '"', notIn: ['string', 'comment'] },
            { open: "'", close: "'", notIn: ['string', 'comment'] }
        ],
        surroundingPairs: [
            { open: '(', close: ')' },
            { open: '[', close: ']' },
            { open: '{', close: '}' },
            { open: '"', close: '"' },
            { open: "'", close: "'" }
        ],
        folding: { offSide: true },
        onEnterRules: [{
            beforeText: /^\s*(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b.*:\s*(?:#.*)?$/,
            action: { indentAction: monaco.languages.IndentAction.Indent }
        }]
    });

    monaco.languages.setMonarchTokensProvider('python', {
        defaultToken: '',
        tokenPostfix: '.python',
        keywords: [
            'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
            'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
            'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
            'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
            'match', 'case'
        ],
        constants: ['True', 'False', 'None'],
        builtins: [
            'abs', 'all', 'any', 'bin', 'bool', 'bytearray', 'bytes', 'callable',
            'chr', 'dict', 'dir', 'enumerate', 'filter', 'float', 'format',
            'getattr', 'hasattr', 'hex', 'id', 'input', 'int', 'isinstance',
            'issubclass', 'iter', 'len', 'list', 'map', 'max', 'memoryview',
            'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print',
            'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr',
            'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple',
            'type', 'vars', 'zip', '__import__'
        ],
        tokenizer: {
            root: [
                [/[ \t]+/, 'white'],
                [/#.*$/, 'comment'],
                [/@[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/, 'annotation'],
                // Prefixes are consumed with the opening quote so r/f/b strings stay a single token.
                [/(?:[rRuUbBfF]|[rR][fFbB]|[fFbB][rR])?'''/, 'string', '@tripleSingle'],
                [/(?:[rRuUbBfF]|[rR][fFbB]|[fFbB][rR])?"""/, 'string', '@tripleDouble'],
                [/(?:[rRuUbBfF]|[rR][fFbB]|[fFbB][rR])?'$/, 'string'],
                [/(?:[rRuUbBfF]|[rR][fFbB]|[fFbB][rR])?"$/, 'string'],
                [/(?:[rRuUbBfF]|[rR][fFbB]|[fFbB][rR])?'/, 'string', '@single'],
                [/(?:[rRuUbBfF]|[rR][fFbB]|[fFbB][rR])?"/, 'string', '@double'],
                [/0[xX][\da-fA-F](?:_?[\da-fA-F])*/, 'number.hex'],
                [/0[bB][01](?:_?[01])*/, 'number.binary'],
                [/0[oO][0-7](?:_?[0-7])*/, 'number.octal'],
                [/(?:\d(?:_?\d)*)?\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?/, 'number.float'],
                [/\d(?:_?\d)*\.(?:\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?/, 'number.float'],
                [/\d(?:_?\d)*[eE][+-]?\d(?:_?\d)*[jJ]?/, 'number.float'],
                [/\d(?:_?\d)*[jJ]?/, 'number'],
                [/[A-Za-z_]\w*/, {
                    cases: {
                        '@keywords': 'keyword',
                        '@constants': 'keyword',
                        '@builtins': 'type.identifier',
                        '@default': 'identifier'
                    }
                }],
                [/[()\[\]{}]/, '@brackets'],
                [/[,:;.]/, 'delimiter'],
                [/[+\-*/%&|^~<>=!:@]+/, 'operator'],
                [/\\$/, 'operator']
            ],
            single: [
                [/[^'\\]+$/, 'string', '@pop'],
                [/[^'\\]+/, 'string'],
                [/\\.$/, 'string.escape', '@pop'],
                [/\\./, 'string.escape'],
                [/'/, 'string', '@pop'],
                [/\\$/, 'string.escape']
            ],
            double: [
                [/[^"\\]+$/, 'string', '@pop'],
                [/[^"\\]+/, 'string'],
                [/\\.$/, 'string.escape', '@pop'],
                [/\\./, 'string.escape'],
                [/"/, 'string', '@pop'],
                [/\\$/, 'string.escape']
            ],
            tripleSingle: [
                [/'''/, 'string', '@pop'],
                [/[^'\\]+/, 'string'],
                [/\\./, 'string.escape'],
                [/'/, 'string'],
                [/\\$/, 'string.escape']
            ],
            tripleDouble: [
                [/"""/, 'string', '@pop'],
                [/[^"\\]+/, 'string'],
                [/\\./, 'string.escape'],
                [/"/, 'string'],
                [/\\$/, 'string.escape']
            ]
        }
    });
}

function registerJson(): void {
    monaco.languages.register({
        id: 'json',
        aliases: ['JSON', 'json'],
        extensions: ['.json'],
        mimetypes: ['application/json']
    });
    monaco.languages.setLanguageConfiguration('json', {
        brackets: [['{', '}'], ['[', ']']],
        autoClosingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '"', close: '"', notIn: ['string'] }
        ]
    });
    monaco.languages.setMonarchTokensProvider('json', {
        defaultToken: '',
        tokenPostfix: '.json',
        tokenizer: {
            root: [
                [/\s+/, 'white'],
                [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
                [/"/, 'string', '@string'],
                [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
                [/\b(?:true|false|null)\b/, 'keyword'],
                [/[{}\[\]]/, '@brackets'],
                [/[,:]/, 'delimiter']
            ],
            string: [
                [/[^"\\]+/, 'string'],
                [/\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/, 'string.escape'],
                [/\\./, 'string.escape.invalid'],
                [/"/, 'string', '@pop']
            ]
        }
    });
}
