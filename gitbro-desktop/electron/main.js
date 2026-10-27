const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const { exec, spawn } = require('child_process');

const isDev = process.env.NODE_ENV === 'development'
let mainWindow;
let webuiProcess = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGitbroRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, '.gitbro'));
}

async function waitForWebui(port, proc, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null || proc.killed) {
      throw new Error('GitBro server stopped before it became ready');
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.status === 'gitbro api running') return data;
      }
    } catch {}

    await delay(100);
  }

  throw new Error('Timed out waiting for GitBro repository server');
}

async function launchRepoServer(repoPath, port = 5005) {
  if (!isGitbroRepo(repoPath)) {
    return { error: 'Selected folder is not a GitBro repository. Run gitbro init in that folder first.' };
  }

  if (webuiProcess) {
    webuiProcess.kill();
    webuiProcess = null;
  }

  const gitbroJs = path.join(__dirname, '../../mygit/bin/gitbro.js');
  webuiProcess = spawn(process.execPath, [gitbroJs, 'webui', '--port', String(port)], {
    cwd: repoPath,
    env: process.env
  });

  webuiProcess.on('error', (err) => {
    console.error('Background API Server Error:', err);
  });

  try {
    await waitForWebui(port, webuiProcess);
    return { path: repoPath, port, success: true };
  } catch (error) {
    if (webuiProcess) {
      webuiProcess.kill();
      webuiProcess = null;
    }
    return { error: error.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f8fafc' // slate-50 to match react
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (webuiProcess) webuiProcess.kill();
  if (process.platform !== 'darwin') app.quit()
})

// === IPC Handlers for GitBro Desktop ===

// 1. Select a Repository Native Dialog
ipcMain.handle('gitbro:selectRepo', async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select a GitBro Repository'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const selectedPath = result.filePaths[0];
  return launchRepoServer(selectedPath, 5005);
});

// 1.5 Open a Specific Repository Directly
ipcMain.handle('gitbro:openRepo', async (event, targetPath) => {
  return launchRepoServer(targetPath, 5005);
});

// 2. Direct CLI executor for quick tasks (falling back to API usually though)
ipcMain.handle('gitbro:run', async (event, command, targetCwd) => {
  return new Promise((resolve) => {
    const gitbroJs = path.join(__dirname, '../../mygit/bin/gitbro.js');
    exec(`"${process.execPath}" "${gitbroJs}" ${command}`, { cwd: targetCwd || path.join(__dirname, '../../mygit') }, (error, stdout, stderr) => {
      if (error) {
        resolve({ error: stderr || stdout || error.message });
      } else {
        resolve({ output: stdout });
      }
    });
  });
});


