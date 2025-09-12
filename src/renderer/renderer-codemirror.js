import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

// DOM elements
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
const assistantSelect = document.getElementById('assistant-select');
const editorContainer = document.getElementById('editor-container');

// Global state
let isDirty = false;
let currentFilePath = null;
let userName = (typeof localStorage !== 'undefined' && localStorage.getItem('user_name')) || '';
let currentProblemUrl = null;
let currentProblemName = null;
let problemSuffixToUrl = new Map();
let editor = null;
let currentCompletion = null;
let completionAbortController = null;
let isCompleting = false;
let suppressUntilInput = false;

// Completion configuration
const COMPLETION_DEBOUNCE_MS = 100;
let inputDebounceTimer = null;

// Keystroke tracking
let currentProblemNameForLogging = null;
let actionCount = 0;

// Custom completion source for AI completions
function createCompletionSource() {
    return async (context) => {
        const prefixText = context.state.doc.toString().slice(0, context.pos);

        if (suppressUntilInput || isCompleting) {
            return null;
        }

        try {
            if (completionAbortController) completionAbortController.abort();
            completionAbortController = new AbortController();
            isCompleting = true;

            const baseUrl = (window.api && window.api.getCompletionsUrl) ? window.api.getCompletionsUrl() : null;
            const url = baseUrl ? (baseUrl.endsWith('/') ? baseUrl : baseUrl + '/') : null;

            if (!url) {
                return null;
            }

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
            } catch (parseError) {
                predicted = raw;
            }

            const suffixStart = prefixText.length;
            let suffix = String(predicted).slice(suffixStart);

            // Remove leading space if last line is non-empty
            const lastNewline = prefixText.lastIndexOf('\n');
            const tail = lastNewline === -1 ? prefixText : prefixText.slice(lastNewline + 1);
            if (suffix.startsWith(' ') && tail.trim().length > 0) {
                suffix = suffix.slice(1);
            }

            if (suffix && suffix.trim()) {
                currentCompletion = { prefix: prefixText, suffix, time: Date.now() };

                // Log the proposed suggestion
                setTimeout(() => logKeystroke('proposed_suggestion', suffix), 0);

                return {
                    from: context.pos,
                    to: context.pos,
                    options: [{
                        label: suffix,
                        type: 'text',
                        apply: (view, completion, from, to) => {
                            view.dispatch({
                                changes: { from, to, insert: suffix },
                                selection: { anchor: from + suffix.length }
                            });

                            // Log the accepted suggestion
                            setTimeout(() => logKeystroke('accepted_suggestion', suffix), 0);

                            // Mark as dirty and update status
                            if (!isDirty) {
                                isDirty = true;
                                statusElem.textContent = '[Modified]';
                                updateTitle();
                            }

                            // Schedule next completion
                            scheduleCompletionFetch();
                        }
                    }]
                };
            }

            return null;
        } catch (err) {
            if (err.name === 'AbortError') {
                return null;
            }
            console.log('Completion error:', err.name, err.message, err);
            return null;
        } finally {
            isCompleting = false;
        }
    };
}

// Schedule completion fetch with debouncing
function scheduleCompletionFetch() {
    if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(() => {
        if (editor && !suppressUntilInput && !isCompleting) {
            // Trigger completion
            editor.dispatch({
                effects: EditorView.scrollIntoView(editor.state.selection.main.head)
            });
        }
    }, COMPLETION_DEBOUNCE_MS);
}

// Initialize CodeMirror editor
function initializeEditor() {
    if (editor) {
        // Editor already initialized
        return;
    }

    const extensions = [
        basicSetup,
        python(),
        oneDark,
        autocompletion({
            override: [createCompletionSource()]
        }),
        keymap.of([
            ...completionKeymap,
            {
                key: 'Tab',
                run: (view) => {
                    // Handle tab completion or insert spaces
                    const { state } = view;
                    const { from, to } = state.selection.main;

                    if (from !== to) {
                        // Selection exists, don't handle tab
                        return false;
                    }

                    // Check if there's a completion available
                    const completions = view.state.facet(autocompletion).override;
                    if (completions && completions.length > 0) {
                        // Let the default completion handler take over
                        return false;
                    }

                    // Insert 4 spaces
                    view.dispatch({
                        changes: { from, to, insert: '    ' },
                        selection: { anchor: from + 4 }
                    });

                    if (!isDirty) {
                        isDirty = true;
                        statusElem.textContent = '[Modified]';
                        updateTitle();
                    }

                    scheduleCompletionFetch();
                    return true;
                }
            },
            {
                key: 'Escape',
                run: (view) => {
                    suppressUntilInput = true;
                    currentCompletion = null;
                    if (completionAbortController) {
                        try { completionAbortController.abort(); } catch (_e) { }
                    }
                    return true;
                }
            }
        ]),
        EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                if (!isDirty) {
                    isDirty = true;
                    statusElem.textContent = '[Modified]';
                    updateTitle();
                }

                // Allow fetching again after a new keystroke
                suppressUntilInput = false;
                scheduleCompletionFetch();

                // Log keystrokes
                update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                    if (inserted.length > 0) {
                        const text = inserted.toString();
                        if (text.length === 1) {
                            setTimeout(() => logKeystroke('character_typed', text), 0);
                        }
                    } else if (fromA !== toA) {
                        setTimeout(() => logKeystroke('deletion', '1'), 0);
                    }
                });
            }

            if (update.selectionSet) {
                // Log arrow key movements
                const { from, to } = update.state.selection.main;
                if (from !== to) {
                    // Selection changed, could be arrow key
                    setTimeout(() => logKeystroke('arrow_key', 'selection'), 0);
                }
            }
        })
    ];

    editor = new EditorView({
        doc: '',
        extensions,
        parent: editorContainer
    });

    // Focus the editor
    editor.focus();
}

// Utility functions
function updateTitle() {
    const base = currentFilePath ? currentFilePath.split(/[\\/]/).pop() : 'untitled';
    const dirty = isDirty ? ' *' : '';
    const assistantName = window.api.getCurrentAssistantName();
    const namePart = assistantName ? ` — ${assistantName}` : '';
    filenameElem.textContent = base + dirty + namePart;
}

function setContent(content) {
    if (editor) {
        editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: content || '' }
        });
    }
    isDirty = false;
    statusElem.textContent = '[Ready]';
    updateTitle();
}

function moveCaretToEnd() {
    if (editor) {
        const docLength = editor.state.doc.length;
        editor.dispatch({
            selection: { anchor: docLength },
            effects: EditorView.scrollIntoView(docLength)
        });
        editor.focus();
    }
}

window.__getEditorContent = function () {
    return editor ? editor.state.doc.toString() : '';
};

// Event handlers
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
    btnBack.addEventListener('click', async () => {
        // Show launch screen and hide editor
        if (launch) {
            launch.style.display = 'flex';
        }
        if (editorContainer) {
            editorContainer.style.display = 'none';
        }
        await loadAssistants();
        if (userNameInput) {
            userNameInput.focus();
        }
    });
}

// Keybindings similar to nano
document.addEventListener('keydown', async (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;

    if (e.key.toLowerCase() === 'o' || e.key.toLowerCase() === 's') {
        e.preventDefault();
        await window.api.saveFile();
    } else if (e.key.toLowerCase() === 'x') {
        e.preventDefault();
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

// File operations
window.api.onFileOpened(({ filePath, content }) => {
    // Initialize editor if not already done
    initializeEditor();

    // Show editor and hide launch screen
    if (editorContainer) editorContainer.style.display = 'block';
    if (launch) launch.style.display = 'none';

    currentFilePath = filePath;
    window.api.setCurrentFile(filePath);
    setContent(content);
    updateTitle();
    moveCaretToEnd();
    updateCurrentProblemForLogging(filePath);

    // Determine if this opened file corresponds to a known problem
    try {
        const appPath = '' + filePath;
        let matchedUrl = null;
        let matchedProblemName = null;

        const problemsMatch = appPath.match(/\/problems\/([^\/]+)\.py$/);
        if (problemsMatch) {
            const fileName = problemsMatch[1];
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

// Keystroke tracking functionality
function extractProblemNameFromPath(filePath) {
    if (!filePath) return null;

    if (filePath.includes('scratchpad.py')) {
        return 'scratchpad';
    }

    const match = filePath.match(/\/problems\/[^\/]+\/([^\/]+)\.py$/);
    if (match) {
        return match[1];
    }

    return null;
}

async function logKeystroke(actionType, actionInfo = '') {
    if (!currentProblemNameForLogging) return;

    try {
        const timestamp = new Date().toISOString();
        const caretIndex = editor ? editor.state.selection.main.head : 0;

        await window.api.logKeystroke({
            problemName: currentProblemNameForLogging,
            timestamp: timestamp,
            actionType: actionType,
            actionInfo: actionInfo,
            caretIndex: caretIndex
        });

        actionCount++;
        if (actionCount % 100 === 0) {
            await logCurrentCode();
        }
    } catch (error) {
        console.error('Failed to log keystroke:', error);
    }
}

async function logCurrentCode() {
    if (!currentProblemNameForLogging) return;

    try {
        const timestamp = new Date().toISOString();
        const caretIndex = editor ? editor.state.selection.main.head : 0;
        const codeContent = editor ? editor.state.doc.toString() : '';

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

function updateCurrentProblemForLogging(filePath) {
    currentProblemNameForLogging = extractProblemNameFromPath(filePath);

    if (currentProblemNameForLogging) {
        actionCount = 0;
        setTimeout(() => logCurrentCode(), 100);
    }
}

// Function to shuffle array in place
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Function to load and populate assistants dropdown
async function loadAssistants() {
    try {
        const assistantsRes = await window.api.getAssistants();
        const assistants = (assistantsRes && assistantsRes.ok && Array.isArray(assistantsRes.assistants)) ? assistantsRes.assistants : [];

        // Get current assistant select element (may have been refreshed)
        const currentAssistantSelect = document.getElementById('assistant-select');

        // Populate assistant dropdown
        if (currentAssistantSelect && Array.isArray(assistants)) {
            currentAssistantSelect.innerHTML = '';
            const currentAssistantName = window.api.getCurrentAssistantName();
            let selectedIndex = 0;

            // Get saved assistant from localStorage
            const savedAssistant = localStorage.getItem('selected_assistant');

            // Always add "No Assistant" option first
            const noAssistantOption = document.createElement('option');
            noAssistantOption.value = 'na';
            noAssistantOption.textContent = 'No Assistant';
            noAssistantOption.dataset.assistantData = JSON.stringify({
                name: 'No Assistant',
                url: 'na',
                displayName: 'No Assistant',
                actualName: 'No Assistant',
                obfuscatedDirName: 'no_assistant'
            });
            currentAssistantSelect.appendChild(noAssistantOption);

            // Check if "No Assistant" should be selected
            if (savedAssistant === 'No Assistant' || (!savedAssistant && currentAssistantName === 'No Assistant')) {
                selectedIndex = 0;
            }

            // Handle assistant name obfuscation
            let assistantMappings = {};
            let obfuscatedAssistants = [];

            try {
                // Try to read existing mapping file
                const mappingRes = await window.api.readProblemsConfig('problems/mapping_do_not_read.json');
                if (mappingRes && mappingRes.ok && mappingRes.content) {
                    assistantMappings = JSON.parse(mappingRes.content);

                    // Create obfuscated assistants in the order specified by the mapping
                    const mappingEntries = Object.entries(assistantMappings);
                    mappingEntries.sort((a, b) => {
                        const aNum = parseInt(a[0].replace('Assistant ', ''));
                        const bNum = parseInt(b[0].replace('Assistant ', ''));
                        return aNum - bNum;
                    });

                    for (const [obfuscatedName, mappingData] of mappingEntries) {
                        // Handle both old format (string) and new format (object)
                        const actualName = typeof mappingData === 'string' ? mappingData : mappingData.actualName;
                        const obfuscatedDirName = typeof mappingData === 'string' ?
                            `assistant_${parseInt(obfuscatedName.replace('Assistant ', ''))}` :
                            mappingData.obfuscatedDirName;

                        const originalAssistant = assistants.find(a => a.name === actualName);
                        if (originalAssistant) {
                            obfuscatedAssistants.push({
                                ...originalAssistant,
                                displayName: obfuscatedName,
                                actualName: actualName,
                                obfuscatedDirName: obfuscatedDirName
                            });
                        }
                    }
                } else {
                    // Mapping file doesn't exist, create it with shuffled assistants
                    const shuffledAssistants = shuffleArray(assistants);

                    // Create mapping object
                    for (let i = 0; i < shuffledAssistants.length; i++) {
                        const obfuscatedName = `Assistant ${i + 1}`;
                        const actualName = shuffledAssistants[i].name;
                        const obfuscatedDirName = `assistant_${i + 1}`;
                        assistantMappings[obfuscatedName] = {
                            actualName: actualName,
                            obfuscatedDirName: obfuscatedDirName
                        };

                        obfuscatedAssistants.push({
                            ...shuffledAssistants[i],
                            displayName: obfuscatedName,
                            actualName: actualName,
                            obfuscatedDirName: obfuscatedDirName
                        });
                    }

                    // Write the mapping file
                    try {
                        await window.api.writeFile('problems/mapping_do_not_read.json', JSON.stringify(assistantMappings, null, 2));
                    } catch (writeError) {
                        console.error('Failed to write mapping file:', writeError);
                    }
                }
            } catch (mappingError) {
                console.error('Error handling assistant mappings:', mappingError);
                // Fallback to original assistants if mapping fails
                obfuscatedAssistants = assistants.map((a, index) => ({
                    ...a,
                    displayName: a.name,
                    actualName: a.name,
                    obfuscatedDirName: `assistant_${index + 1}`
                }));
            }

            obfuscatedAssistants.forEach((assistant, index) => {
                const option = document.createElement('option');
                option.value = assistant.url;
                option.textContent = assistant.displayName;
                option.dataset.assistantData = JSON.stringify({
                    name: assistant.actualName,
                    url: assistant.url,
                    displayName: assistant.displayName,
                    obfuscatedDirName: assistant.obfuscatedDirName || `assistant_${index + 1}`
                });

                // Adjust index by 1 since we added "No Assistant" first
                const adjustedIndex = index + 1;

                // Prioritize localStorage for persistence, fall back to current assistant name
                if (savedAssistant && assistant.displayName === savedAssistant) {
                    selectedIndex = adjustedIndex;
                } else if (!savedAssistant && currentAssistantName && assistant.actualName === currentAssistantName) {
                    selectedIndex = adjustedIndex;
                }

                currentAssistantSelect.appendChild(option);
            });

            // Remove any existing change listeners to avoid duplicates
            const newSelect = currentAssistantSelect.cloneNode(true);
            currentAssistantSelect.parentNode.replaceChild(newSelect, currentAssistantSelect);
            const refreshedSelect = document.getElementById('assistant-select');

            // Set the current/saved or first assistant as selected on the refreshed element
            if (refreshedSelect) {
                refreshedSelect.selectedIndex = selectedIndex;

                const selectedOption = refreshedSelect.options[selectedIndex];
                if (selectedOption) {
                    const assistantData = JSON.parse(selectedOption.dataset.assistantData);
                    window.api.setAssistantUrl(assistantData.url);
                    // Use the display name (obfuscated) for the title bar and UI
                    window.api.setAssistantName(assistantData.displayName || assistantData.name);
                    // Store the actual name for file operations
                    window.api.setActualAssistantName(assistantData.name);
                    // Store the obfuscated directory name for file operations
                    window.api.setObfuscatedDirName(assistantData.obfuscatedDirName);
                    // Store the display name in localStorage for UI consistency
                    localStorage.setItem('selected_assistant', assistantData.displayName || assistantData.name);
                    updateTitle(); // Update the title to show the assistant name
                }
            }

            // Handle assistant selection changes
            if (refreshedSelect) {
                refreshedSelect.addEventListener('change', () => {
                    const selectedOption = refreshedSelect.options[refreshedSelect.selectedIndex];
                    if (selectedOption) {
                        const assistantData = JSON.parse(selectedOption.dataset.assistantData);
                        window.api.setAssistantUrl(selectedOption.value);
                        // Use the display name (obfuscated) for the title bar and UI
                        window.api.setAssistantName(assistantData.displayName || assistantData.name);
                        // Store the actual name for file operations
                        window.api.setActualAssistantName(assistantData.name);
                        // Store the obfuscated directory name for file operations
                        window.api.setObfuscatedDirName(assistantData.obfuscatedDirName);
                        // Store the display name in localStorage for UI consistency
                        localStorage.setItem('selected_assistant', assistantData.displayName || assistantData.name);
                        updateTitle(); // Update the title to show the new assistant name
                    }
                });
            }
        }
    } catch (error) {
        console.error('Failed to load assistants:', error);
    }
}

// Launch screen logic
(async function initLaunch() {
    try {
        console.log('Initializing launch screen...');

        // Load assistants first
        await loadAssistants();
        console.log('Assistants loaded');

        // Load problems config
        const res = await window.api.readProblemsConfig('starter_code/problems.json');
        console.log('Problems config result:', res);

        const problems = (res && res.ok && Array.isArray(res.problems)) ? res.problems : [];
        problemSuffixToUrl = new Map();
        for (const p of problems) {
            const safeName = (p.problem_name || p.name || 'problem').replace(/[^A-Za-z0-9_\-]/g, '_');
            const suffix = `/problems/${safeName}.py`;
            if (p.url) problemSuffixToUrl.set(suffix, p.url);
        }

        // Show launch screen
        if (launch) {
            launch.style.display = 'flex';
            console.log('Launch screen displayed');
        }

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
                btn.textContent = p.problem_name || p.name || p.url || 'Problem';
                btn.addEventListener('click', async () => {
                    if (userNameInput) setUserName(userNameInput.value);
                    if (launch) launch.style.display = 'none';
                    const safeName = (p.problem_name || p.name || 'problem').replace(/[^A-Za-z0-9_\-]/g, '_');
                    await window.api.openPath(`problems/${safeName}.py`);
                    currentProblemUrl = p.url || null;
                    currentProblemName = p.problem_name || p.name || null;
                    updateTitlebarButtons();
                });
                problemsContainer.appendChild(btn);
            }
        }

        if (userNameInput) userNameInput.focus();
        console.log('Launch screen initialization complete');
    } catch (error) {
        console.error('Error initializing launch screen:', error);

        // Fallback initialization
        try {
            await loadAssistants();
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
        } catch (fallbackError) {
            console.error('Fallback initialization also failed:', fallbackError);
        }
    }
})();

// Editor will be initialized when a file is opened
