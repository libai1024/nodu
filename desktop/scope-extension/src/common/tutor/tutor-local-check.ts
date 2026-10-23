// SPDX-License-Identifier: MIT
export interface TutorLocalRule { id: string; kind: 'calls' | 'noCallIn' | 'checksReturn'; function: string; callee: string; }
export interface TutorLocalCheck {
    schema: 1;
    sourceDigest: string;
    syntax: 'valid' | 'incomplete' | 'unavailable';
    errorLines: number[];
    insertionLines?: number[];
    findings: { id: string; verdict: 'verified' | 'needs-work' | 'unknown'; line?: number | null; note: string }[];
    execution?: TutorPureExecution;
    note?: string;
}

export interface TutorPureUnit { functions: ('sht30_crc8' | 'sht30_convert')[]; source: string; }
export interface TutorPureExecution {
    suite: 'sht30-pure-v1'; sourceDigest: string;
    status: 'passed' | 'failed' | 'unavailable' | 'cancelled';
    passed: number; total: number; note: string;
}
