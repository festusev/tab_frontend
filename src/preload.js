const { contextBridge, ipcRenderer } = require('electron');

function resolveCompletionsUrl() {
    const envUrl = process.env.COMPLETIONS_URL;
    const envPort = process.env.COMPLETIONS_PORT;
    if (envUrl) {
        try {
            const hasScheme = envUrl.includes('://');
            const urlObj = new URL(hasScheme ? envUrl : `http://${envUrl}`);
            if (envPort && !urlObj.port) urlObj.port = String(envPort);
            return urlObj.toString();
        } catch (_e) {
            // Fallback to plain string if URL parsing fails
            return envUrl;
        }
    }
    const host = "localhost"; // "128.32.175.196";
    const port = String(envPort || 9600);
    return `http://${host}:${port}`;
}

const DEFAULT_COMPLETIONS_URL = resolveCompletionsUrl();

// Store for current assistant selection
let currentAssistantUrl = DEFAULT_COMPLETIONS_URL;
let currentAssistantName = null;
let currentActualAssistantName = null;
// Default to 'no_assistant' to avoid misrouting before selection
let currentObfuscatedDirName = 'no_assistant';

contextBridge.exposeInMainWorld('api', {
    openFile: () => ipcRenderer.invoke('app:open'),
    saveFile: () => ipcRenderer.invoke('app:save'),
    onFileOpened: (callback) => ipcRenderer.on('file-opened', (_evt, payload) => callback(payload)),
    onFileSaved: (callback) => ipcRenderer.on('file-saved', (_evt, payload) => callback(payload)),
    setCurrentFile: (filePath) => ipcRenderer.send('app:set-current-file', filePath),
    getCompletionsUrl: () => currentAssistantUrl,
    setAssistantUrl: (url) => { currentAssistantUrl = url; },
    setAssistantName: (name) => { currentAssistantName = name; },
    setActualAssistantName: (name) => { currentActualAssistantName = name; },
    setObfuscatedDirName: (name) => { currentObfuscatedDirName = name; },
    getCurrentAssistantName: () => currentAssistantName,
    getCurrentActualAssistantName: () => currentActualAssistantName,
    getCurrentObfuscatedDirName: () => currentObfuscatedDirName,
    getAssistants: () => ipcRenderer.invoke('app:get-assistants'),
    openPath: (relativePath) => ipcRenderer.invoke('app:open-path', relativePath),
    readProblemsConfig: (relativePath) => ipcRenderer.invoke('app:read-problems-config', relativePath),
    writeFile: (relativePath, content) => ipcRenderer.invoke('app:write-file', relativePath, content),
    openExternalUrl: (url) => ipcRenderer.invoke('app:open-external', url),
    runTestcases: (problemName) => ipcRenderer.invoke('app:run-testcases', problemName),
    logKeystroke: (data) => ipcRenderer.invoke('app:log-keystroke', data)
});
