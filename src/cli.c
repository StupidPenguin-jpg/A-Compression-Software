/* Windows 压缩核心的命令行封装
 * 用法：
 *   compressor-cli.exe compress <zip|tar|tar.gz> <输出文件> <文件1> [文件2 ...] [--password <密码>]
 *   compressor-cli.exe decompress <压缩包> <输出目录> [--password <密码>]
 * 说明：密码仅对 ZIP 生效（AES-256 加密）；TAR / TAR.GZ 不支持密码。
 * 输出：每行一个 JSON（progress / done），供 Electron 主进程解析。
 * 取消：向 stdin 写入 "cancel" 即可。
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "core.h"

static volatile int g_done = 0;

static char *wide_to_utf8(const wchar_t *w)
{
    if (!w) return NULL;
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *s = (char *)malloc((size_t)n);
    if (!s) return NULL;
    if (WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL) <= 0) {
        free(s);
        return NULL;
    }
    return s;
}

static DWORD WINAPI monitor_thread(LPVOID param)
{
    (void)param;
    unsigned long long last_processed = ~0ULL;
    unsigned long long last_total = ~0ULL;

    for (;;) {
        int done = g_done;
        unsigned long long processed = g_progress_processed;
        unsigned long long total = g_progress_total;
        if (total == 0) total = 1;

        if (processed != last_processed || total != last_total) {
            printf("{\"type\":\"progress\",\"processed\":%llu,\"total\":%llu}\n",
                   processed, total);
            fflush(stdout);
            last_processed = processed;
            last_total = total;
        }
        if (done) break;
        Sleep(100);
    }
    return 0;
}

static DWORD WINAPI stdin_thread(LPVOID param)
{
    (void)param;
    char line[64];
    while (fgets(line, sizeof(line), stdin)) {
        if (_strnicmp(line, "cancel", 6) == 0) {
            g_cancel = 1;
            break;
        }
    }
    /* stdin 读到 EOF 不代表要取消（命令行直接运行时常是关闭状态），
     * 父进程退出由 parent_watch_thread 负责 */
    return 0;
}

/* 取父进程 PID，用于监听父进程是否已退出 */
static DWORD parent_pid(void)
{
    DWORD self = GetCurrentProcessId();
    DWORD ppid = 0;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;

    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == self) {
                ppid = pe.th32ParentProcessID;
                break;
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return ppid;
}

/* 父进程（界面程序）结束后立即退出，保证关掉窗口不会遗留后台进程 */
static DWORD WINAPI parent_watch_thread(LPVOID param)
{
    DWORD ppid = (DWORD)(ULONG_PTR)param;
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, ppid);
    if (!parent) return 0;
    WaitForSingleObject(parent, INFINITE);
    CloseHandle(parent);
    ExitProcess(1);
    return 0;
}

int main(void)
{
    _setmode(_fileno(stdout), _O_BINARY);
    setvbuf(stdout, NULL, _IONBF, 0);

    int argc = 0;
    LPWSTR *wargv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!wargv) return 2;

    char **argv = (char **)calloc((size_t)argc, sizeof(char *));
    if (!argv) {
        LocalFree(wargv);
        return 2;
    }
    for (int i = 0; i < argc; i++) argv[i] = wide_to_utf8(wargv[i]);
    LocalFree(wargv);

    /* 提取可选的 --password/-p 参数，其余位置参数保持不变 */
    char **args = (char **)calloc((size_t)argc + 1, sizeof(char *));
    if (!args) {
        for (int i = 0; i < argc; i++) free(argv[i]);
        free(argv);
        return 2;
    }

    const char *password = NULL;
    int nargs = 0;
    for (int i = 0; i < argc; i++) {
        if (!password && i + 1 < argc &&
            (_stricmp(argv[i], "--password") == 0 || _stricmp(argv[i], "-p") == 0)) {
            password = argv[i + 1];
            i++;
            continue;
        }
        args[nargs++] = argv[i];
    }

    int code = 2;
    if (nargs >= 4 && args[1]) {
        g_cancel = 0;
        g_progress_processed = 0;
        g_progress_total = 0;
        g_last_error[0] = '\0';

        HANDLE monitor = CreateThread(NULL, 0, monitor_thread, NULL, 0, NULL);
        HANDLE reader = CreateThread(NULL, 0, stdin_thread, NULL, 0, NULL);
        DWORD ppid = parent_pid();
        HANDLE watcher = ppid ? CreateThread(NULL, 0, parent_watch_thread, (LPVOID)(ULONG_PTR)ppid, 0, NULL) : NULL;

        if (_stricmp(args[1], "compress") == 0) {
            if (nargs >= 5 && args[2] && args[3]) {
                const char **files = (const char **)&args[4];
                int count = nargs - 4;

                if (_stricmp(args[2], "tar") == 0 || _stricmp(args[2], "tar.gz") == 0 ||
                    _stricmp(args[2], "tgz") == 0) {
                    code = compress_tar(files, count, args[3], password);
                } else {
                    code = compress_zip(files, count, args[3], password);
                }
            }
        } else if (_stricmp(args[1], "decompress") == 0) {
            code = decompress_file(args[2], args[3], password);
        }

        g_done = 1;
        if (monitor) {
            WaitForSingleObject(monitor, 500);
            CloseHandle(monitor);
        }
        if (reader) CloseHandle(reader);
        if (watcher) CloseHandle(watcher);

        /* 把具体失败原因写给主进程（例如：需要密码 / 密码错误） */
        if (code != 0 && g_last_error[0]) {
            fprintf(stderr, "%s\n", g_last_error);
            fflush(stderr);
        }

        printf("{\"type\":\"done\",\"code\":%d}\n", code);
        fflush(stdout);
    }

    free(args);
    for (int i = 0; i < argc; i++) free(argv[i]);
    free(argv);
    return code;
}
