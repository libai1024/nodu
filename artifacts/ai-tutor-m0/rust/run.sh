#!/bin/sh
set -eu
probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$probe_dir/../../.." && pwd)
task_cargo=${CARGO:-$HOME/.cargo/bin/cargo}
"$task_cargo" run --locked --manifest-path "$probe_dir/Cargo.toml" > "$probe_dir/results/probe.json"
python3 - "$probe_dir" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);result=json.loads((root/'results/probe.json').read_text())
(root/'results/generated.ts').write_text(result['typescript']+'\nconst sample: ResultRow = '+json.dumps(result['cases'][0])+';\nvoid sample;\n')
print('C syntax probe:',len(result['cases']),'cases passed; grammar ABI',result['grammarAbi'])
PY
node "$repo_dir/desktop/node_modules/typescript/bin/tsc" -p "$probe_dir/tsconfig.json"
