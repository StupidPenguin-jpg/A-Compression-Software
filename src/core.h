#ifndef CORE_H
#define CORE_H

/* Windows 版压缩/解压核心（仅核心层，不含界面）
 * 功能对应原 Linux 版的正式版：zip / tar / tar.gz 的压缩与解压。
 * 不包含个人版 .zyx 私有格式。
 */

#define MAX_CHAR    256
#define BUFFER_SIZE 65536

/* 全局取消标志与进度，供上层界面（未实现）轮询
 * 注意：Windows 为 LLP64，unsigned long 只有 32 位，这里用 64 位避免大文件溢出 */
extern volatile int g_cancel;
extern volatile unsigned long long g_progress_processed;
extern volatile unsigned long long g_progress_total;

/* 最近一次失败原因（UTF-8），由调用方（CLI）输出给上层 */
extern char g_last_error[512];

/* 压缩：files 为待压缩文件路径数组（UTF-8），count 为数量
 * dst 为输出文件，compress_zip 生成 .zip；
 * compress_tar 生成 .tar，若 dst 以 .gz 结尾则同时 gzip 压缩
 * password 非空时对 ZIP 使用 AES-256 加密；TAR / TAR.GZ 不支持密码 */
int compress_zip(const char *files[], int count, const char *dst, const char *password);
int compress_tar(const char *files[], int count, const char *dst, const char *password);

/* 解压：按扩展名自动识别 .zip / .tar / .tar.gz / .tgz / .gz
 * 解压到 outdir 目录（不存在则创建）
 * 返回：0 成功；-1 失败；-2 需要密码；-3 密码错误 */
int decompress_file(const char *src, const char *outdir, const char *password);

#endif
