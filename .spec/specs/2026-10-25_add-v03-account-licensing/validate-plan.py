#!/usr/bin/env python3
"""Validate the planning snapshot, not Nodu implementation or release readiness."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--compare-worktree', type=Path)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
package = Path(__file__).resolve().parent
root = package.parents[2]
skill_root = Path(os.environ.get('SPEC_SKILL_ROOT', Path.home() / '.zcode/skills/spec'))
sys.path.insert(0, str(skill_root / 'scripts'))
from spec_package_support import (  # noqa: E402
    active_branch_bindings, clarification_gaps, dependency_errors,
    extract_pending_questions, orchestration_strategy_errors,
    parse_task_records, ready_task_ids, task_dependencies,
)

BASE = 'de67821403f03cf8e5186adcb9f552e5d757a9a4'
BRANCH = 'spec/2026-10-25_add-v03-account-licensing'
INPUTS = {
    'README.md': 'dbed67927fa530c3f7fdf543b54cba81223fbf69349cd178aec7be5d7a5b5343',
    'DESIGN.md': '6540104320930f9e692dd91e8c0c03dd9706af4b74213a2f19fa01ad99b9b38d',
    'API-CONTRACT.md': 'da82beafc25f478bc25aff3557510a1a2125391afe001edaca5825d7e5c73fd6',
    'ROADMAP-AND-TESTS.md': '3c597d3272fc344385535e2635377af996ea42373e7e6a5fc63ca80739fdb553',
    'research-gateway.md': '50d04e7f86eb298c0b0b17b182dccac84bd3c4daa2dbab2bfb7acdc8641cbf8e',
    'research-identity.md': 'cd8b22f8138b6b2a2be918bca2adc1ef8d5b4afe003d5b42581d7ab743393053',
}
INITIAL_STATUS = {
    ' D artifacts/e2e-0.1.4/comparison-camera.py.autosave',
    ' M desktop/examples/green-tracker/.theia/settings.json',
    '?? .claude/',
    '?? artifacts/0211-f407-20261023/',
    '?? artifacts/dacir-preupload-20261023/',
    '?? artifacts/dacir-simulation-20261023/',
    '?? artifacts/daxin-templates-20261023/',
    '?? artifacts/dht11-e2e-20261023/',
    '?? artifacts/f103-ui-20261022/',
    '?? artifacts/isp-e2e-20261022/',
    '?? artifacts/launcher-audit-20261024/',
    '?? artifacts/project-icons-20261024/',
    '?? artifacts/serial-e2e-20261022/',
    '?? artifacts/ui-cursor-comparison-20261025/',
    '?? desktop/examples/green-tracker/Untitled-1.py',
    '?? docs/0.3/',
    '?? docs/research/',
    '?? iot-miniapps/',
}


def git(*params: str, cwd: Path = root) -> str:
    return subprocess.check_output(['git', '-C', str(cwd), *params], text=True)


errors: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


spec = (package / 'spec.md').read_text()
tasks = (package / 'tasks.md').read_text()
checklist = (package / 'checklist.md').read_text()
analysis = (package / 'analysis.md').read_text()
records = parse_task_records(tasks)
ids = {record.id for record in records}
errors.extend(clarification_gaps(spec))
errors.extend(extract_pending_questions(spec))
errors.extend(orchestration_strategy_errors(spec))
errors.extend(dependency_errors(records))
require(len(records) == 32, 'Expected 32 implementation tasks')
require(all(record.executable for record in records), 'Every task needs boundary and verify')
require(all(record.id.startswith('task-') for record in records), 'Every task needs a stable id')
require(all('- owner:' in record.block_text for record in records), 'Every task needs an owner')
require(not any(record.checked for record in records), 'Planning must not complete implementation tasks')
require(not re.search(r'^\s*- \[[xX]\]', spec + '\n' + checklist, re.M), 'Release checkboxes must remain open')
expected_phases = {'P0': 5, 'P1': 5, 'P2': 4, 'P3': 6, 'P4': 5, 'P5': 7}
phases: dict[str, int] = {}
for match in re.finditer(r'^## (P[0-5])[^\n]*\n(.*?)(?=^## |\Z)', tasks, re.M | re.S):
    phases[match[1]] = len(re.findall(r'^- \[ \]', match[2], re.M))
require(phases == expected_phases, 'Milestone task counts disagree')
ready = sorted(ready_task_ids(records))
require(ready == ['task-contract', 'task-upstream-lock'], 'Unexpected initial ready tasks')

matrix = analysis.split('## 5. 验收覆盖索引', 1)[1].split('## 6.', 1)[0]
coverage = set(re.findall(r'\b(?:A\d{2}|L\d{2}|B\d{2})\b', matrix))
expected_ids = {f'{prefix}{n:02}' for prefix, count in [('A', 7), ('L', 16), ('B', 12)] for n in range(1, count + 1)}
require(coverage == expected_ids, 'Acceptance matrix must cover all 35 source test ids')
require(set(re.findall(r'\btask-[a-z0-9-]+', matrix)) <= ids, 'Matrix refers to unknown task ids')
reference_count = 0
for path, line in re.findall(r'((?:desktop|docs)/[A-Za-z0-9_./-]+):(\d+)', analysis):
    target = root / path
    require(target.is_file(), f'Missing cited source: {path}')
    if target.is_file():
        require(1 <= int(line) <= len(target.read_text().splitlines()), f'Invalid source line: {path}:{line}')
    reference_count += 1
require(reference_count >= 15, 'Too few direct source references')

for name, expected in INPUTS.items():
    path = root / 'docs/0.3' / name
    require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, f'Input changed: {name}')
    if args.compare_worktree:
        original = args.compare_worktree / 'docs/0.3' / name
        require(original.read_bytes() == path.read_bytes(), f'Worktree documents differ: {name}')
branch = git('branch', '--show-current').strip()
head = git('rev-parse', 'HEAD').strip()
require(branch == BRANCH, 'Planning branch mismatch')
require(head == BASE, 'Planning baseline HEAD changed')
require(git('rev-list', '--left-right', '--count', 'main...HEAD').split() == ['0', '0'], 'Branch no longer equals the recorded main baseline')
require(subprocess.run(['git', '-C', str(root), 'merge-base', '--is-ancestor', '13b5b3d', 'HEAD']).returncode == 0, 'AI foundation is missing')
require(set(active_branch_bindings(root).get(BRANCH, ())) == {package.name}, 'Integration branch is not uniquely bound')
require(not git('diff', 'HEAD', '--name-only').strip(), 'Tracked code or source docs were modified')
prefix = package.relative_to(root).as_posix() + '/'
untracked = git('ls-files', '--others', '--exclude-standard').splitlines()
require(all(path.startswith(prefix) for path in untracked), 'Untracked output outside the planning package')
original_status_unchanged: bool | None = None
if args.compare_worktree:
    original_status = set(git('status', '--porcelain=v1', '--untracked-files=normal', cwd=args.compare_worktree).splitlines())
    original_status_unchanged = original_status == INITIAL_STATUS
    require(original_status_unchanged, 'Original worktree status changed; investigate before attributing changes')
    require(git('branch', '--show-current', cwd=args.compare_worktree).strip() == 'codex/ai-tutor-foundation', 'Original branch changed')

result = {
    'planning_valid': not errors,
    'implementation_complete': False,
    'branch': branch,
    'baseline_head': head,
    'tasks': len(records),
    'completed_implementation_tasks': sum(record.checked for record in records),
    'dependency_edges': sum(len(task_dependencies(record)) for record in records),
    'milestones': phases,
    'ready_after_implementation_authorization': ready,
    'covered_source_test_ids': sorted(coverage),
    'direct_source_references': reference_count,
    'source_document_sha256': INPUTS,
    'original_status_unchanged': original_status_unchanged,
    'modified_tracked_files': git('diff', 'HEAD', '--name-only').splitlines(),
    'errors': errors,
}
text = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
if args.output:
    output = args.output.resolve()
    if output.parent != package or output.name != 'validation.json':
        raise SystemExit('Output must be this package validation.json')
    output.write_text(text)
print(text, end='')
raise SystemExit(0 if not errors else 1)
