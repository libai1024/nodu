// SPDX-License-Identifier: MIT
export interface CourseJsonSchema {
    $schema?: string;
    $id?: string;
    type?: 'object' | 'array' | 'string' | 'integer' | 'boolean';
    properties?: Record<string, CourseJsonSchema>;
    required?: string[];
    additionalProperties?: false;
    items?: CourseJsonSchema;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    enum?: (string | number | boolean)[];
    const?: string | number | boolean;
    oneOf?: CourseJsonSchema[];
}

const ID = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
const HASH = '^[a-f0-9]{64}$';
const SYMBOL = '^[A-Za-z_][A-Za-z0-9_]*$';
const PATH = '^(?!.*(?:^|/)[.]{1,2}(?:/|$))(?!/)(?!.*//)(?!.*[\\\\:\\x00-\\x1f\\x7f])(?!.*[. ](?:/|$))[^/]+(?:/[^/]+)*$';
const str = (maxLength = 4000, minLength = 1): CourseJsonSchema => ({ type: 'string', minLength, maxLength, ...(minLength ? { pattern: '\\S' } : {}) });
const named = (): CourseJsonSchema => ({ ...str(64), pattern: ID });
const digest = (): CourseJsonSchema => ({ ...str(64), pattern: HASH });
const list = (items: CourseJsonSchema, maxItems: number, minItems = 0): CourseJsonSchema => ({ type: 'array', items, minItems, maxItems });
const obj = (properties: Record<string, CourseJsonSchema>, required = Object.keys(properties)): CourseJsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const values = (...enum_: string[]): CourseJsonSchema => ({ type: 'string', enum: enum_ });
const uniqueNames = (max = 256): CourseJsonSchema => ({ ...list(named(), max), uniqueItems: true });
const natural: CourseJsonSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };

export const TUTOR_TARGET_SCHEMA = obj({
    mcu: { ...str(64), pattern: '^[A-Za-z][A-Za-z0-9_-]{1,63}$' },
    sdkId: str(128), sdkDigest: digest(),
    template: obj({ id: str(128), revision: str(128), digest: digest() }),
    wiringProfileId: named(), wiringDigest: digest(),
}, ['mcu', 'sdkId', 'sdkDigest']);

const baseRequirement = { id: named(), text: str(), severity: values('required', 'advisory') };
const requirement = (type: string, more: Record<string, CourseJsonSchema> = {}, optional: string[] = []): CourseJsonSchema => {
    const properties = { ...baseRequirement, type: { const: type }, ...more };
    return obj(properties, Object.keys(properties).filter(key => !optional.includes(key)));
};
const requirements: CourseJsonSchema = { oneOf: [
    requirement('manual', { legacyType: values('compiles', 'calls', 'checksReturn', 'noCallIn', 'hostTest', 'serialMatch', 'review', 'manual') }, ['legacyType']),
    requirement('compiles'),
    requirement('calls', { anchorId: named(), callee: { ...str(128), pattern: SYMBOL } }),
    requirement('checksReturn', { anchorId: named(), callee: { ...str(128), pattern: SYMBOL } }),
    requirement('noCallIn', { anchorId: named(), callees: { ...list({ ...str(128), pattern: SYMBOL }, 64, 1), uniqueItems: true } }),
    requirement('hostTest', { suiteId: named(), suiteDigest: digest() }),
    requirement('serialMatch', { captureProfileId: named(), matcher: obj({ kind: { const: 'literal' }, value: str(1024) }) }),
    requirement('review', { rubricId: named(), rubricDigest: digest() }),
] };
const anchor = obj({ id: named(), path: { ...str(240), pattern: PATH }, symbol: str(128), scope: str(240), marker: str(128) }, ['id', 'path']);
const guidance = obj({ id: named(), anchorId: named(), lines: list({ ...str(2000, 0), pattern: '^[^\\r\\n]*$' }, 256, 1), context: str(16000), requiredSymbols: { ...list({ ...str(128), pattern: SYMBOL }, 128), uniqueItems: true }, citationIds: uniqueNames(64) });
const hints = obj({ intent: str(), api: str(), skeleton: str(16000, 0), reference: str(16000, 0) });
const option = obj({ id: named(), label: str(256), available: { type: 'boolean' }, note: str(4000, 0) });
const step = obj({
    id: named(), kind: values('decide', 'implement', 'test', 'refactor'), title: str(256), goal: str(), why: str(),
    layer: values('app', 'driver', 'bsp', 'config'),
    dependsOn: list(obj({ stepId: named(), mode: values('required', 'advisory') }), 256),
    anchors: list(anchor, 32), requirements: list(requirements, 64), hints,
    options: list(option, 32, 1), rules: uniqueNames(), guidance: list(guidance, 64, 1),
}, ['id', 'kind', 'title', 'goal', 'why', 'dependsOn', 'anchors', 'requirements', 'rules']);

export const TUTOR_COURSE_SCHEMA: CourseJsonSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://nodu.local/schema/tutor-course-v2',
    ...obj({
        schema: { const: 2 }, id: named(), revision: natural, contentHash: digest(), title: str(256), goal: str(),
        target: TUTOR_TARGET_SCHEMA, source: values('course', 'generated'),
        course: obj({ id: named(), version: str(128), digest: digest() }),
        decisions: list(obj({ stepId: named(), optionId: named() }), 256),
        rules: list(obj({ id: named(), title: str(256), why: str() }), 256),
        steps: list(step, 256, 1),
        legacy: obj({ schema: { const: 1 }, board: str(), sdk: str(), version: natural }),
    }, ['schema', 'id', 'revision', 'contentHash', 'title', 'goal', 'target', 'source', 'decisions', 'rules', 'steps']),
};

const legacyText = (required = true): CourseJsonSchema => ({ oneOf: [str(4000, required ? 1 : 0), list(str(4000, 0), 256, required ? 1 : 0)] });
export const TUTOR_LEGACY_COURSE_SCHEMA = obj({
    schema: { const: 1 }, id: named(), version: natural, title: legacyText(), goal: legacyText(),
    board: legacyText(), sdk: legacyText(), source: values('course', 'generated'),
    rules: list(obj({ id: named(), title: legacyText(), why: legacyText() }), 256),
    steps: list(obj({
        id: named(), kind: values('decide', 'implement', 'test', 'refactor'), layer: values('app', 'driver', 'bsp', 'config'),
        title: legacyText(), goal: legacyText(), why: legacyText(), dependsOn: uniqueNames(),
        anchor: obj({ file: { ...str(240), pattern: PATH } }),
        hints: obj({ intent: legacyText(), api: legacyText(), skeleton: legacyText(false), reference: legacyText(false) }, ['intent', 'api']),
        contract: list(obj({ type: values('compiles', 'calls', 'checksReturn', 'noCallIn', 'hostTest', 'serialMatch', 'review', 'manual'), text: legacyText() }), 64),
        options: list(obj({ id: named(), label: legacyText(), available: { type: 'boolean' }, note: legacyText(false) }, ['id', 'label']), 32, 1),
        rules: uniqueNames(),
    }, ['id', 'kind', 'title', 'goal', 'why']), 256, 1),
}, ['schema', 'id', 'version', 'title', 'goal', 'board', 'sdk', 'source', 'steps']);
