const desktopApi = window.desktop || null;

const $ = (selector) => document.querySelector(selector);

const els = {
  appHeader: $('.app-header'),
  segments: document.querySelectorAll('.segment'),
  dropzone: $('#dropzone'),
  dropTitle: $('#dropTitle'),
  dropHint: $('#dropHint'),
  fileInput: $('#fileInput'),
  filePanel: $('#filePanel'),
  fileList: $('#fileList'),
  fileCount: $('#fileCount'),
  clearBtn: $('#clearBtn'),
  formatField: $('#formatField'),
  formatPills: $('#formatPills'),
  passwordField: $('#passwordField'),
  passwordInput: $('#passwordInput'),
  togglePasswordBtn: $('#togglePasswordBtn'),
  outputLabel: $('#outputLabel'),
  outputDir: $('#outputDir'),
  outputName: $('#outputName'),
  changeDirBtn: $('#changeDirBtn'),
  progressArea: $('#progressArea'),
  progressLabel: $('#progressLabel'),
  progressPct: $('#progressPct'),
  progressFill: $('#progressFill'),
  startBtn: $('#startBtn'),
  cancelBtn: $('#cancelBtn'),
  hint: $('#hint'),
  settingsBtn: $('#settingsBtn'),
  settingsModal: $('#settingsModal'),
  defaultDirInput: $('#defaultDirInput'),
  pickDirBtn: $('#pickDirBtn'),
  cancelSettings: $('#cancelSettings'),
  saveSettings: $('#saveSettings'),
  assocGroup: $('#assocGroup'),
  assocSwitch: $('#assocSwitch'),
  defaultAppBtn: $('#defaultAppBtn'),
  uninstallGroup: $('#uninstallGroup'),
  uninstallBtn: $('#uninstallBtn'),
  portableNote: $('#portableNote'),
  windowControls: $('#windowControls'),
  toast: $('#toast'),
};

const STORAGE_KEY = 'qingya.outputDir';
const FALLBACK_DIR = '';

const state = {
  mode: 'compress',
  files: [],            // { name, size, path }
  format: 'zip',
  dir: localStorage.getItem(STORAGE_KEY) || FALLBACK_DIR,
  running: false,
  timer: null,
  progress: 0,
  unsubscribe: null,
  customName: null,     // 用户手动改过的输出文件名，null 表示沿用自动命名
};

const ICONS = {
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

/* ---------- 工具函数 ---------- */

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

function archiveSuffix() {
  return state.format === 'tar.gz' ? '.tar.gz' : `.${state.format}`;
}

function stripArchiveExt(name) {
  return name.replace(/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|zip|tar|gz|bz2|xz|7z|rar)$/i, '');
}

function baseName(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : name;
}

function isArchive(name) {
  return /\.(zip|tar|tar\.gz|tgz|gz)$/i.test(name);
}

function typeLabel(name) {
  const ext = name.includes('.') ? name.split('.').pop().toUpperCase() : '';
  return ext ? `${ext} 文件` : '文件';
}

function joinPath(dir, name) {
  return `${dir.replace(/[\\/]+$/, '')}\\${name}`;
}

function dirOf(filePath) {
  const match = /^(.+)[\\/][^\\/]+$/.exec(filePath || '');
  return match ? match[1] : '';
}

function autoOutputName() {
  if (!state.files.length) return '';
  const first = state.files[0].name;
  if (state.mode === 'compress') return `${baseName(first)}${archiveSuffix()}`;
  if (state.files.length > 1) return '各自同名的文件夹';
  return stripArchiveExt(first);
}

function outputName() {
  if (!state.files.length) return '';
  if (state.mode === 'compress' && state.customName) {
    const base = stripArchiveExt(state.customName.trim());
    if (base) return `${base}${archiveSuffix()}`;
  }
  return autoOutputName();
}

function updateUI() {
  const compress = state.mode === 'compress';

  if (!state.files.length) state.customName = null;
  els.segments.forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });

  els.dropTitle.textContent = compress ? '拖拽文件到这里' : '拖拽压缩包到这里';
  els.dropHint.textContent = compress ? '支持任意文件' : '支持 ZIP / TAR / TAR.GZ';
  els.fileInput.accept = compress ? '' : '.zip,.tar,.gz,.tgz';
  els.formatField.hidden = !compress;
  els.outputLabel.textContent = compress ? '保存到' : '解压到';
  els.startBtn.textContent = compress ? '开始压缩' : '开始解压';

  els.filePanel.hidden = state.files.length === 0;
  els.fileCount.textContent = `已添加 ${state.files.length} 个文件`;
  els.startBtn.disabled = state.files.length === 0 || state.running;
  els.cancelBtn.hidden = !state.running;

  const zipOnly = state.format === 'zip';
  els.passwordInput.disabled = compress && !zipOnly;
  if (compress && !zipOnly) {
    els.passwordInput.placeholder = 'TAR / TAR.GZ 不支持加密';
    els.passwordInput.value = '';
  } else {
    els.passwordInput.placeholder = compress
      ? '留空则不加密（ZIP AES-256）'
      : '加密压缩包需输入密码';
  }

  if (state.running) {
    els.hint.textContent = compress ? '正在压缩，请稍候…' : '正在解压，请稍候…';
  } else if (state.files.length) {
    els.hint.textContent = compress
      ? `将 ${state.files.length} 个文件打包为 ${state.format.toUpperCase()}`
      : `将解压到 ${state.dir}`;
  } else {
    els.hint.textContent = '';
  }

  renderPath();
}

function renderPath() {
  els.outputDir.textContent = state.dir || '未设置保存位置';
  const name = outputName();
  els.outputName.value = name;
  els.outputName.classList.toggle('is-empty', !name);
  els.outputName.readOnly = state.mode !== 'compress';
}

function normalizeFiles(list) {
  return Array.from(list || []).map((item) => {
    if (item instanceof File) {
      return {
        name: item.name,
        size: item.size,
        path: desktopApi ? desktopApi.getPathForFile(item) : '',
      };
    }
    return { name: item.name, size: item.size || 0, path: item.path || '' };
  });
}

function addFiles(list) {
  const incoming = normalizeFiles(list);
  if (!incoming.length) return;

  const accepted = state.mode === 'compress'
    ? incoming
    : incoming.filter((file) => isArchive(file.name));

  const skipped = incoming.length - accepted.length;
  const wasEmpty = state.files.length === 0;
  state.files.push(...accepted);

  if (wasEmpty && accepted.length) {
    const folder = dirOf(accepted[0].path);
    if (folder) {
      state.dir = folder;
      localStorage.setItem(STORAGE_KEY, folder);
    }
  }

  renderFiles();
  updateUI();

  if (skipped > 0) toast(`已忽略 ${skipped} 个非压缩包文件`);
}

function renderFiles() {
  els.fileList.replaceChildren();

  state.files.forEach((file, index) => {
    const item = document.createElement('li');
    item.className = 'file-row';

    const icon = document.createElement('span');
    icon.className = 'file-type';
    icon.innerHTML = state.mode === 'decompress' ? ICONS.archive : ICONS.file;

    const info = document.createElement('div');
    info.className = 'file-info';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.path || file.name;

    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = `${formatSize(file.size)} · ${typeLabel(file.name)}`;

    info.append(name, meta);

    const remove = document.createElement('button');
    remove.className = 'file-remove';
    remove.type = 'button';
    remove.title = '移除';
    remove.setAttribute('aria-label', `移除 ${file.name}`);
    remove.innerHTML = ICONS.close;
    remove.addEventListener('click', () => {
      state.files.splice(index, 1);
      renderFiles();
      updateUI();
    });

    item.append(icon, info, remove);
    els.fileList.append(item);
  });
}

function clearFiles() {
  state.files = [];
  renderFiles();
  updateUI();
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('is-show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    els.toast.classList.remove('is-show');
  }, 2400);
}

/* ---------- 进度 ---------- */

function setProgress(value) {
  state.progress = Math.max(0, Math.min(100, value));
  els.progressFill.style.width = `${state.progress}%`;
  els.progressPct.textContent = `${Math.round(state.progress)}%`;
}

function beginTask() {
  state.running = true;
  els.progressArea.hidden = false;
  els.progressLabel.textContent = state.mode === 'compress' ? '正在压缩…' : '正在解压…';
  setProgress(0);
  updateUI();
}

function endTask(message) {
  state.running = false;
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  els.progressArea.hidden = true;
  setProgress(0);
  updateUI();
  if (message) toast(message);
}

function completeTask(result) {
  if (result.ok) {
    setProgress(100);
    els.progressLabel.textContent = '完成';
    window.setTimeout(() => {
      endTask(state.mode === 'compress' ? '压缩完成' : '解压完成');
    }, 550);
    return;
  }
  if (result.cancelled) {
    endTask('已取消');
    return;
  }
  endTask(result.error || '操作失败');
  if (/密码/.test(result.error || '') && !els.passwordInput.disabled) {
    els.passwordInput.focus();
    els.passwordInput.select();
  }
}

function simulate() {
  beginTask();
  state.timer = window.setInterval(() => {
    setProgress(state.progress + 2 + Math.random() * 7);
    if (state.progress >= 100) {
      window.clearInterval(state.timer);
      state.timer = null;
      els.progressLabel.textContent = '完成';
      window.setTimeout(() => endTask(state.mode === 'compress' ? '压缩完成' : '解压完成'), 550);
    }
  }, 160);
}

async function startTask() {
  if (!state.files.length || state.running) return;

  if (!desktopApi) {
    simulate();
    return;
  }

  if (!state.dir) {
    toast('请先在设置里选择保存位置');
    openSettings();
    return;
  }

  if (state.files.some((file) => !file.path)) {
    toast('无法获取文件完整路径，请重新选择文件');
    return;
  }

  const password = els.passwordInput.value.trim();

  if (state.mode === 'compress') {
    const output = joinPath(state.dir, outputName());
    if (await desktopApi.exists(output)) {
      const overwrite = window.confirm(`文件已存在，是否覆盖？\n${output}`);
      if (!overwrite) return;
    }
  }

  beginTask();
  state.unsubscribe = desktopApi.onProgress(({ percent }) => setProgress(percent * 100));

  const payload = state.mode === 'compress'
    ? {
        mode: 'compress',
        format: state.format,
        output: joinPath(state.dir, outputName()),
        files: state.files.map((file) => file.path),
        ...(state.format === 'zip' && password ? { password } : {}),
      }
    : {
        mode: 'decompress',
        dir: state.dir,
        files: state.files.map((file) => ({ name: file.name, path: file.path })),
        ...(password ? { password } : {}),
      };

  let result;
  try {
    result = await desktopApi.start(payload);
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  completeTask(result);
}

function cancelTask() {
  if (!state.running) return;
  if (desktopApi) {
    desktopApi.cancel();
    return;
  }
  window.clearInterval(state.timer);
  state.timer = null;
  endTask('已取消');
}

/* ---------- 选择文件 ---------- */

async function pickFiles() {
  if (desktopApi) {
    const files = await desktopApi.pickFiles(state.mode);
    addFiles(files);
    return;
  }
  els.fileInput.click();
}

/* ---------- 设置 ---------- */

function openSettings() {
  els.settingsModal.hidden = false;
  els.defaultDirInput.value = state.dir;
  refreshSystemSettings();
  window.setTimeout(() => {
    els.defaultDirInput.focus();
    els.defaultDirInput.select();
  }, 50);
}

/* 安装版才显示系统集成项；免安装版只做说明 */
async function refreshSystemSettings() {
  if (!desktopApi || !desktopApi.appInfo) {
    els.assocGroup.hidden = true;
    els.uninstallGroup.hidden = true;
    els.portableNote.hidden = !desktopApi;
    els.portableNote.textContent = '当前版本不修改系统设置。';
    return;
  }
  try {
    const info = await desktopApi.appInfo();
    els.assocGroup.hidden = !info.installed;
    els.uninstallGroup.hidden = !info.installed;
    els.portableNote.hidden = !!info.installed;
    els.assocSwitch.setAttribute('aria-checked', String(!!info.assoc));
  } catch {
    els.assocGroup.hidden = true;
    els.uninstallGroup.hidden = true;
  }
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

function saveSettings() {
  const value = els.defaultDirInput.value.trim().replace(/[\\/]+$/, '');
  if (!value) {
    toast('请输入文件夹路径');
    return;
  }
  state.dir = value;
  localStorage.setItem(STORAGE_KEY, value);
  closeSettings();
  updateUI();
  toast('保存成功');
}

/* ---------- 事件绑定 ---------- */

function setMode(mode) {
  if (state.running || state.mode === mode) return;
  state.mode = mode;
  clearFiles();
  updateUI();
}

/* 从“打开方式”传入的压缩包：直接切到解压模式并预载 */
function openExternal(files) {
  if (!files || !files.length || state.running) return;
  state.mode = 'decompress';
  state.files = [];
  addFiles(files);
}

els.segments.forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

els.dropzone.addEventListener('click', pickFiles);

els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    pickFiles();
  }
});

['dragenter', 'dragover'].forEach((type) => {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('is-dragover');
  });
});

['dragleave', 'dragend'].forEach((type) => {
  els.dropzone.addEventListener(type, () => {
    els.dropzone.classList.remove('is-dragover');
  });
});

els.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  els.dropzone.classList.remove('is-dragover');
  addFiles(event.dataTransfer.files);
});

/* Tauri 原生拖拽（路径由 Rust 侧直接给出） */
window.addEventListener('app:drop', (event) => addFiles(event.detail));

/* 已在运行时从“打开方式”再来一个文件 */
window.addEventListener('app:open-files', (event) => openExternal(event.detail));

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

els.fileInput.addEventListener('change', () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = '';
});

els.clearBtn.addEventListener('click', clearFiles);

els.formatPills.addEventListener('click', (event) => {
  const button = event.target.closest('.pill');
  if (!button || state.running) return;
  state.format = button.dataset.format;
  els.formatPills.querySelectorAll('.pill').forEach((pill) => {
    pill.classList.toggle('is-active', pill === button);
  });
  updateUI();
});

els.outputName.addEventListener('input', () => {
  if (state.mode !== 'compress' || els.outputName.readOnly) return;
  state.customName = els.outputName.value;
  els.outputName.classList.toggle('is-empty', !els.outputName.value.trim());
});

els.outputName.addEventListener('blur', () => {
  if (state.mode !== 'compress') return;
  const base = stripArchiveExt((state.customName || '').trim());
  state.customName = base ? `${base}${archiveSuffix()}` : null;
  renderPath();
});

els.togglePasswordBtn.addEventListener('click', () => {
  const show = els.passwordInput.type === 'password';
  els.passwordInput.type = show ? 'text' : 'password';
  els.togglePasswordBtn.textContent = show ? '隐藏' : '显示';
});

els.startBtn.addEventListener('click', startTask);
els.cancelBtn.addEventListener('click', cancelTask);

els.settingsBtn.addEventListener('click', openSettings);
els.changeDirBtn.addEventListener('click', openSettings);
els.cancelSettings.addEventListener('click', closeSettings);
els.saveSettings.addEventListener('click', saveSettings);

function errorText(error) {
  if (typeof error === 'string') return error;
  return (error && error.message) || '操作失败';
}

els.assocSwitch.addEventListener('click', async () => {
  if (!desktopApi || !desktopApi.setAssoc) return;
  const next = els.assocSwitch.getAttribute('aria-checked') !== 'true';
  els.assocSwitch.disabled = true;
  try {
    const enabled = await desktopApi.setAssoc(next);
    els.assocSwitch.setAttribute('aria-checked', String(!!enabled));
    toast(enabled ? '已加入“打开方式”候选' : '已从“打开方式”移除');
  } catch (error) {
    toast(errorText(error));
  } finally {
    els.assocSwitch.disabled = false;
  }
});

els.defaultAppBtn.addEventListener('click', async () => {
  if (!desktopApi || !desktopApi.openDefaultApps) return;
  try {
    await desktopApi.openDefaultApps();
  } catch (error) {
    toast(errorText(error));
  }
});

els.uninstallBtn.addEventListener('click', async () => {
  if (!desktopApi || !desktopApi.uninstall) return;
  const confirmed = window.confirm(
    '确定要卸载 AnyCompresssionThatMayWork 吗？\n卸载后会清理“打开方式”登记和运行数据，不留残留。'
  );
  if (!confirmed) return;

  els.uninstallBtn.disabled = true;
  toast('正在卸载，程序即将退出…');
  try {
    await desktopApi.uninstall();
  } catch (error) {
    els.uninstallBtn.disabled = false;
    toast(errorText(error));
  }
});

els.pickDirBtn.addEventListener('click', async () => {
  if (!desktopApi) {
    toast('浏览器预览无法获取完整路径，桌面版会打开系统选择器');
    return;
  }
  const dir = await desktopApi.pickDirectory();
  if (dir) els.defaultDirInput.value = dir;
});

els.settingsModal.addEventListener('click', (event) => {
  if (event.target === els.settingsModal) closeSettings();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.settingsModal.hidden) closeSettings();
});

els.defaultDirInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveSettings();
});

/* ---------- 桌面壳 ---------- */

if (desktopApi) {
  document.body.classList.add('is-desktop');
  els.windowControls.hidden = false;
  els.windowControls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-win]');
    if (button) desktopApi.windowControl(button.dataset.win);
  });
  els.appHeader.addEventListener('dblclick', (event) => {
    if (!event.target.closest('button')) desktopApi.windowControl('toggleMaximize');
  });
}

async function init() {
  /* 先渲染首屏，再去做可能耗时的路径探测 */
  updateUI();

  if (!localStorage.getItem(STORAGE_KEY) && desktopApi) {
    try {
      state.dir = await desktopApi.defaultDir();
      updateUI();
    } catch {
      // 保留默认值
    }
  }

  /* 通过“打开方式”启动时，参数里带着压缩包路径 */
  if (desktopApi && desktopApi.launchFiles) {
    try {
      const files = await desktopApi.launchFiles();
      if (files && files.length) openExternal(files);
    } catch {
      // 忽略，正常启动即可
    }
  }
}

init();
