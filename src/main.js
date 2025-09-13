const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

let mainWindow = null;
let currentFilePath = null;

// Determine verbose suggestion logging
function getNpmOriginalArgs() {
    try {
        const raw = process.env.npm_config_argv;
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed && parsed.original) ? parsed.original : [];
    } catch (_e) {
        return [];
    }
}

function isVerboseEnabled() {
    const argv = Array.isArray(process.argv) ? process.argv.slice(2) : [];
    const npmOriginal = getNpmOriginalArgs();
    const allArgs = [...argv, ...npmOriginal];
    const flag = allArgs.includes('-v') || allArgs.includes('--verbose');
    const envVerbose = process.env.VERBOSE === '1' || process.env.APP_VERBOSE === '1';
    const debug = String(process.env.DEBUG || '');
    const debugEnabled = /(\*|suggest|completion)/i.test(debug);
    return flag || envVerbose || debugEnabled;
}

const SUGGESTION_VERBOSE = isVerboseEnabled();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        fullscreen: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    const template = [
        {
            label: 'File',
            submenu: [
                { label: 'Open', accelerator: 'CmdOrCtrl+O', click: () => openFile() },
                { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => saveFile() },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'View',
            submenu: [
                {
                    label: 'Toggle Developer Tools',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: () => {
                        if (mainWindow.webContents.isDevToolsOpened()) {
                            mainWindow.webContents.closeDevTools();
                        } else {
                            mainWindow.webContents.openDevTools();
                        }
                    }
                }
            ]
        }
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

async function openFile() {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Text Files', extensions: ['txt', 'md', 'json', 'log', '*'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return;
    const filePath = result.filePaths[0];
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        currentFilePath = filePath;
        mainWindow.webContents.send('file-opened', { filePath, content: data });
    } catch (err) {
        dialog.showErrorBox('Open Error', String(err));
    }
}

async function saveFile() {
    const content = await mainWindow.webContents.executeJavaScript('window.__getEditorContent && window.__getEditorContent()');
    if (!currentFilePath) {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Save File',
            defaultPath: 'untitled.txt'
        });
        if (result.canceled || !result.filePath) return;
        currentFilePath = result.filePath;
    }
    try {
        fs.writeFileSync(currentFilePath, content, 'utf8');
        mainWindow.webContents.send('file-saved', { filePath: currentFilePath });
    } catch (err) {
        dialog.showErrorBox('Save Error', String(err));
    }
}

ipcMain.handle('app:open', openFile);
ipcMain.handle('app:save', saveFile);
ipcMain.on('app:set-current-file', (_evt, filePath) => {
    currentFilePath = filePath;
});

// Open a file by path relative to app root
ipcMain.handle('app:open-path', async (_evt, relativePath) => {
    try {
        // Get current obfuscated directory name from renderer for file operations
        const obfuscatedDirName = await mainWindow.webContents.executeJavaScript('window.api.getCurrentObfuscatedDirName()');
        // Default to 'no_assistant' if nothing is selected yet
        const safeAssistantName = obfuscatedDirName ? obfuscatedDirName.replace(/[^A-Za-z0-9_\-]/g, '_') : 'no_assistant';

        let filePath;

        // Check if this is a problem file that needs to be copied from starter code
        if (relativePath.startsWith('problems/') && relativePath.endsWith('.py')) {
            // Extract the filename (e.g., "binary.py" from "problems/binary.py")
            const filename = path.basename(relativePath);
            const starterFilePath = path.join(app.getAppPath(), 'starter_code', filename);

            // Create assistant-specific path: problems/<assistant>/filename.py
            const assistantProblemsDir = path.join(app.getAppPath(), 'problems', safeAssistantName);
            filePath = path.join(assistantProblemsDir, filename);

            // If the file doesn't exist in problems/<assistant>/ but exists in starter_code/
            if (!fs.existsSync(filePath) && fs.existsSync(starterFilePath)) {
                try {
                    // Ensure assistant-specific problems directory exists
                    if (!fs.existsSync(assistantProblemsDir)) {
                        fs.mkdirSync(assistantProblemsDir, { recursive: true });
                    }

                    // Copy the starter file to problems/<assistant>/
                    const starterContent = fs.readFileSync(starterFilePath, 'utf8');
                    fs.writeFileSync(filePath, starterContent, 'utf8');
                } catch (copyErr) {
                    return { ok: false, error: `Failed to copy starter file: ${String(copyErr)}` };
                }
            }
        } else {
            // For other files, use the original logic
            filePath = path.isAbsolute(relativePath) ? relativePath : path.join(app.getAppPath(), relativePath);
        }

        const data = fs.readFileSync(filePath, 'utf8');
        currentFilePath = filePath;
        mainWindow.webContents.send('file-opened', { filePath, content: data });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
});

// Read problems config json
ipcMain.handle('app:read-problems-config', (_evt, configRelativePath) => {
    try {
        const filePath = path.isAbsolute(configRelativePath)
            ? configRelativePath
            : path.join(app.getAppPath(), configRelativePath);
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return { ok: true, problems: parsed, content: raw };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
});

// Write file
ipcMain.handle('app:write-file', (_evt, relativePath, content) => {
    try {
        const filePath = path.isAbsolute(relativePath)
            ? relativePath
            : path.join(app.getAppPath(), relativePath);

        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, content, 'utf8');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
});

// Function to read active assistants from active_assistants.txt
function readActiveAssistants() {
    try {
        const activeAssistantsPath = path.join(app.getAppPath(), 'active_assistants.txt');
        if (!fs.existsSync(activeAssistantsPath)) {
            // If file doesn't exist, return all assistants (backward compatibility)
            return null;
        }
        const raw = fs.readFileSync(activeAssistantsPath, 'utf8');
        const activeNames = raw.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        return activeNames;
    } catch (err) {
        console.error('Failed to read active_assistants.txt:', err);
        return null;
    }
}

// Get assistants configuration
ipcMain.handle('app:get-assistants', (_evt) => {
    try {
        const filePath = path.join(app.getAppPath(), 'assistants.json');
        const raw = fs.readFileSync(filePath, 'utf8');
        const allAssistants = JSON.parse(raw);

        // Filter assistants based on active_assistants.txt
        const activeNames = readActiveAssistants();
        let assistants = allAssistants;

        if (activeNames !== null) {
            // Filter to only include assistants whose names are in active_assistants.txt
            assistants = allAssistants.filter(assistant =>
                activeNames.includes(assistant.name)
            );
        }

        return { ok: true, assistants };
    } catch (err) {
        // Return default assistant if file doesn't exist or can't be read
        const defaultAssistant = {
            name: "Default",
            url: "http://localhost:9600",
            port: 9600
        };
        return { ok: true, assistants: [defaultAssistant] };
    }
});

// Open a URL in the user's default browser
ipcMain.handle('app:open-external', async (_evt, url) => {
    try {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            return { ok: false, error: 'Invalid URL' };
        }
        await shell.openExternal(url);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
});

// Copy testcase command to clipboard
ipcMain.handle('app:run-testcases', async (_evt, problemName) => {
    try {
        const { clipboard } = require('electron');

        // Map problem names to command line arguments
        const problemArgMap = {
            'transducer': '--transducer',
            'lava': '--lava',
            'binary': '--binary_search',
            'merge': '--merge',
            'cancel': '--cancel',
            'vector': '--vector'
        };

        const arg = problemArgMap[problemName];
        if (!arg) {
            return { ok: false, error: `Unknown problem: ${problemName}` };
        }

        // Get the current file path to use as the solution file
        const currentFile = currentFilePath;
        if (!currentFile) {
            return { ok: false, error: 'No file is currently open' };
        }

        // Create the command to copy with the solution file path
        const command = `python run_testcases.py ${arg} --solution "${currentFile}"`;

        // Copy to clipboard
        clipboard.writeText(command);

        return { ok: true, command };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
});

// Log keystroke data to CSV files
ipcMain.handle('app:log-keystroke', async (_evt, { problemName, timestamp, actionType, actionInfo, caretIndex }) => {
    try {
        if (!problemName || !timestamp || !actionType) {
            return { ok: false, error: 'Missing required parameters' };
        }

        // Get current obfuscated directory name from renderer for file operations
        const obfuscatedDirName = await mainWindow.webContents.executeJavaScript('window.api.getCurrentObfuscatedDirName()');
        // Default to 'no_assistant' if nothing is selected yet
        const safeAssistantName = obfuscatedDirName ? obfuscatedDirName.replace(/[^A-Za-z0-9_\-]/g, '_') : 'no_assistant';

        // Create the CSV filename based on problem name
        const csvFileName = `${problemName}_log.csv`;
        const assistantProblemsDir = path.join(app.getAppPath(), 'problems', safeAssistantName);
        const csvPath = path.join(assistantProblemsDir, csvFileName);

        // Ensure assistant-specific problems directory exists
        if (!fs.existsSync(assistantProblemsDir)) {
            fs.mkdirSync(assistantProblemsDir, { recursive: true });
        }

        // Escape any tabs or newlines in the action info for CSV format
        const escapedActionInfo = (actionInfo || '').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

        // Create the log entry
        const logEntry = `${timestamp}\t${actionType}\t${escapedActionInfo}\t${caretIndex || 0}\n`;

        // Check if file exists to determine if we need to write header
        const fileExists = fs.existsSync(csvPath);

        // If file doesn't exist, create it with header
        if (!fileExists) {
            const header = 'timestamp\taction_type\taction_info\tcaret_index\n';
            fs.writeFileSync(csvPath, header, 'utf8');
        }

        // Append the log entry
        fs.appendFileSync(csvPath, logEntry, 'utf8');

        return { ok: true };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
});

// Log suggestion lifecycle info to terminal for debugging/telemetry
ipcMain.handle('app:log-suggestion-event', async (_evt, payload) => {
    try {
        if (!SUGGESTION_VERBOSE) {
            return { ok: true };
        }
        const {
            phase, // 'retrieved'
            timestamp,
            shown, // boolean
            prefixMatches, // boolean
            suffixLength, // number
            preview, // string (optional)
            prefixLength // number (optional)
        } = payload || {};

        const ts = timestamp || new Date().toISOString();
        const ph = phase || 'retrieved';
        const shownStr = typeof shown === 'boolean' ? String(shown) : 'unknown';
        const pmStr = typeof prefixMatches === 'boolean' ? String(prefixMatches) : 'unknown';
        const lenStr = typeof suffixLength === 'number' ? String(suffixLength) : 'unknown';
        const preLenStr = typeof prefixLength === 'number' ? ` prefix_len=${prefixLength}` : '';
        const prevStr = preview ? ` preview="${preview}"` : '';

        console.log(`[suggestion] ts=${ts} phase=${ph} shown=${shownStr} prefix_match=${pmStr} suffix_len=${lenStr}${preLenStr}${prevStr}`);
        return { ok: true };
    } catch (err) {
        // Ensure we never throw from logging
        console.warn('Failed to log suggestion event:', err);
        return { ok: false, error: String(err) };
    }
});

app.whenReady().then(() => {
    // Ensure problems directory exists at startup
    try {
        const problemsDir = path.join(app.getAppPath(), 'problems');
        if (!fs.existsSync(problemsDir)) {
            fs.mkdirSync(problemsDir, { recursive: true });
        }
    } catch (err) {
        console.error('Failed to create problems directory:', err);
    }

    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
