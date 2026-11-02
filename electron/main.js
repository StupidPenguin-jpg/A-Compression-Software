const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let currentChild = null;
let cancelled = false;

/* 绿色版：配置与缓存放在 exe 同目录的 data 下，整个文件夹拷走也能带着设置，且不写 C 盘 */
if (app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) {
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const dataDir = path.join(base, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
  } catch {
    // 所在目录不可写（例如放在只读介质）时退回系统默认位置
  }
}

function cliPath() {
  const packaged = path.join(process.resourcesPath, 'cli', 'compressor-cli.exe');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'cli', 'compressor-cli.exe');
}

function stripArchiveExt(name) {
  return name.replace(/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|zip|tar|gz|bz2|xz|7z|rar)$/i, '');
}

/* 结束正在运行的压缩核心（含子进程树），窗口关闭/退出时调用 */
function killChild() {
  const child = currentChild;
  if (!child) return;
  currentChild = null;
  try {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } catch {
    // taskkill 不可用时退化为直接结束进程
  }
  try {
    child.kill();
  } catch {
    // 进程已退出
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 720,
    minHeight: 620,
    frame: false,
    backgroundColor: '#fbfaf7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'web', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => killChild());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function sendProgress(percent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('task:progress', { percent });
  }
}

function runCli(args, mapPercent) {
  return new Promise((resolve) => {
    const child = spawn(cliPath(), args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentChild = child;

    let buffer = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === 'progress') {
            const ratio = message.total > 0 ? message.processed / message.total : 0;
            sendProgress(mapPercent(Math.max(0, Math.min(1, ratio))));
          }
        } catch {
          // 忽略非 JSON 输出
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      currentChild = null;
      resolve({ code: -1, stderr: `无法启动压缩核心：${error.message}（${cliPath()}）` });
    });

    child.on('close', (code) => {
      currentChild = null;
      resolve({ code, stderr });
    });
  });
}

app.whenReady().then(() => {
  ipcMain.handle('app:defaultDir', () => path.join(app.getPath('documents'), 'Compression'));

  ipcMain.handle('dialog:pickFiles', async (event, mode) => {
    const filters = mode === 'decompress'
      ? [{ name: '压缩包', extensions: ['zip', 'tar', 'gz', 'tgz'] }]
      : [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters,
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => {
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        size = 0;
      }
      return { name: path.basename(filePath), size, path: filePath };
    });
  });

  ipcMain.handle('dialog:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? '' : result.filePaths[0];
  });

  ipcMain.handle('fs:exists', (event, target) => {
    try {
      return fs.existsSync(target);
    } catch {
      return false;
    }
  });

  ipcMain.handle('task:start', async (event, payload) => {
    if (currentChild) return { ok: false, error: '已有任务在运行' };
    cancelled = false;
    sendProgress(0);

    try {
      if (payload.mode === 'compress') {
        fs.mkdirSync(path.dirname(payload.output), { recursive: true });
        const args = ['compress', payload.format, payload.output, ...payload.files];
        if (payload.password) args.push('--password', payload.password);
        const result = await runCli(args, (ratio) => ratio);
        if (result.code === 0) return { ok: true, output: payload.output };
        return cancelled
          ? { ok: false, cancelled: true }
          : { ok: false, error: result.stderr.trim() || '压缩失败' };
      }

      const items = payload.files;
      for (let index = 0; index < items.length; index += 1) {
        if (cancelled) return { ok: false, cancelled: true };
        const item = items[index];
        const outdir = path.join(payload.dir, stripArchiveExt(item.name));
        const args = ['decompress', item.path, outdir];
        if (payload.password) args.push('--password', payload.password);
        const result = await runCli(args, (ratio) => (index + ratio) / items.length);
        if (result.code !== 0) {
          return cancelled
            ? { ok: false, cancelled: true }
            : { ok: false, error: result.stderr.trim() || `解压失败：${item.name}` };
        }
      }
      return { ok: true, output: payload.dir };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.on('task:cancel', () => {
    if (!currentChild) return;
    cancelled = true;
    const child = currentChild;
    try {
      child.stdin.write('cancel\n');
    } catch {
      // 输入端已关闭
    }
    setTimeout(() => {
      if (currentChild === child) killChild();
    }, 3000);
  });

  ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('win:toggleMaximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('win:close', () => mainWindow && mainWindow.close());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killChild();
});

app.on('will-quit', () => {
  killChild();
});
