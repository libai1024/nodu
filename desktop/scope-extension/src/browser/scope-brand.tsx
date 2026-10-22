// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { NODU_LOGO, NODU_MARK_SMALL, NODU_TOOLBAR_GLYPH, NODU_WORDMARK, NoduGlyph } from './nodu-brand';

/** The lamp's strokes: Blink Yellow dome, legs in `legs` (currentColor follows the toolbar text). */
function Lamp({ glyph, legs }: { glyph: NoduGlyph; legs: string }): React.ReactElement {
    return <>
        <path d={glyph.dome} fill="none" stroke={NODU_LOGO.dome} strokeWidth={glyph.sw} strokeLinecap="butt"/>
        <path d={glyph.legs} fill="none" stroke={legs} strokeWidth={glyph.sw} strokeLinecap="butt"/>
        {glyph.caps.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} fill={legs}/>)}
    </>;
}

/**
 * Brand v2 mark (brand/assets/mark-toolbar.svg, mark-small.svg) and wordmark, from generated geometry.
 * Dark themes show the bare lamp; light themes show the small ink tile, because Blink Yellow
 * must always sit on Chip Ink (see brand/README.md). Theia sets theia-<type> on <body>.
 */
export function NoduBrand(): React.ReactElement {
    return <div className="scope-brand" role="img" aria-label="见微 Nodu">
        <svg className="scope-brand-mark scope-brand-mark-lamp" viewBox={NODU_TOOLBAR_GLYPH.viewBox} aria-hidden="true" focusable="false">
            <Lamp glyph={NODU_TOOLBAR_GLYPH.glyph} legs="currentColor"/>
        </svg>
        <svg className="scope-brand-mark scope-brand-mark-tile" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
            <path d={NODU_MARK_SMALL.tile} fill={NODU_LOGO.tile}/>
            <g transform={NODU_MARK_SMALL.transform}><Lamp glyph={NODU_MARK_SMALL.glyph} legs={NODU_LOGO.legs}/></g>
        </svg>
        <svg className="scope-brand-name" viewBox={NODU_WORDMARK.viewBox} aria-hidden="true" focusable="false"
            fill="none" stroke="currentColor" strokeWidth={NODU_WORDMARK.strokeWidth} strokeLinecap="round" strokeLinejoin="round">
            {NODU_WORDMARK.elements.map((e, i) => e.type === 'circle'
                ? <circle key={i} cx={e.cx} cy={e.cy} r={e.r}/>
                : <path key={i} d={e.d} transform={e.transform}/>)}
        </svg>
        <span className="scope-brand-subtitle">见微</span>
    </div>;
}
