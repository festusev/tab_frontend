const filenameElem = document.getElementById('filename');
const statusElem = document.getElementById('status');
const btnOpenUrl = document.getElementById('btn-open-url');
const btnRunTestcases = document.getElementById('btn-run-testcases');
const btnBack = document.getElementById('btn-back');
const launch = document.getElementById('launch');
const userNameInput = document.getElementById('user-name');
const btnScratch = document.getElementById('btn-scratch');
const btnSurvey = document.getElementById('btn-survey');
const problemsContainer = document.getElementById('problems');
const editor = document.getElementById('editor');
const ghostEl = document.getElementById('ghost');
const measureEl = document.getElementById('editor-measure');
// debug overlay removed
const GHOST_VERTICAL_ADJUST_PX = -1;
const COMPLETION_DEBOUNCE_MS = 100;

let isDirty = false;
let currentFilePath = null;
let userName = (typeof localStorage !== 'undefined' && localStorage.getItem('user_name')) || '';
let currentProblemUrl = null;
let currentProblemName = null;
let problemSuffixToUrl = new Map(); // maps '/problems/<safe>.py' to URL

let overlayRafId = 0;
function scheduleOverlayResync() {
    if (overlayRafId) cancelAnimationFrame(overlayRafId);
    overlayRafId = requestAnimationFrame(() => {
        overlayRafId = 0;
        syncHighlightStyles();
        renderHighlight();
        renderGhost();
    });
}

function updateTitlebarButtons() {
    if (btnOpenUrl) {
        btnOpenUrl.style.display = currentProblemUrl ? 'inline-block' : 'none';
    }
    if (btnRunTestcases) {
        btnRunTestcases.style.display = currentProblemName ? 'inline-block' : 'none';
    }
}

if (btnOpenUrl) {
    btnOpenUrl.addEventListener('click', async () => {
        if (currentProblemUrl) {
            try { await window.api.openExternalUrl(currentProblemUrl); } catch (_e) { }
        }
    });
}


if (btnRunTestcases) {
    btnRunTestcases.addEventListener('click', async () => {
        if (!currentProblemName) return;

        statusElem.textContent = '[Copying Command...]';

        try {
            const result = await window.api.runTestcases(currentProblemName);
            if (result.ok) {
                statusElem.textContent = '[Command Copied to Clipboard]';
            } else {
                statusElem.textContent = '[Copy Error]';
            }
        } catch (error) {
            statusElem.textContent = '[Copy Error]';
        }
    });
}

if (btnBack) {
    btnBack.addEventListener('click', () => {
        if (launch) {
            launch.style.display = 'flex';
        }
        // Focus the user name input when returning to launch
        if (userNameInput) {
            userNameInput.focus();
        }
    });
}

function updateTitle() {
    const base = currentFilePath ? currentFilePath.split(/[\\/]/).pop() : 'untitled';
    const dirty = isDirty ? ' *' : '';
    const namePart = userName ? ` — ${userName}` : '';
    filenameElem.textContent = base + dirty + namePart;
}

function setContent(content) {
    editor.value = content || '';
    isDirty = false;
    statusElem.textContent = '[Ready]';
    updateTitle();
}

function moveCaretToEnd() {
    const len = editor.value.length;
    editor.selectionStart = len;
    editor.selectionEnd = len;
    editor.focus();
    editor.scrollTop = editor.scrollHeight;
    renderHighlight();
    renderGhost();
}

window.__getEditorContent = function () {
    return editor.value;
};

editor.addEventListener('input', () => {
    if (!isDirty) {
        isDirty = true;
        statusElem.textContent = '[Modified]';
        updateTitle();
    }
    renderHighlight();
    // Resync overlays on next frame to account for scroll changes at the bottom
    scheduleOverlayResync();
});

// Tab-completion: try server completion, fallback to inserting spaces
let isCompleting = false;
let lastCompletion = null; // { prefix, full, suffix, time }
let completionAbortController = null;
let inputDebounceTimer = null;
let suppressUntilInput = false;
let isComposing = false;

function insertSpacesAtCursor() {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const value = editor.value;
    const spaces = '    ';
    editor.value = value.substring(0, start) + spaces + value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + spaces.length;
    if (!isDirty) {
        isDirty = true;
        statusElem.textContent = '[Modified]';
        updateTitle();
    }
    renderHighlight();
    // Schedule a new suggestion after inserting spaces
    scheduleCompletionFetch();
}

function lastLineNonEmpty(prefixText) {
    const lastNewline = prefixText.lastIndexOf('\n');
    const tail = lastNewline === -1 ? prefixText : prefixText.slice(lastNewline + 1);
    return tail.trim().length > 0;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function hideGhost() {
    if (ghostEl) ghostEl.style.display = 'none';
    if (measureEl) {
        measureEl.style.visibility = 'hidden';
        measureEl.style.zIndex = '0';
    }
    // Restore normal syntax highlighting without ghost text
    renderHighlight();
}

function syncMirrorStyles() {
    if (!measureEl || !ghostEl) return;
    const cs = window.getComputedStyle(editor);
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing'];
    props.forEach(p => {
        measureEl.style[p] = cs[p];
        ghostEl.style[p] = cs[p];
    });
    measureEl.style.paddingTop = cs.paddingTop;
    measureEl.style.paddingRight = cs.paddingRight;
    measureEl.style.paddingBottom = cs.paddingBottom;
    measureEl.style.paddingLeft = cs.paddingLeft;
    measureEl.style.whiteSpace = 'pre-wrap';
    // Match exact dimensions to avoid wrap differences
    measureEl.style.width = editor.clientWidth + 'px';
    measureEl.style.height = editor.clientHeight + 'px';
}


function renderGhost() {
    if (!ghostEl || !measureEl || !highlightEl) return;
    syncMirrorStyles();
    const caret = editor.selectionStart;
    const selectionEmpty = editor.selectionStart === editor.selectionEnd;
    const prefixText = editor.value.slice(0, caret);
    if (!selectionEmpty || !lastCompletion || lastCompletion.prefix !== prefixText || !lastCompletion.suffix) {
        hideGhost();
        return;
    }
    const ghostText = lastCompletion.suffix;

    // Create text with ghost completion inserted
    const fullTextWithGhost = prefixText + ghostText + editor.value.slice(caret);

    // Apply syntax highlighting to the full text
    const highlightedHtml = highlightPython(fullTextWithGhost);

    // Split the highlighted HTML to insert ghost styling
    const prefixHighlighted = highlightPython(prefixText);
    const ghostHighlighted = highlightPython(ghostText);
    const afterText = editor.value.slice(caret);
    const afterHighlighted = highlightPython(afterText);

    // Wrap the ghost portion with ghost styling
    const ghostWrapped = '<span class="ghost-text">' + ghostHighlighted + '</span>';

    // Update the highlight element with ghost text included
    highlightEl.innerHTML = prefixHighlighted + ghostWrapped + afterHighlighted;

    // Ensure highlight scroll stays in sync
    if (highlightEl.scrollTop !== editor.scrollTop) highlightEl.scrollTop = editor.scrollTop;
    if (highlightEl.scrollLeft !== editor.scrollLeft) highlightEl.scrollLeft = editor.scrollLeft;

    // Hide the separate ghost element since we're showing inline
    ghostEl.style.display = 'none';
}

async function fetchCompletion(prefixText, opts) {
    const insert = !!(opts && opts.insert);
    const baseUrl = (window.api && window.api.getCompletionsUrl) ? window.api.getCompletionsUrl() : null;
    const url = baseUrl ? (baseUrl.endsWith('/') ? baseUrl : baseUrl + '/') : null;
    if (!url) {
        if (insert) insertSpacesAtCursor();
        return null;
    }
    try {
        if (completionAbortController) completionAbortController.abort();
        completionAbortController = new AbortController();
        isCompleting = true;
        if (insert) statusElem.textContent = '[Completing…]';
        const body = JSON.stringify([prefixText]);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: completionAbortController.signal
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const raw = await res.text();
        let predicted = '';
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) predicted = String(parsed[0] ?? '');
            else if (typeof parsed === 'string') predicted = parsed;
            else if (parsed && typeof parsed.text === 'string') predicted = parsed.text;
        } catch (_e) {
            predicted = raw;
        }
        const suffixStart = prefixText.length;
        let suffix = String(predicted).slice(suffixStart);
        if (suffix.startsWith(' ') && lastLineNonEmpty(prefixText)) suffix = suffix.slice(1);
        lastCompletion = { prefix: prefixText, full: predicted, suffix, time: Date.now() };

        // Log the proposed suggestion if there's actual content to suggest
        if (suffix && suffix.trim()) {
            setTimeout(() => logKeystroke('proposed_suggestion', suffix), 0);
        }

        renderGhost();
        if (insert) {
            if (!suffix) {
                insertSpacesAtCursor();
                statusElem.textContent = '[No completion]';
            } else {
                const start = editor.selectionStart;
                const end = editor.selectionEnd;
                const value = editor.value;
                editor.value = value.substring(0, start) + suffix + value.substring(end);
                editor.selectionStart = editor.selectionEnd = start + suffix.length;
                isDirty = true;
                statusElem.textContent = '[Completed]';
                updateTitle();
                hideGhost();
                renderHighlight();

                // Log the accepted suggestion (auto-insertion)
                setTimeout(() => logKeystroke('accepted_suggestion', suffix), 0);
            }
        }
        return suffix;
    } catch (_err) {
        if (insert) {
            insertSpacesAtCursor();
            statusElem.textContent = '[Completion failed]';
        }
        return null;
    } finally {
        isCompleting = false;
    }
}

function maybeFetchCompletion(prefixText, opts) {
    if (suppressUntilInput) return null;
    return fetchCompletion(prefixText, opts);
}

function scheduleCompletionFetch() {
    if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(() => {
        const prefixText = editor.value.slice(0, editor.selectionStart);
        maybeFetchCompletion(prefixText, { insert: false });
        renderGhost();
    }, COMPLETION_DEBOUNCE_MS);
}

editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const prefixText = editor.value.slice(0, editor.selectionStart);
        if (lastCompletion && lastCompletion.prefix === prefixText && lastCompletion.suffix) {
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const value = editor.value;
            const acceptedText = lastCompletion.suffix;
            editor.value = value.substring(0, start) + acceptedText + value.substring(end);
            editor.selectionStart = editor.selectionEnd = start + acceptedText.length;
            isDirty = true;
            statusElem.textContent = '[Completed]';
            updateTitle();
            hideGhost();
            renderHighlight();

            // Log the accepted suggestion
            setTimeout(() => logKeystroke('accepted_suggestion', acceptedText), 0);

            // Chain next suggestion after accept (debounced)
            scheduleCompletionFetch();
        } else {
            insertSpacesAtCursor();
        }
    }
});

// Always query when user types (debounced)
editor.addEventListener('input', () => {
    // Allow fetching again after a new keystroke
    suppressUntilInput = false;
    scheduleCompletionFetch();
});

// ESC to reject current suggestion and pause fetching until next input
editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        e.preventDefault();
        hideGhost();
        lastCompletion = null;
        suppressUntilInput = true;
        if (completionAbortController) {
            try { completionAbortController.abort(); } catch (_e) { }
        }
    }
});

// Keep ghost aligned on scroll/caret/resize
editor.addEventListener('scroll', renderGhost);
editor.addEventListener('click', renderGhost);
editor.addEventListener('keyup', (e) => {
    const navigational = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key);
    if (navigational) renderGhost();
});
window.addEventListener('resize', () => { syncMirrorStyles(); renderGhost(); });
window.addEventListener('resize', () => { syncHighlightStyles(); renderHighlight(); });
// Resync when editor box size changes (e.g., scrollbars appear/disappear)
if (window.ResizeObserver) {
    const editorResizeObserver = new ResizeObserver(() => {
        scheduleOverlayResync();
    });
    try { editorResizeObserver.observe(editor); } catch (_e) { }
}
editor.addEventListener('keydown', (e) => {
    const keysThatMayAffectLayout = [
        'Backspace', 'Delete', 'Enter',
        'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
        'Home', 'End', 'PageUp', 'PageDown'
    ];
    if (keysThatMayAffectLayout.includes(e.key)) {
        // Layout can change before input/scroll events fire; resync next frame
        scheduleOverlayResync();
    }
});

// Keep overlays accurate during IME composition
editor.addEventListener('compositionstart', () => {
    isComposing = true;
    suppressUntilInput = true;
    hideGhost();
});
editor.addEventListener('compositionend', () => {
    isComposing = false;
    suppressUntilInput = false;
    scheduleOverlayResync();
    scheduleCompletionFetch();
});

// Resync when selection moves programmatically (no key/input events)
document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) {
        scheduleOverlayResync();
    }
});


// Simple Python syntax highlighting
const highlightEl = document.getElementById('highlight');

const PY_KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

function highlightPython(text) {
    const lines = text.split('\n');
    const out = [];
    const kw = (w) => `<span class="tok-kw">${w}</span>`;
    const str = (s) => `<span class="tok-str">${s}</span>`;
    const com = (c) => `<span class="tok-com">${c}</span>`;
    const num = (n) => `<span class="tok-num">${n}</span>`;
    const id = (t) => t;
    for (let line of lines) {
        let html = '';
        let i = 0;
        let inStr = false;
        let quote = '';
        while (i < line.length) {
            const ch = line[i];
            if (!inStr && ch === '#') {
                html += com(escapeHtml(line.slice(i)));
                i = line.length;
                break;
            }
            if (!inStr && (ch === '"' || ch === '\'')) {
                inStr = true; quote = ch; html += str(escapeHtml(ch)); i++; continue;
            }
            if (inStr) {
                html += str(escapeHtml(ch));
                if (ch === quote && line[i - 1] !== '\\') { inStr = false; }
                i++;
                continue;
            }
            // number
            if (/\d/.test(ch)) {
                let j = i + 1; while (j < line.length && /[\d_\.]/.test(line[j])) j++;
                html += num(escapeHtml(line.slice(i, j)));
                i = j; continue;
            }
            // identifier/keyword
            if (/[A-Za-z_]/.test(ch)) {
                let j = i + 1; while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
                const token = line.slice(i, j);
                html += PY_KEYWORDS.has(token) ? kw(escapeHtml(token)) : id(escapeHtml(token));
                i = j; continue;
            }
            // default
            html += escapeHtml(ch);
            i++;
        }
        out.push(html);
    }
    return out.join('\n');
}

function syncHighlightStyles() {
    if (!highlightEl) return;
    const cs = window.getComputedStyle(editor);
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing'];
    props.forEach(p => { highlightEl.style[p] = cs[p]; });
    highlightEl.style.paddingTop = cs.paddingTop;
    highlightEl.style.paddingRight = cs.paddingRight;
    highlightEl.style.paddingBottom = cs.paddingBottom;
    highlightEl.style.paddingLeft = cs.paddingLeft;
}

function renderHighlight() {
    if (!highlightEl) return;
    highlightEl.innerHTML = highlightPython(editor.value);
    // Ensure overlay scroll stays exactly in sync
    if (highlightEl.scrollTop !== editor.scrollTop) highlightEl.scrollTop = editor.scrollTop;
    if (highlightEl.scrollLeft !== editor.scrollLeft) highlightEl.scrollLeft = editor.scrollLeft;
}

editor.addEventListener('scroll', () => {
    if (highlightEl) {
        highlightEl.scrollTop = editor.scrollTop;
        highlightEl.scrollLeft = editor.scrollLeft;
    }
    renderGhost();
});

// Keybindings similar to nano
document.addEventListener('keydown', async (e) => {
    const ctrl = e.ctrlKey || e.metaKey; // support Cmd on macOS
    if (!ctrl) return;
    if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        await window.api.saveFile();
    } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        await window.api.saveFile();
    } else if (e.key.toLowerCase() === 'x') {
        e.preventDefault();
        // Attempt to close the window if not dirty, or prompt
        if (isDirty) {
            const confirmLeave = confirm('Buffer modified. Save before exit?');
            if (confirmLeave) {
                await window.api.saveFile();
            }
        }
        window.close();
    } else if (e.key.toLowerCase() === 'g') {
        e.preventDefault();
        alert('Nano-like shortcuts:\n\n^O WriteOut (Save)\n^S Save\n^R Open\n^X Exit');
    } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        await window.api.openFile();
    }
});

window.api.onFileOpened(({ filePath, content }) => {
    currentFilePath = filePath;
    window.api.setCurrentFile(filePath);
    setContent(content);
    updateTitle();
    moveCaretToEnd();
    scheduleOverlayResync();

    // Update current problem name for keystroke logging
    updateCurrentProblemForLogging(filePath);

    // Determine if this opened file corresponds to a known problem and update buttons
    try {
        const appPath = '' + filePath; // ensure string
        let matchedUrl = null;
        let matchedProblemName = null;

        // Check if this is a problem file
        const problemsMatch = appPath.match(/\/problems\/([^\/]+)\.py$/);
        if (problemsMatch) {
            const fileName = problemsMatch[1];
            // Map from filename to problem name used in testcases
            const fileNameToProblemName = {
                'transducer': 'transducer',
                'lava': 'lava',
                'binary': 'binary',
                'merge': 'merge',
                'cancel': 'cancel',
                'vector': 'vector'
            };
            matchedProblemName = fileNameToProblemName[fileName] || null;
        }

        // Check for problem URL mapping
        for (const [suffix, url] of problemSuffixToUrl.entries()) {
            if (appPath.endsWith(suffix)) { matchedUrl = url; break; }
        }

        currentProblemUrl = matchedUrl;
        currentProblemName = matchedProblemName;
        updateTitlebarButtons();
    } catch (_e) {
        currentProblemUrl = null;
        currentProblemName = null;
        updateTitlebarButtons();
    }
});

window.api.onFileSaved(({ filePath }) => {
    currentFilePath = filePath;
    isDirty = false;
    statusElem.textContent = '[Saved]';
    updateTitle();
});

// start
setContent('');
syncHighlightStyles();
renderHighlight();

// Disable mouse-based caret movement and text selection, but allow focus restoration
let lastCaretPosition = 0;

function blockMouseSelection(e) {
    // Allow right-click context menu if needed; block left/middle
    if (e.type === 'contextmenu') return;

    // For click events, restore focus and caret position but don't move cursor
    if (e.type === 'click') {
        e.preventDefault();
        e.stopPropagation();
        // Store current caret position before focusing
        lastCaretPosition = editor.selectionStart || 0;
        // Focus the editor to show the caret
        editor.focus();
        // Restore the last caret position
        editor.selectionStart = lastCaretPosition;
        editor.selectionEnd = lastCaretPosition;
        return;
    }

    // Block all other mouse events
    e.preventDefault();
    e.stopPropagation();
}

// Track caret position changes from keyboard input
editor.addEventListener('keyup', (e) => {
    const navigational = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key);
    if (navigational) {
        lastCaretPosition = editor.selectionStart;
    }
});

editor.addEventListener('input', () => {
    lastCaretPosition = editor.selectionStart;
});

editor.addEventListener('mousedown', blockMouseSelection);
editor.addEventListener('mouseup', blockMouseSelection);
editor.addEventListener('click', blockMouseSelection);
editor.addEventListener('dblclick', blockMouseSelection);
editor.addEventListener('selectstart', blockMouseSelection);
editor.addEventListener('dragstart', blockMouseSelection);
editor.addEventListener('mousemove', (e) => {
    if (e.buttons) { e.preventDefault(); e.stopPropagation(); }
});

// Keep keyboard UX: focus editor
editor.focus();

// Keystroke tracking functionality
let currentProblemNameForLogging = null;
let actionCount = 0;

// Function to extract problem name from file path for logging
function extractProblemNameFromPath(filePath) {
    if (!filePath) return null;

    // Check if this is a scratchpad file
    if (filePath.includes('scratchpad.py')) {
        return 'scratchpad';
    }

    // Check if this is a problem file in the problems directory
    const match = filePath.match(/\/problems\/([^\/]+)\.py$/);
    if (match) {
        return match[1]; // Return the filename without extension
    }

    return null;
}

// Function to log keystroke data
async function logKeystroke(actionType, actionInfo = '') {
    if (!currentProblemNameForLogging) return;

    try {
        const timestamp = new Date().toISOString();
        const caretIndex = editor.selectionStart || 0;

        await window.api.logKeystroke({
            problemName: currentProblemNameForLogging,
            timestamp: timestamp,
            actionType: actionType,
            actionInfo: actionInfo,
            caretIndex: caretIndex
        });

        // Increment action count and save code snapshot every 100 actions
        actionCount++;
        if (actionCount % 100 === 0) {
            await logCurrentCode();
        }
    } catch (error) {
        console.error('Failed to log keystroke:', error);
    }
}

// Function to log current code content
async function logCurrentCode() {
    if (!currentProblemNameForLogging) return;

    try {
        const timestamp = new Date().toISOString();
        const caretIndex = editor.selectionStart || 0;
        const codeContent = editor.value || '';

        await window.api.logKeystroke({
            problemName: currentProblemNameForLogging,
            timestamp: timestamp,
            actionType: 'current_code',
            actionInfo: codeContent,
            caretIndex: caretIndex
        });
    } catch (error) {
        console.error('Failed to log current code:', error);
    }
}

// Track character typing and backspace using input event
editor.addEventListener('input', (e) => {
    if (!currentProblemNameForLogging) return;

    if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
        // Character typed - use setTimeout to capture state after DOM update
        const char = e.data || '';
        if (char) {
            setTimeout(() => logKeystroke('character_typed', char), 0);
        }
    } else if (e.inputType === 'deleteContentBackward') {
        // Backspace pressed - use setTimeout to capture state after DOM update
        setTimeout(() => logKeystroke('deletion', '1'), 0);
    } else if (e.inputType === 'deleteContentForward') {
        // Delete key pressed - use setTimeout to capture state after DOM update
        setTimeout(() => logKeystroke('deletion', '1'), 0);
    }
});

// Block bulk deletion shortcuts - only allow single character deletion
editor.addEventListener('keydown', (e) => {
    // Block bulk deletion shortcuts while preserving single character deletion
    if (e.key === 'Backspace' || e.key === 'Delete') {
        // Block if any modifier keys are pressed - this prevents:
        // - Option+Delete/Backspace (word deletion)
        // - Cmd+Delete/Backspace (line deletion) 
        // - Ctrl+Delete/Backspace (word/line deletion on Windows/Linux)
        // - Shift+Delete/Backspace (which can delete selections)
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    }
});

// Track arrow key movements
editor.addEventListener('keydown', (e) => {
    if (!currentProblemNameForLogging) return;

    // Track arrow key movements - use setTimeout to capture state after DOM update
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        const direction = e.key.replace('Arrow', '').toLowerCase();
        setTimeout(() => logKeystroke('arrow_key', direction), 0);
    }
});

// Update current problem name when file is opened
function updateCurrentProblemForLogging(filePath) {
    currentProblemNameForLogging = extractProblemNameFromPath(filePath);

    // Reset action count and log initial code state
    if (currentProblemNameForLogging) {
        actionCount = 0;
        // Use setTimeout to ensure editor content is updated
        setTimeout(() => logCurrentCode(), 100);
    }
}

// debug overlay removed

// Launch screen logic
(async function initLaunch() {
    try {
        // Load problems config from starter_code/problems.json if present
        const res = await window.api.readProblemsConfig('starter_code/problems.json');
        const problems = (res && res.ok && Array.isArray(res.problems)) ? res.problems : [];
        // Build quick lookup from opened file suffix to the problem URL
        problemSuffixToUrl = new Map();
        for (const p of problems) {
            const safeName = (p.problem_name || p.name || 'problem').replace(/[^A-Za-z0-9_\-]/g, '_');
            const suffix = `/problems/${safeName}.py`;
            if (p.url) problemSuffixToUrl.set(suffix, p.url);
        }
        // Build UI
        if (launch) launch.style.display = 'flex';
        if (userNameInput && userName) userNameInput.value = userName;
        function setUserName(name) {
            userName = String(name || '').trim();
            try { localStorage.setItem('user_name', userName); } catch (_e) { }
            updateTitle();
        }
        if (userNameInput) {
            userNameInput.addEventListener('change', () => setUserName(userNameInput.value));
            userNameInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') setUserName(userNameInput.value); });
        }
        if (btnScratch) {
            btnScratch.addEventListener('click', async () => {
                if (userNameInput) setUserName(userNameInput.value);
                if (launch) launch.style.display = 'none';
                await window.api.openPath('problems/scratchpad.py');
            });
        }
        if (btnSurvey) {
            btnSurvey.addEventListener('click', async () => {
                try {
                    await window.api.openExternalUrl('https://forms.gle/KhxH5U9eDMDzMmVb6');
                } catch (error) {
                    console.error('Failed to open survey form:', error);
                }
            });
        }
        if (Array.isArray(problems) && problemsContainer) {
            problemsContainer.innerHTML = '';
            for (const p of problems) {
                const btn = document.createElement('button');
                // Prefer showing the problem's name; fall back to url then generic label
                btn.textContent = p.problem_name || p.name || p.url || 'Problem';
                btn.addEventListener('click', async () => {
                    if (userNameInput) setUserName(userNameInput.value);
                    if (launch) launch.style.display = 'none';
                    // Use the problem's name to derive the filename; fall back to generic
                    const safeName = (p.problem_name || p.name || 'problem').replace(/[^A-Za-z0-9_\-]/g, '_');
                    await window.api.openPath(`problems/${safeName}.py`);
                    currentProblemUrl = p.url || null;
                    // Set the problem name for testcase running
                    currentProblemName = p.problem_name || p.name || null;
                    updateTitlebarButtons();
                    // Also open the problem URL in the default browser, if present
                    const url = p.url;
                    if (url && typeof url === 'string') {
                        try { await window.api.openExternalUrl(url); } catch (_e) { }
                    }
                });
                problemsContainer.appendChild(btn);
            }
        }
        // Focus name input first
        if (userNameInput) userNameInput.focus();
    } catch (_e) {
        // If config missing, still show scratchpad option
        if (launch) launch.style.display = 'flex';
        if (userNameInput && userName) userNameInput.value = userName;
        function setUserName(name) {
            userName = String(name || '').trim();
            try { localStorage.setItem('user_name', userName); } catch (_e2) { }
            updateTitle();
        }
        if (userNameInput) {
            userNameInput.addEventListener('change', () => setUserName(userNameInput.value));
            userNameInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') setUserName(userNameInput.value); });
        }
        if (btnScratch) {
            btnScratch.addEventListener('click', async () => {
                if (userNameInput) setUserName(userNameInput.value);
                if (launch) launch.style.display = 'none';
                await window.api.openPath('problems/scratchpad.py');
            });
        }
    }
})();


