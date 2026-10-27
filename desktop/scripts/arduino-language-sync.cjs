// SPDX-License-Identifier: MIT
// ALS 0.7.7 mixes byte and UTF-16 offsets and corrupts maps on multiline edits.
// Preserve fast ASCII edits; resynchronize exact text for unsafe changes.
exports.arduinoLineChange = (before, after) => {
    if (before === after) return undefined;
    if (typeof before !== 'string') return { reopen: true };
    const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const oldLines = lines(before), newLines = lines(after);
    let start = 0, tail = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
    while (tail < oldLines.length - start && tail < newLines.length - start
        && oldLines[oldLines.length - tail - 1] === newLines[newLines.length - tail - 1]) tail++;
    const oldPart = oldLines.slice(start, oldLines.length - tail), newPart = newLines.slice(start, newLines.length - tail);
    if (oldPart.length !== 1 || newPart.length !== 1 || /[^\x00-\x7f]/.test(oldPart[0] + newPart[0])
        || oldPart[0].endsWith('\n') !== newPart[0].endsWith('\n')) return { reopen: true };
    const oldLine = oldPart[0], newLine = newPart[0]; let left = 0, right = 0;
    while (left < oldLine.length && left < newLine.length && oldLine[left] === newLine[left]) left++;
    while (right < oldLine.length - left && right < newLine.length - left && oldLine[oldLine.length - right - 1] === newLine[newLine.length - right - 1]) right++;
    return { change: { range: { start: { line: start, character: left }, end: { line: start, character: oldLine.length - right } }, text: newLine.slice(left, newLine.length - right) } };
};
exports.createArduinoResyncGate = (onError = () => {}) => {
    let epoch = 0, started = -1, pending, release, reject, timer, failure;
    return {
        mark() { epoch++; failure = undefined; if (!pending) { pending = new Promise((resolve, fail) => { release = resolve; reject = fail; }); pending.catch(() => {}); }
            clearTimeout(timer);timer=setTimeout(()=>{failure=new Error('Arduino 编辑器重新索引超时，请重新启动编辑器服务。');const fail=reject;pending=release=reject=undefined;fail?.(failure);onError(failure);},90000); },
        progress(token, value) {
            if (token !== 'arduinoLanguageServerRebuild') return;
            if (value.kind === 'begin') started = epoch;
            if (value.kind === 'end' && started === epoch && pending) { clearTimeout(timer);const done = release; pending = release = reject = undefined; done(); }
        },
        wait() { return pending || (failure ? Promise.reject(failure) : Promise.resolve()); },
        isPending() { return !!pending; },
        dispose() { clearTimeout(timer);release?.(); pending = release = reject = failure = undefined; started = -1; epoch++; },
    };
};
// Modified ALS handles UTF-16 and ordinary body line changes. Changes crossing a
// top-level declaration still require fresh preprocessing (upstream prototype maps).
exports.arduinoPatchedChange = (before, after) => {
    if (before === after) return undefined;
    if (typeof before !== 'string') return { reopen: true };
    let start=0, end=before.length, last=after.length;
    while(start<end&&start<last&&before[start]===after[start]) start++;
    if(start>0&&/[\uDC00-\uDFFF]/.test(before[start]||after[start]||'')) start--;
    while(end>start&&last>start&&before[end-1]===after[last-1]) {end--;last--;}
    if(/[\uDC00-\uDFFF]/.test(before[end]||after[last]||'')) {end++;last++;}
    const position=offset=>{const lines=before.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};};
    const change={range:{start:position(start),end:position(end)},text:after.slice(start,last)};
    if (/\r/.test(before.slice(start,end)+change.text)||/\\\r?\n/.test(before + after)) return {reopen:true};
    const multiline=before.slice(start,end).includes('\n')||change.text.includes('\n');
    if(multiline && (/[/*\\]/.test(before[start-1]||'') || /(?:\/\/|\/\*|\*\/)/.test((before[end-1]||'')+(before[end]||'')) || /(?:\/\/|\/\*|\*\/)/.test((after[last-1]||'')+(after[last]||'')))) return {reopen:true};
    // Only recognize an unambiguous top-level function body. Namespace/class/
    // initializer braces and macro-dependent layouts deliberately resynchronize.
    const walk=(text,initial={depth:0,mode:'code',body:false,segment:''},inside=false)=>{
        const state={...initial};
        for(let i=0;i<text.length;i++){
            const c=text[i],next=text[i+1];
            if(state.mode==='line'){if(c==='\n')state.mode='code';continue;}
            if(state.mode==='block'){if(c==='*'&&next==='/'){state.mode='code';i++;}continue;}
            if(state.mode==='quote'||state.mode==='char'){if(c==='\\'){i++;continue;}if(c===(state.mode==='quote'?'"':"'"))state.mode='code';continue;}
            if((c==='R'&&next==='"')||c==='#')return undefined;
            if(c==='/'&&next==='/'){state.mode='line';i++;continue;}
            if(c==='/'&&next==='*'){state.mode='block';i++;continue;}
            if(c==='"'){state.mode='quote';continue;}if(c==="'"){state.mode='char';continue;}
            if(c==='{'){
                if(state.depth===0){const declaration=state.segment.trim();state.body=/\b[A-Za-z_]\w*\s*\(/.test(declaration)&&/\)\s*(?:const\s*)?(?:noexcept\s*)?$/.test(declaration)&&!/[=;\[\]]/.test(declaration)&&!/^(namespace|class|struct|union|enum)\b/.test(declaration);state.segment='';}
                state.depth++;
            }else if(c==='}') {state.depth--;if(state.depth===0){state.body=false;state.segment='';}}
            else if(state.depth===0){if(c===';')state.segment='';else state.segment+=c;}
            if(inside&&(!state.body||state.depth<=0))return undefined;
        }
        return state;
    };
    // Only ordinary, single-line includes are irrelevant to brace scanning.
    // Macros, conditionals and continuations need Arduino preprocessing.
    const prefix=before.slice(0,start).replace(/^[ \t]*#[^\n]*$/gm,line=>{
        if(/^[ \t]*#[ \t]*include[ \t]+[^\\]*$/.test(line))return '';
        // Common pin/baud constants cannot inject scope-changing tokens.
        if(/^[ \t]*#[ \t]*define[ \t]+[A-Za-z_]\w*[ \t]+(?:[+-]?(?:0[xX][\da-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)[uUlLfF]*|"[^"{}\\]*"|'[^'{}\\]')[ \t]*(?:\/\/[^{}\\]*)?$/.test(line))return '';
        return line;
    });
    const state=walk(prefix);
    if(!state||!state.body||state.depth<=0)return {reopen:true};
    if(!multiline&&!/[{}#]/.test(before.slice(start,end)+change.text)&&!/(?:^|[^A-Za-z_])R"/.test(change.text))return {change};
    const oldState=walk(before.slice(start,end),state,true),newState=walk(change.text,state,true);
    const commentReturn=state.mode==='line'&&oldState?.mode==='line'&&newState?.mode==='code'&&change.text.includes('\n');
    if(!oldState||!newState||oldState.depth!==newState.depth||(!commentReturn&&oldState.mode!==newState.mode))return {reopen:true};
    return {change};
};
