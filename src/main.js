const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

let mainWindow = null;
let currentFilePath = null;

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
ipcMain.handle('app:open-path', (_evt, relativePath) => {
    try {
        const filePath = path.isAbsolute(relativePath) ? relativePath : path.join(app.getAppPath(), relativePath);

        // Check if this is a problem file that needs to be copied from starter code
        if (relativePath.startsWith('problems/') && relativePath.endsWith('.py')) {
            // Extract the filename (e.g., "binary.py" from "problems/binary.py")
            const filename = path.basename(relativePath);
            const starterFilePath = path.join(app.getAppPath(), 'starter_code', filename);

            // If the file doesn't exist in problems/ but exists in starter_code/
            if (!fs.existsSync(filePath) && fs.existsSync(starterFilePath)) {
                try {
                    // Ensure problems directory exists
                    const problemsDir = path.dirname(filePath);
                    if (!fs.existsSync(problemsDir)) {
                        fs.mkdirSync(problemsDir, { recursive: true });
                    }

                    // Copy the starter file to problems/
                    const starterContent = fs.readFileSync(starterFilePath, 'utf8');
                    fs.writeFileSync(filePath, starterContent, 'utf8');
                } catch (copyErr) {
                    return { ok: false, error: `Failed to copy starter file: ${String(copyErr)}` };
                }
            }
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
        return { ok: true, problems: parsed };
    } catch (err) {
        return { ok: false, error: String(err) };
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

        // Create the command to copy
        const command = `python run_testcases.py ${arg}`;

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

        // Create the CSV filename based on problem name
        const csvFileName = `${problemName}_log.csv`;
        const csvPath = path.join(app.getAppPath(), 'problems', csvFileName);

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


