type Verdict = "checked" | "unchecked" | "missing" | "unknown";
type SliceRange = { startUtf16: number, endUtf16: number, };
type ResultRow = { id: string, verdict: Verdict, parserHasError: boolean, callCount: number, sourceRange: SliceRange | null, };

const sample: ResultRow = {"callCount": 1, "id": "direct-guard", "parserHasError": false, "sourceRange": {"endUtf16": 33, "startUtf16": 18}, "verdict": "checked"};
void sample;
