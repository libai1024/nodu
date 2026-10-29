'use strict';

const $ = id => document.getElementById(id);
const storageKey = 'nodu-keil-open-demo-v1';
const labels = { nodu: 'Nodu', keil: 'Keil 5' };
const samples = [
  { id: 'blink', name: 'LED 闪烁', description: '从点亮第一颗 LED 开始。', source: '#include "board.h"\n\nint main(void)\n{\n  Board_Init();\n  while (1) {\n    LED_Toggle();\n    HAL_Delay(500);\n  }\n}\n' },
  { id: 'uart', name: '串口通信', description: '让开发板说出第一句 Hello。', source: '#include "board.h"\n#include <stdio.h>\n\nint main(void)\n{\n  Board_Init();\n  while (1) {\n    printf("Hello, Nodu!\\r\\n");\n    HAL_Delay(1000);\n  }\n}\n' },
  { id: 'heartbeat', name: '状态指示灯', description: '用不同的闪烁间隔表达状态。', source: '#include "board.h"\n\nint main(void)\n{\n  Board_Init();\n  while (1) {\n    LED_Toggle();\n    HAL_Delay(200);\n    LED_Toggle();\n    HAL_Delay(800);\n  }\n}\n' }
];

let persisted = {};
try { persisted = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch {}
let projects = samples.map(sample => {
  const saved = persisted.projects?.[sample.id];
  return { ...sample, tool: saved?.tool === 'keil' ? 'keil' : 'nodu', ready: saved?.ready === true,
    source: typeof saved?.source === 'string' ? saved.source : sample.source,
    draft: typeof saved?.draft === 'string' ? saved.draft : (typeof saved?.source === 'string' ? saved.source : sample.source), used: saved?.used === true };
});
let selected = 'blink';
let currentTool = 'nodu';
let activeView = 'projects';
let busy = false;
let timers = [];
let pending = null;
let menuProject = null;
let menuTrigger = null;
let theme = persisted.theme === 'light' ? 'light' : 'dark';
let storageAvailable = true;

const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const projectById = id => projects.find(project => project.id === id);
const projectPath = project => `D:\\NoduProjects\\${project.id}`;

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ theme, projects: Object.fromEntries(projects.map(p => [p.id, { tool: p.tool, ready: p.ready, source: p.source, draft: p.draft, used: p.used }])) }));
    storageAvailable = true;
  } catch { storageAvailable = false; }
}

function setTheme() {
  document.documentElement.dataset.theme = theme;
  $('theme').querySelector('span').textContent = theme === 'dark' ? '切换浅色' : '切换深色';
}

function renderProjects() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const visible = projects.filter(p => `${p.name} ${p.id} STM32F103C8T6`.toLocaleLowerCase().includes(query));
  $('empty').hidden = visible.length !== 0;
  $('project-list').innerHTML = visible.map(p => `<article class="project-row ${selected === p.id ? 'selected' : ''}" aria-label="${p.name}">
    <button type="button" class="project-select" data-select="${p.id}" aria-label="预览${p.name}" aria-pressed="${selected === p.id}"><svg class="folder" aria-hidden="true"><use href="#i-folder"/></svg><span class="project-copy"><strong>${p.name}</strong><small>STM32F103C8T6 · ${p.id}</small></span></button>
    <div class="open-area"><div class="split-button"><button type="button" class="open-button" data-open="${p.id}" ${busy ? 'disabled' : ''}>用 ${labels[p.tool]} 打开</button><button type="button" class="open-arrow" data-menu="${p.id}" aria-label="选择${p.name}的打开方式" aria-haspopup="menu" aria-expanded="false" ${busy ? 'disabled' : ''}>${icon('chevron')}</button></div><small>${p.used ? '上次使用 ' + labels[p.tool] : '示例工程'}</small></div>
  </article>`).join('');
}

function updatePreview() {
  const p = projectById(selected);
  $('preview-name').textContent = p.name;
  $('preview-description').textContent = p.description;
  $('source-preview').textContent = p.draft;
  $('preview-path').textContent = projectPath(p);
}

function closeMenu(restoreFocus = false) {
  $('open-menu').hidden = true;
  if (menuTrigger?.isConnected) {
    menuTrigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) menuTrigger.focus();
  }
  menuTrigger = null;
}

function showMenu(id, trigger) {
  if (!$('open-menu').hidden && menuTrigger === trigger) { closeMenu(true); return; }
  closeMenu();
  menuProject = id;
  menuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  const p = projectById(id);
  $('open-menu').querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.tool === p.tool)));
  $('keil-menu-caption').textContent = p.ready ? '项目已准备，可直接打开' : '首次使用会自动准备';
  const menu = $('open-menu');
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  menu.style.left = Math.max(12, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 12)) + 'px';
  const below = rect.bottom + 8;
  menu.style.top = Math.max(12, below + menu.offsetHeight > window.innerHeight - 12 ? rect.top - menu.offsetHeight - 8 : below) + 'px';
  menu.querySelector(`[data-tool="${p.tool}"]`).focus();
}

function lockControls() {
  renderProjects();
  $('switch-tool').disabled = busy;
  $('back').disabled = busy;
  $('missing-keil').disabled = busy;
}

function clearPending() {
  timers.forEach(clearTimeout);
  timers = [];
  busy = false;
  pending = null;
  $('notice').hidden = true;
  lockControls();
}

function updateSavedState() {
  const p = projectById(selected);
  const dirty = p.draft !== p.source;
  $('dirty-mark').hidden = !dirty;
  $('save-state').textContent = dirty ? '未保存 · 切换不会丢失' : storageAvailable ? '已保存到演示' : '已保留在当前页面';
  $('save-state').classList.toggle('unsaved', dirty);
  $('save').disabled = !dirty;
}

function enterEditor(p, tool) {
  clearPending();
  selected = p.id;
  currentTool = tool;
  activeView = 'editor';
  p.tool = tool;
  p.used = true;
  persist();
  $('projects-view').hidden = true;
  $('editor-view').hidden = false;
  $('window-title').textContent = `${p.name} — ${labels[tool]}`;
  $('preview-tag').textContent = `${labels[tool]} 打开预览`;
  $('editor-project-name').textContent = p.name;
  $('editor-path').textContent = `${projectPath(p)}\\App\\main.c`;
  $('switch-tool').innerHTML = `用 ${labels[tool === 'nodu' ? 'keil' : 'nodu']} 打开${icon('chevron')}`;
  $('switch-tool').setAttribute('aria-haspopup', 'menu');
  $('switch-tool').setAttribute('aria-expanded', 'false');
  $('switch-tool').setAttribute('aria-label', '切换项目打开方式');
  $('code').value = p.draft;
  $('app-status-text').textContent = `当前：${labels[tool]}`;
  $('app-status-note').textContent = '共享同一份 main.c';
  $('demo-tip').textContent = '试着修改代码并保存，再切换打开方式，看看刚才的内容。';
  updateSavedState();
  $('code').focus({ preventScroll: true });
}

function openProject(id, tool) {
  if (busy) return;
  closeMenu();
  const p = projectById(id);
  selected = id;
  updatePreview();
  if (tool === 'keil' && $('missing-keil').checked) {
    $('notice').hidden = false;
    $('notice').classList.add('error');
    $('notice-title').textContent = '这台电脑还没有 Keil 5';
    $('notice-copy').textContent = '项目已保留，可以先用 Nodu 继续编写。';
    $('notice-action').textContent = '用 Nodu 打开';
    pending = { id, tool, error: true };
    renderProjects();
    $('notice-action').focus({ preventScroll: true });
    return;
  }
  if (tool === 'nodu' || p.ready) { enterEditor(p, tool); return; }
  busy = true;
  pending = { id, tool };
  lockControls();
  $('notice').classList.remove('error');
  $('notice').hidden = false;
  $('notice-title').textContent = '正在准备 Keil 工程…';
  $('notice-copy').textContent = `「${p.name}」首次打开，完成后自动进入。`;
  $('notice-action').textContent = '取消';
  $('progress-fill').style.width = '12%';
  $('notice-action').focus({ preventScroll: true });
  timers.push(setTimeout(() => { $('progress-fill').style.width = '58%'; }, 650));
  timers.push(setTimeout(() => { $('progress-fill').style.width = '100%'; $('notice-title').textContent = '已准备好，正在打开 Keil 5…'; }, 1350));
  timers.push(setTimeout(() => { p.ready = true; enterEditor(p, tool); }, 2050));
}

$('project-list').addEventListener('click', event => {
  const select = event.target.closest('[data-select]');
  const open = event.target.closest('[data-open]');
  const menu = event.target.closest('[data-menu]');
  if (select && !busy) { selected = select.dataset.select; closeMenu(); renderProjects(); updatePreview(); $('project-list').querySelector(`[data-select="${selected}"]`).focus({ preventScroll: true }); }
  if (open) openProject(open.dataset.open, projectById(open.dataset.open).tool);
  if (menu) showMenu(menu.dataset.menu, menu);
});
$('open-menu').addEventListener('click', event => {
  const item = event.target.closest('[data-tool]');
  if (item) openProject(menuProject, item.dataset.tool);
});
$('open-menu').addEventListener('keydown', event => {
  const options = [...$('open-menu').querySelectorAll('[data-tool]')];
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const i = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  }
  if (event.key === 'Tab') closeMenu(true);
});
document.addEventListener('click', event => { if (!event.target.closest('#open-menu, [data-menu], #switch-tool')) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('open-menu').hidden) { event.preventDefault(); closeMenu(true); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && activeView === 'editor') { event.preventDefault(); $('save').click(); }
  if (event.key === 'ArrowDown' && event.target.matches('[data-menu], #switch-tool')) { event.preventDefault(); showMenu(event.target.dataset.menu || selected, event.target); }
});
window.addEventListener('resize', () => closeMenu());
window.addEventListener('scroll', () => closeMenu(), { passive: true });
$('search').addEventListener('input', () => { closeMenu(); renderProjects(); });
$('clear-search').addEventListener('click', () => { $('search').value = ''; renderProjects(); $('search').focus(); });
$('theme').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; setTheme(); persist(); });
$('notice-action').addEventListener('click', () => {
  if (pending?.error) { openProject(pending.id, 'nodu'); return; }
  const id = pending?.id;
  clearPending();
  if (activeView === 'projects' && id) $('project-list').querySelector(`[data-open="${id}"]`)?.focus({ preventScroll: true });
  else $('switch-tool').focus({ preventScroll: true });
});
$('switch-tool').addEventListener('click', event => showMenu(selected, event.currentTarget));
$('code').addEventListener('input', () => { projectById(selected).draft = $('code').value; persist(); updateSavedState(); });
$('save').addEventListener('click', () => { const p = projectById(selected); p.source = p.draft; persist(); updateSavedState(); $('demo-tip').textContent = storageAvailable ? '代码已保存。现在换一种打开方式，内容依然在这里。' : '当前页面已保留代码；浏览器未允许本地存储，刷新后可能丢失。'; });
function backToProjects() {
  closeMenu();
  activeView = 'projects';
  $('projects-view').hidden = false;
  $('editor-view').hidden = true;
  $('window-title').textContent = 'Nodu · 项目';
  $('preview-tag').textContent = '示例工作区';
  $('app-status-text').textContent = '本地项目';
  $('app-status-note').textContent = '打开方式会为每个项目自动记住';
  $('demo-tip').textContent = '已记住这个项目的选择，下次点「打开」就会直接进入。';
  renderProjects(); updatePreview();
}
$('back').addEventListener('click', () => { backToProjects(); $('project-list').querySelector(`[data-open="${selected}"]`)?.focus({ preventScroll: true }); });
$('reset').addEventListener('click', () => {
  clearPending();
  projects = samples.map(p => ({ ...p, tool: 'nodu', ready: false, used: false, draft: p.source }));
  selected = 'blink';
  $('search').value = '';
  $('missing-keil').checked = false;
  persist();
  backToProjects();
  $('demo-tip').textContent = '演示已重置。选择「在 Keil 5 中打开」，再次体验首次自动准备。';
});
$('missing-keil').addEventListener('change', () => { if (pending?.error) clearPending(); });
setTheme(); renderProjects(); updatePreview();
if (projectById(selected).ready) {
  $('demo-tip').textContent = '这个项目已准备好，可以直接打开，也可以随时切换工具。';
}
