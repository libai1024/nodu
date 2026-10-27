/* SPDX-License-Identifier: MIT
 * Windows launcher: upstream ALS permits data/packages/** but profile compilers
 * live in data/internal/**. Preserve all flags and override only that allowlist.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif
int main(int argc, char **argv) {
    const char *real = getenv("NODU_ARDUINO_CLANGD_REAL");
    const char *data = getenv("NODU_ARDUINO_DATA");
    if (!real || !*real || !data || !*data || strchr(data, ',') || strchr(data, '\n') || strchr(data, '\r')) {
        fputs("Arduino clangd environment unavailable\n", stderr); return 2;
    }
    size_t size = strlen(data) * 2 + 64;
    char *flag = (char *)malloc(size);
    char **args = (char **)calloc((size_t)argc + 2, sizeof(char *));
    if (!flag || !args) return 2;
    snprintf(flag, size, "--query-driver=%s/packages/**,%s/internal/**", data, data);
    for (char *p = flag; *p; ++p) if (*p == '\\') *p = '/';
    args[0] = (char *)real;
    for (int i = 1; i < argc; ++i) args[i] = argv[i];
    args[argc] = flag;
#ifdef _WIN32
    int result = (int)_spawnv(_P_WAIT, real, (const char *const *)args);
    free(flag); free(args); return result < 0 ? 2 : result;
#else
    execv(real, args); perror("clangd"); free(flag); free(args); return 2;
#endif
}
