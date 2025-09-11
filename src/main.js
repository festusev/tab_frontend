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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});


