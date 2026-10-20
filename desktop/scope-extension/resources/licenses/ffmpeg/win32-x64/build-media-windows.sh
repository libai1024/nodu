#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Invoked by build-media-windows.cjs inside MSYS2 UCRT64, with quoted argv.
set -euo pipefail

cache="$(cygpath -u "$1")"
jobs="$2"
ffmpeg_version="$3"
sdl2_version="$4"
export PATH="/ucrt64/bin:/usr/bin:$PATH"
for tool in gcc make pkg-config objdump; do
    command -v "$tool" >/dev/null
done
test "$(gcc -dumpmachine | tr -d '\r\n')" = "x86_64-w64-mingw32"
unset MACOSX_DEPLOYMENT_TARGET SDKROOT
export CFLAGS="-O2"
export LDFLAGS="-static-libgcc"

cd "$cache/SDL2-$sdl2_version"
if [ -f Makefile ]; then
    make clean
fi
./configure --prefix="$cache/sdl2-install" \
    --host=x86_64-w64-mingw32 --enable-shared --disable-static \
    --disable-video-x11 --disable-video-wayland --disable-pulseaudio \
    --disable-alsa --disable-jack --disable-libsamplerate
make -j"$jobs"
make install

export SDL2_CONFIG="$cache/sdl2-install/bin/sdl2-config"
export PKG_CONFIG_PATH="$cache/sdl2-install/lib/pkgconfig"
export PATH="$cache/sdl2-install/bin:$PATH"
cd "$cache/ffmpeg-$ffmpeg_version"
# FFmpeg ships a stub Makefile that includes ffbuild/config.mak; a fresh
# tree "has a Makefile" but `make clean` fails before configure. Clean only
# when a previous configure actually ran (verified on real Windows build).
if [ -f ffbuild/config.mak ]; then
    make clean
fi
./configure --disable-autodetect --disable-gpl --disable-nonfree \
    --disable-version3 --disable-doc --disable-debug --disable-network \
    --enable-ffplay --enable-sdl2 --enable-w32threads --disable-pthreads \
    --enable-small --enable-static --disable-shared --disable-x86asm \
    --target-os=mingw32 --arch=x86_64 --cc=gcc \
    --extra-ldflags='-static-libgcc -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,-Bdynamic,--no-whole-archive'
make -j"$jobs"
gcc --version > "$cache/toolchain.txt"
ld --version >> "$cache/toolchain.txt"
