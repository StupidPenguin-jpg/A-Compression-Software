/* Tauri 桌面壳桥接：把 window.desktop 映射到 Rust 命令，Electron 下自动跳过 */
(() => {
  if (!window.__TAURI__ || window.desktop) return;

  const core = window.__TAURI__.core;
  const event = window.__TAURI__.event;

  window.desktop = {
    platform: 'win32',
    pickFiles: (mode) => core.invoke('pick_files', { mode }),
    pickDirectory: () => core.invoke('pick_directory'),
    defaultDir: () => core.invoke('default_dir'),
    exists: (target) => core.invoke('path_exists', { target }),
    getPathForFile: () => '',
    launchFiles: () => core.invoke('launch_files'),
    start: (payload) => core.invoke('start_task', { payload }),
    cancel: () => {
      core.invoke('cancel_task');
    },
    onProgress: (callback) => {
      let disposed = false;
      let unlisten = null;
      event.listen('task:progress', (payload) => callback(payload)).then((fn) => {
        unlisten = fn;
        if (disposed) fn();
      });
      return () => {
        disposed = true;
        if (unlisten) unlisten();
      };
    },
    windowControl: (action) => {
      core.invoke('window_control', { action });
    },
    appInfo: () => core.invoke('app_info'),
    setAssoc: (enabled) => core.invoke('set_assoc', { enabled }),
    openDefaultApps: () => core.invoke('open_default_apps'),
    uninstall: () => core.invoke('uninstall_app'),
  };

  /* 原生拖拽：Tauri 直接给出文件路径，转成 app.js 需要的 { name, size, path } */
  const dropzone = document.getElementById('dropzone');
  const webviewApi = window.__TAURI__.webview;
  if (dropzone && webviewApi) {
    webviewApi.getCurrentWebview().onDragDropEvent(async (evt) => {
      const payload = evt.payload;
      if (!payload) return;

      if (payload.type === 'enter' || payload.type === 'over') {
        dropzone.classList.add('is-dragover');
        return;
      }
      if (payload.type === 'leave') {
        dropzone.classList.remove('is-dragover');
        return;
      }
      if (payload.type === 'drop') {
        dropzone.classList.remove('is-dragover');
        const files = await core.invoke('stat_paths', { paths: payload.paths || [] });
        window.dispatchEvent(new CustomEvent('app:drop', { detail: files }));
      }
    });
  }

  /* 已经开着窗口时，再从“打开方式”传文件进来 */
  event.listen('app:open-files', (evt) => {
    if (Array.isArray(evt.payload) && evt.payload.length) {
      window.dispatchEvent(new CustomEvent('app:open-files', { detail: evt.payload }));
    }
  });
})();
