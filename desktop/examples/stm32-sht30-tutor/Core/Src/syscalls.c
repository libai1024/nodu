/* newlib 需要的系统调用：printf 经 _write 输出到调试串口，malloc 经 _sbrk 使用堆。 */
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/stat.h>
#include "main.h"

/* 调试串口的输出函数在 Board/board_uart.c 中实现；没有初始化串口的工程里，输出被丢弃。 */
__attribute__((weak)) int Board_DebugWrite(const char *data, int len)
{
    (void)data;
    return len;
}

/* ST 启动文件调用 __libc_init_array，它需要这两个钩子。 */
void _init(void)
{
}

void _fini(void)
{
}

int _write(int file, char *ptr, int len)
{
    (void)file;
    return Board_DebugWrite(ptr, len);
}

int _read(int file, char *ptr, int len)
{
    (void)file;
    (void)ptr;
    (void)len;
    return 0;
}

int _close(int file)
{
    (void)file;
    return -1;
}

/* 标准输出按字符设备处理：printf 遇到换行符时立即发送。 */
int _fstat(int file, struct stat *st)
{
    (void)file;
    st->st_mode = S_IFCHR;
    return 0;
}

int _isatty(int file)
{
    (void)file;
    return 1;
}

int _lseek(int file, int ptr, int dir)
{
    (void)file;
    (void)ptr;
    (void)dir;
    return 0;
}

int _getpid(void)
{
    return 1;
}

int _kill(int pid, int sig)
{
    (void)pid;
    (void)sig;
    errno = EINVAL;
    return -1;
}

void _exit(int status)
{
    (void)status;
    while (1)
    {
    }
}

/* 堆从 _end 向上增长，最多到栈的保留区（链接脚本中的 _Min_Stack_Size）。 */
extern uint8_t _end;
extern uint8_t _estack;
extern uint32_t _Min_Stack_Size;

void *_sbrk(ptrdiff_t incr)
{
    static uint8_t *heap_end = NULL;
    const uint8_t *limit = &_estack - (uint32_t)&_Min_Stack_Size;
    if (heap_end == NULL)
    {
        heap_end = &_end;
    }
    if (heap_end + incr > limit)
    {
        errno = ENOMEM;
        return (void *)-1;
    }
    uint8_t *previous = heap_end;
    heap_end += incr;
    return previous;
}
