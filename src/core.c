#include "core.h"

#include <windows.h>
#include <archive.h>
#include <archive_entry.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wchar.h>

volatile int g_cancel = 0;
volatile unsigned long long g_progress_processed = 0;
volatile unsigned long long g_progress_total = 0;
char g_last_error[512] = "";

/* 记录失败原因，供 CLI 向 Electron 输出 */
static void set_error(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_last_error, sizeof(g_last_error), fmt, ap);
    va_end(ap);
}

/* 优先使用 libarchive 的具体错误信息 */
static void set_archive_error(struct archive *a, const char *fallback)
{
    const char *msg = a ? archive_error_string(a) : NULL;
    if (msg && *msg) set_error("%s", msg);
    else set_error("%s", fallback);
}

/* libarchive 是否在提示“需要密码” */
static int error_mentions_passphrase(struct archive *a)
{
    const char *msg = a ? archive_error_string(a) : NULL;
    return msg && strstr(msg, "assphrase") != NULL;
}

/* ===== 链接兼容垫片 =====
 * E:\Dev\libs\libarchive\lib\libarchive.a 由 MSVC 工具链构建，
 * 会引用 msvcrt 的 _snprintf / _timezone 导入符号，MinGW 无对应项。
 * 这两个符号仅 ISO9660 写入等边缘路径使用，本项目不会触发。
 */
static long g_compat_timezone = 0;

static int compat_snprintf(char *buf, size_t size, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    int r = vsnprintf(buf, size, fmt, ap);
    va_end(ap);
    return r;
}

typedef int (*snprintf_signature)(char *, size_t, const char *, ...);

snprintf_signature __imp__snprintf __asm__("__imp__snprintf") = compat_snprintf;
long *__imp__timezone __asm__("__imp__timezone") = &g_compat_timezone;

/* ================= 路径与文件工具 ================= */

/* UTF-8 -> 宽字符（Windows 文件 API 需要），失败返回 NULL */
static wchar_t *utf8_to_wide(const char *s)
{
    if (!s) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *w = (wchar_t *)malloc(sizeof(wchar_t) * (size_t)n);
    if (!w) return NULL;
    if (MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n) <= 0) {
        free(w);
        return NULL;
    }
    return w;
}

/* 判断 s 是否以 suffix 结尾（忽略大小写） */
static int has_suffix_ci(const char *s, const char *suffix)
{
    size_t ls = strlen(s), lf = strlen(suffix);
    if (ls < lf) return 0;
    return _stricmp(s + ls - lf, suffix) == 0;
}

/* 递归创建目录（UTF-8 路径），已存在时静默忽略 */
static void ensure_dir(const char *path)
{
    wchar_t *w = utf8_to_wide(path);
    if (!w) return;

    for (wchar_t *p = w; *p; ++p) {
        if (*p == L'/' || *p == L'\\') {
            wchar_t c = *p;
            *p = L'\0';
            CreateDirectoryW(w, NULL);
            *p = c;
        }
    }
    CreateDirectoryW(w, NULL);
    free(w);
}

/* FILETIME -> Unix 时间戳 */
static time_t filetime_to_time(const FILETIME *ft)
{
    ULARGE_INTEGER u;
    u.LowPart = ft->dwLowDateTime;
    u.HighPart = ft->dwHighDateTime;
    return (time_t)(u.QuadPart / 10000000ULL - 11644473600ULL);
}

/* 取普通文件大小，成功返回 1；目录或不存在返回 0 */
static int file_size(const wchar_t *wpath, unsigned long long *size, FILETIME *mtime)
{
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(wpath, GetFileExInfoStandard, &fad)) return 0;
    if (fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) return 0;
    if (mtime) *mtime = fad.ftLastWriteTime;
    *size = ((unsigned long long)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
    return 1;
}

/* 校验解压条目名，拒绝绝对路径与包含 ".." 的路径穿越 */
static int safe_entry_name(const char *name)
{
    if (!name || !*name) return 0;
    if (name[0] == '/' || name[0] == '\\') return 0;
    if (name[1] == ':') return 0; /* C: */

    const char *seg = name;
    for (const char *p = name; ; ++p) {
        if (*p == '/' || *p == '\\' || *p == '\0') {
            size_t len = (size_t)(p - seg);
            if (len == 2 && seg[0] == '.' && seg[1] == '.') return 0;
            if (*p == '\0') break;
            seg = p + 1;
        }
    }
    return 1;
}

/* 去掉路径最后一段，得到所在目录（写入 parent） */
static void parent_dir(const char *full, char *parent, size_t cap)
{
    snprintf(parent, cap, "%s", full);
    char *p1 = strrchr(parent, '/');
    char *p2 = strrchr(parent, '\\');
    char *p = p1 > p2 ? p1 : p2;
    if (p) *p = '\0';
}

/* ================= 压缩 ================= */

static int compress_archive(const char *files[], int count, const char *dst, int is_zip, const char *password)
{
    g_last_error[0] = '\0';
    if (g_cancel) return -1;
    if (!dst || count <= 0) return -1;

    int encrypt = password && *password;
    if (encrypt && !is_zip) {
        set_error("TAR / TAR.GZ 格式不支持密码加密，请使用 ZIP 格式");
        return -1;
    }

    struct archive *a = archive_write_new();
    if (!a) return -1;

    if (is_zip) {
        /* ZIP：不套外层过滤器，内部使用 deflate */
        archive_write_add_filter_none(a);
        if (archive_write_set_format_zip(a) != ARCHIVE_OK) {
            archive_write_free(a);
            return -1;
        }
        archive_write_set_format_option(a, "zip", "compression", "deflate");
        /* 文件名统一按 UTF-8 写，避免 Windows 本地代码页转换失败导致崩溃 */
        archive_write_set_format_option(a, "zip", "hdrcharset", "UTF-8");

        /* AES-256 加密（WinZip AES），7-Zip / WinRAR 可直接输入密码解压 */
        if (encrypt) {
            if (archive_write_set_format_option(a, "zip", "encryption", "aes256") != ARCHIVE_OK) {
                set_archive_error(a, "无法启用 ZIP 加密");
                archive_write_free(a);
                return -1;
            }
            if (archive_write_set_passphrase(a, password) != ARCHIVE_OK) {
                set_archive_error(a, "密码设置失败");
                archive_write_free(a);
                return -1;
            }
        }
    } else {
        /* TAR：可选 gzip 过滤器，格式采用 pax 以支持长文件名 */
        if (has_suffix_ci(dst, ".gz") || has_suffix_ci(dst, ".tgz"))
            archive_write_add_filter_gzip(a);
        else
            archive_write_add_filter_none(a);
        if (archive_write_set_format_pax(a) != ARCHIVE_OK) {
            archive_write_free(a);
            return -1;
        }
        archive_write_set_format_option(a, "pax", "hdrcharset", "UTF-8");
    }

    wchar_t *wdst = utf8_to_wide(dst);
    if (!wdst) { archive_write_free(a); return -1; }
    if (archive_write_open_filename_w(a, wdst) != ARCHIVE_OK) {
        set_archive_error(a, "无法创建输出文件");
        free(wdst);
        archive_write_free(a);
        return -1;
    }
    free(wdst);

    /* 统计总大小用于进度 */
    g_progress_processed = 0;
    g_progress_total = 0;
    for (int i = 0; i < count; i++) {
        wchar_t *wp = utf8_to_wide(files[i]);
        if (!wp) continue;
        unsigned long long sz;
        if (file_size(wp, &sz, NULL)) g_progress_total += sz;
        free(wp);
    }

    char buf[BUFFER_SIZE];
    for (int i = 0; i < count; i++) {
        if (g_cancel) {
            archive_write_close(a);
            archive_write_free(a);
            return -1;
        }

        wchar_t *wpath = utf8_to_wide(files[i]);
        if (!wpath) continue;

        FILETIME mtime;
        unsigned long long size;
        if (!file_size(wpath, &size, &mtime)) { free(wpath); continue; } /* 目录或不可读文件 */

        struct archive_entry *entry = archive_entry_new();
        if (!entry) { free(wpath); continue; }

        /* 用宽字符文件名写入，避免 Windows 下 UTF-8 -> 本地代码页转换失败 */
        const wchar_t *b1 = wcsrchr(wpath, L'/');
        const wchar_t *b2 = wcsrchr(wpath, L'\\');
        const wchar_t *wname = b1 > b2 ? b1 : b2;
        wname = wname ? wname + 1 : wpath;

        archive_entry_copy_pathname_w(entry, wname);
        archive_entry_set_size(entry, (la_int64_t)size);
        archive_entry_set_filetype(entry, AE_IFREG);
        archive_entry_set_perm(entry, 0644);
        archive_entry_set_mtime(entry, filetime_to_time(&mtime), 0);

        if (archive_write_header(a, entry) != ARCHIVE_OK) {
            archive_entry_free(entry);
            free(wpath);
            continue;
        }

        FILE *f = _wfopen(wpath, L"rb");
        if (f) {
            size_t n;
            while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
                if (g_cancel) {
                    fclose(f);
                    archive_entry_free(entry);
                    archive_write_close(a);
                    archive_write_free(a);
                    return -1;
                }
                if (archive_write_data(a, buf, n) < 0) break;
                g_progress_processed += n;
            }
            fclose(f);
        }

        archive_entry_free(entry);
        free(wpath);
    }

    archive_write_close(a);
    archive_write_free(a);
    return g_cancel ? -1 : 0;
}

int compress_zip(const char *files[], int count, const char *dst, const char *password)
{
    return compress_archive(files, count, dst, 1, password);
}

int compress_tar(const char *files[], int count, const char *dst, const char *password)
{
    return compress_archive(files, count, dst, 0, password);
}

/* ================= 解压 ================= */

static int is_supported_archive(const char *src)
{
    return has_suffix_ci(src, ".zip") ||
           has_suffix_ci(src, ".tar") ||
           has_suffix_ci(src, ".tar.gz") ||
           has_suffix_ci(src, ".tgz") ||
           has_suffix_ci(src, ".gz");
}

int decompress_file(const char *src, const char *outdir, const char *password)
{
    if (!src || !outdir || !is_supported_archive(src)) return -1;
    if (g_cancel) return -1;

    g_last_error[0] = '\0';
    int have_password = password && *password;
    int encrypted = 0;

    wchar_t *wsrc = utf8_to_wide(src);
    if (!wsrc) {
        set_error("无法解析压缩包路径");
        return -1;
    }

    /* 第一遍：扫描总大小，供进度显示；同时判断是否加密 */
    g_progress_processed = 0;
    g_progress_total = 0;
    {
        struct archive *scan = archive_read_new();
        if (!scan) { free(wsrc); set_error("内存不足"); return -1; }
        archive_read_support_filter_all(scan);
        archive_read_support_format_all(scan);
        archive_read_support_format_raw(scan);
        if (have_password) archive_read_add_passphrase(scan, password);

        if (archive_read_open_filename_w(scan, wsrc, BUFFER_SIZE) != ARCHIVE_OK) {
            int needs_password = !have_password && error_mentions_passphrase(scan);
            set_archive_error(scan, "无法打开压缩包");
            archive_read_free(scan);
            free(wsrc);
            if (needs_password) set_error("该压缩包已加密，需要输入密码");
            return needs_password ? -2 : -1;
        }

        encrypted = archive_read_has_encrypted_entries(scan);
        if (encrypted == 1 && !have_password) {
            archive_read_close(scan);
            archive_read_free(scan);
            free(wsrc);
            set_error("该压缩包已加密，需要输入密码");
            return -2;
        }

        struct archive_entry *e;
        int r;
        while ((r = archive_read_next_header(scan, &e)) == ARCHIVE_OK) {
            la_int64_t sz = archive_entry_size(e);
            if (sz > 0) g_progress_total += (unsigned long long)sz;

            /* ZIP 的 has_encrypted_entries 可能返回未知，逐条判断更可靠 */
            if (archive_entry_is_encrypted(e)) {
                encrypted = 1;
                if (!have_password) {
                    archive_read_close(scan);
                    archive_read_free(scan);
                    free(wsrc);
                    set_error("该压缩包已加密，需要输入密码");
                    return -2;
                }

                /* 先解出开头一小段，提前验证密码，避免错误密码继续解压 */
                char probe[4096];
                la_ssize_t pn = archive_read_data(scan, probe, sizeof(probe));
                if (pn < 0) {
                    r = (int)pn;
                    break;
                }
            }

            int sr = archive_read_data_skip(scan);
            if (sr <= ARCHIVE_FAILED) {
                r = sr;
                break;
            }
        }

        if (r != ARCHIVE_EOF) {
            int password_problem = encrypted == 1 || error_mentions_passphrase(scan);
            set_archive_error(scan, "读取压缩包失败");
            archive_read_close(scan);
            archive_read_free(scan);
            free(wsrc);
            if (password_problem) {
                if (have_password) {
                    set_error("密码错误，无法解压");
                    return -3;
                }
                set_error("该压缩包已加密，需要输入密码");
                return -2;
            }
            return -1;
        }

        archive_read_close(scan);
        archive_read_free(scan);
    }
    if (g_progress_total == 0) g_progress_total = 1;
    ensure_dir(outdir);

    /* 第二遍：正式解压 */
    struct archive *a = archive_read_new();
    if (!a) { free(wsrc); set_error("内存不足"); return -1; }
    archive_read_support_filter_all(a);
    archive_read_support_format_all(a);
    archive_read_support_format_raw(a);
    if (have_password) archive_read_add_passphrase(a, password);

    if (archive_read_open_filename_w(a, wsrc, BUFFER_SIZE) != ARCHIVE_OK) {
        int needs_password = !have_password && error_mentions_passphrase(a);
        set_archive_error(a, "无法打开压缩包");
        archive_read_free(a);
        free(wsrc);
        if (needs_password) set_error("该压缩包已加密，需要输入密码");
        return needs_password ? -2 : -1;
    }
    free(wsrc);

    char buf[BUFFER_SIZE];
    char full[2048];
    char parent[2048];
    struct archive_entry *entry;
    int r;

    while ((r = archive_read_next_header(a, &entry)) == ARCHIVE_OK) {
        if (g_cancel) {
            archive_read_close(a);
            archive_read_free(a);
            return -1;
        }

        /* 兜底：扫描阶段未识别出加密时，这里再拦一次 */
        if (archive_entry_is_encrypted(entry)) {
            encrypted = 1;
            if (!have_password) {
                archive_read_close(a);
                archive_read_free(a);
                set_error("该压缩包已加密，需要输入密码");
                return -2;
            }
        }

        const char *name = archive_entry_pathname_utf8(entry);
        if (!name) name = archive_entry_pathname(entry);
        if (!safe_entry_name(name)) {
            archive_read_data_skip(a);
            continue;
        }

        snprintf(full, sizeof(full), "%s/%s", outdir, name);

        if (archive_entry_filetype(entry) == AE_IFDIR) {
            ensure_dir(full);
            archive_read_data_skip(a);
            continue;
        }

        parent_dir(full, parent, sizeof(parent));
        ensure_dir(parent);

        wchar_t *wfull = utf8_to_wide(full);
        FILE *f = wfull ? _wfopen(wfull, L"wb") : NULL;
        free(wfull);

        if (!f) {
            archive_read_data_skip(a);
            continue;
        }

        la_ssize_t n;
        unsigned long long written = 0;
        int read_failed = 0;
        while ((n = archive_read_data(a, buf, sizeof(buf))) > 0) {
            if (g_cancel) {
                fclose(f);
                archive_read_close(a);
                archive_read_free(a);
                return -1;
            }
            fwrite(buf, 1, (size_t)n, f);
            written += (unsigned long long)n;
        }
        if (n < 0) read_failed = 1;
        fclose(f);

        if (read_failed) {
            /* 密码错误 / 数据损坏时不要留下半截文件 */
            wchar_t *wdel = utf8_to_wide(full);
            if (wdel) {
                DeleteFileW(wdel);
                free(wdel);
            }

            int password_problem = encrypted == 1 || (have_password && error_mentions_passphrase(a));
            set_archive_error(a, "读取数据失败");
            archive_read_close(a);
            archive_read_free(a);
            if (password_problem) {
                if (have_password) {
                    set_error("密码错误，无法解压");
                    return -3;
                }
                set_error("该压缩包已加密，需要输入密码");
                return -2;
            }
            return -1;
        }

        g_progress_processed += written;
        if (g_progress_processed > g_progress_total)
            g_progress_processed = g_progress_total;
    }

    if (r != ARCHIVE_EOF) {
        int password_problem = encrypted == 1 || (have_password && error_mentions_passphrase(a));
        set_archive_error(a, "解压过程中读取失败");
        archive_read_close(a);
        archive_read_free(a);
        if (password_problem) {
            set_error("密码错误，无法解压");
            return -3;
        }
        return -1;
    }

    archive_read_close(a);
    archive_read_free(a);
    return g_cancel ? -1 : 0;
}
