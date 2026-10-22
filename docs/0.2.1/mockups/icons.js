// Inline icon set for the static mockups: <i data-i="name"></i> becomes a 16 px stroke SVG.
// Placeholder shapes until the brand session's icon set lands (UI-DESIGN.md §12).
'use strict';
const ICONS = {
    folder: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
    file: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
    chevron: '<path d="M5 6.5l3 3 3-3"/>',
    right: '<path d="M6.5 5l3 3-3 3"/>',
    build: '<path d="M9.5 2.5l4 4-1.5 1.5-4-4z"/><path d="M8 4L2.5 9.5l4 4L12 8"/>',
    play: '<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>',
    files: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
    panel: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 9.5h12"/>',
    more: '<circle cx="4" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>',
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    xcircle: '<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>',
    warn: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
    circle: '<circle cx="8" cy="8" r="5.5"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    open: '<path d="M2 4.5h4l1.5 1.5H14"/><path d="M2 4.5V12.5h10.5L14 7H4z"/>',
    spark: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2"/>',
    chip: '<rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2"/>',
    usb: '<path d="M8 2v10"/><path d="M6 4l2-2 2 2"/><path d="M8 9l-3-2V5.5M8 10.5l3-2V7"/><circle cx="8" cy="13" r="1.2"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
    refresh: '<path d="M13 8a5 5 0 11-1.5-3.6"/><path d="M13 2.5V5h-2.5"/>',
    pause: '<path d="M6 4v8M10 4v8"/>',
    copy: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10.5V3h7.5"/>',
    clear: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
    save: '<path d="M8 2.5v7M5 7l3 3 3-3M3 12.5h10"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    hex: '<path d="M5 3L2 8l3 5h6l3-5-3-5z"/>',
    send: '<path d="M2.5 8L13 3l-3 10-2.5-4z"/>',
    terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5l2 1.5-2 1.5M8.5 10H11"/>',
    download: '<path d="M8 2.5v8M5 7.5l3 3 3-3"/><path d="M3 13h10"/>',
    shield: '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/>',
    book: '<path d="M3 3h4a1.5 1.5 0 011.5 1.5V13A1.5 1.5 0 007 11.5H3zM13 3H9.5A1.5 1.5 0 008 4.5V13a1.5 1.5 0 011.5-1.5H13z"/>',
    link: '<path d="M9.5 3H13v3.5M13 3L7.5 8.5"/><path d="M11 9.5V13H3V5h3.5"/>'
};
// Toolbar mark copied from brand/proposals/2026-10-21/masters/mark-toolbar.svg (proposal, not final).
const MARK = '<svg class="mark" viewBox="21.75 21.75 56.5 69" aria-label="Nodu"><path fill="none" stroke="#FFC23D" stroke-width="17.5" d="M31.5 50A18.5 18.5 0 0 1 68.5 50"/>'
    + '<path fill="none" stroke="currentColor" stroke-width="17.5" d="M31.5 54.5V81M68.5 54.5V72"/><circle cx="31.5" cy="81" r="8.75" fill="currentColor"/><circle cx="68.5" cy="72" r="8.75" fill="currentColor"/></svg>';
for (const el of document.querySelectorAll('.mark-slot')) { el.outerHTML = MARK; }
for (const el of document.querySelectorAll('i[data-i]')) {
    const svg = `<svg class="i" viewBox="0 0 16 16" aria-hidden="true">${ICONS[el.dataset.i] || ''}</svg>`;
    el.outerHTML = svg;
}
