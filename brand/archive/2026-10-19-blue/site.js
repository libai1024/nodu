'use strict';

const concepts = {
  '01': {
    name: '起点',
    type: '字母与光点',
    file: 'start',
    rationale: '以小写 n 为骨架，一枚独立圆点落在右下方。像第一次点亮的 LED，也像一次动手得到的结果；厚实而开放的轮廓，让工具显得亲近、可上手。',
  },
  '02': {
    name: '台阶',
    type: '从小步到进阶',
    file: 'steps',
    rationale: '用连续上升的实心几何表达学习的节奏。每一级都能站稳，每一步都有结果；从一个简单程序开始，逐渐走向更复杂的硬件项目。',
  },
  '03': {
    name: '积木',
    type: '从点构成可能',
    file: 'blocks',
    rationale: '六个等尺寸模块组成向上的节奏，如同用基础积木搭出一个作品。模块呼应像素和数字世界，也把复杂系统还原为初学者可以理解的小单元。',
  },
  '04': {
    name: '路径',
    type: '让思路连起来',
    file: 'path',
    rationale: '一条连续折线，把起笔、转折和抵达连在一起。它借用电路走线的秩序，表达从想法、代码到硬件的连续过程，也保留尝试与转向的空间。',
  },
  '05': {
    name: '起跑门',
    type: '欢迎第一次尝试',
    file: 'gate',
    rationale: '开放的几何轮廓与一笔线条组成一道入口。形状稳定、方向明确，像一个随时欢迎进入的工作台，把第一次接触嵌入式开发变成可以迈出的动作。',
  },
  '06': {
    name: '汇合',
    type: '代码与硬件相遇',
    file: 'converge',
    rationale: '两个输入节点连接到一个结果，强调 Node 的连接含义。不同开发板可以走进同一个熟悉的开发流程，也为未来代码与硬件之间的协作留下一个开放的意象。',
  },
};

const preview = document.querySelector('#concept-preview');
const selectedMark = document.querySelector('#selected-mark');
const conceptName = document.querySelector('#concept-name');
const conceptType = document.querySelector('#concept-type');
const conceptRationale = document.querySelector('#concept-rationale');
const conceptDownload = document.querySelector('#concept-download');
const announcement = document.querySelector('#selection-announcement');
const conceptButtons = [...document.querySelectorAll('[data-concept]')];
const themeButtons = [...document.querySelectorAll('[data-preview-theme]')];

function selectConcept(id) {
  const concept = concepts[id];
  if (!concept) return;

  for (const button of conceptButtons) {
    const selected = button.dataset.concept === id;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }

  selectedMark.style.setProperty('--concept-url', `url('assets/exploration-${id}.svg')`);
  selectedMark.setAttribute('aria-label', `${concept.name}标识`);
  conceptName.firstChild.textContent = concept.name;
  conceptType.textContent = concept.type;
  conceptRationale.textContent = concept.rationale;
  conceptDownload.href = `assets/exploration-${id}.svg`;
  conceptDownload.download = `nodu-${concept.file}.svg`;
  conceptDownload.setAttribute('aria-label', `下载${concept.name}标识 SVG`);
  announcement.textContent = `已选择${concept.name}方向。${concept.type}。`;

  selectedMark.classList.remove('is-changing');
  // Restart the one authored motion when switching an already visible mark.
  void selectedMark.offsetWidth;
  selectedMark.classList.add('is-changing');
}

for (const button of conceptButtons) {
  button.addEventListener('click', () => selectConcept(button.dataset.concept));
}

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    preview.dataset.theme = button.dataset.previewTheme;
    for (const themeButton of themeButtons) {
      themeButton.setAttribute('aria-pressed', String(themeButton === button));
    }
    announcement.textContent = `标识预览已切换为${button.dataset.previewTheme === 'dark' ? '深色' : '浅色'}背景。`;
  });
}

// Arrow keys offer an additional quick comparison path; Tab also reaches every choice.
document.querySelector('.concept-list').addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const current = conceptButtons.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
  let next = (current + step + conceptButtons.length) % conceptButtons.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = conceptButtons.length - 1;
  conceptButtons[next].focus();
  selectConcept(conceptButtons[next].dataset.concept);
});

const palettes = {
  blue: { name: '蓝色', brand: '#4F7CFF', deep: '#244BB0', primary: true },
  orange: { name: '暖橙', brand: '#E98A42', deep: '#9C4B1F', primary: false },
  violet: { name: '紫色', brand: '#8B78E6', deep: '#5C43A8', primary: false },
};
const paletteButtons = [...document.querySelectorAll('[data-color-option]')];
const paletteAnnouncement = document.querySelector('#palette-announcement');

function selectPalette(id, announce = true) {
  const palette = palettes[id];
  if (!palette) return;
  document.documentElement.dataset.palette = id;

  for (const button of paletteButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.colorOption === id));
  }
  for (const image of document.querySelectorAll('[data-palette-src]')) {
    image.src = `assets/${id}/${image.dataset.paletteSrc}`;
  }
  for (const link of document.querySelectorAll('[data-palette-file]')) {
    const file = link.dataset.paletteFile;
    link.href = `assets/${id}/${file}`;
    if (link.hasAttribute('download')) {
      link.download = file.startsWith('Nodu.')
        ? `nodu-${id}.${file.split('.').pop()}`
        : `nodu-${id}-${file}`;
    }
  }
  for (const label of document.querySelectorAll('[data-palette-name]')) {
    label.textContent = palette.name;
  }
  for (const caption of document.querySelectorAll('[data-palette-caption]')) {
    caption.textContent = `${palette.name}${palette.primary ? ' · 正式主色' : ' · 对照方案'}`;
  }
  document.querySelector('#palette-brand-value').textContent = palette.brand;
  document.querySelector('#palette-deep-value').textContent = palette.deep;
  document.querySelector('#palette-status').textContent = `当前显示：${palette.name} · ${palette.primary ? '正式主色' : '对照方案'}。`;
  if (announce) {
    paletteAnnouncement.textContent = `已切换为${palette.name}${palette.primary ? '正式主色' : '对照方案'}。标识、应用图标、IDE 示意和对应下载链接已更新。`;
  }
}

for (const button of paletteButtons) {
  button.addEventListener('click', () => selectPalette(button.dataset.colorOption));
}

// Blue is the confirmed primary color; every visit starts with the official identity.
selectPalette('blue', false);
