// SPDX-License-Identifier: MIT
export interface TutorLocalRule { id: string; kind: 'calls' | 'noCallIn' | 'checksReturn'; function: string; callee: string; }
export interface TutorLocalCheck {
    schema: 1;
    sourceDigest: string;
    syntax: 'valid' | 'incomplete' | 'unavailable';
    errorLines: number[];
    findings: { id: string; verdict: 'verified' | 'needs-work' | 'unknown'; line?: number | null; note: string }[];
    note?: string;
}
