#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Run inside MSYS2 UCRT64. Inputs are verified by the accompanying Python driver.
set -euo pipefail
root="$(cygpath -u "$1")"
export PATH="/ucrt64/bin:/usr/bin:$PATH"
test "$(gcc -dumpmachine)" = x86_64-w64-mingw32
mkdir -p "$root/build" "$root/install" "$root/logs"
cd "$root/cache"
printf '%s\n' \
  '5977fc950f8d1395ccea9bd48c06b3f808fd3c2c961b44b0c2e6e29fc3a70a85  libusb-1.0.29.tar.bz2' \
  'af254788be98861f2bd9103fe6e60a774ec96a8c374744eef9197f6043075afa  openocd-0.12.0.tar.bz2' \
  'c4c9cd8bec79da63b111d15713ef5cc2cd947deca411d35d6e3065e227dc414a  stm32flash-0.7.tar.gz' | sha256sum --check
cd "$root/build"
tar -xf "$root/cache/libusb-1.0.29.tar.bz2"
tar -xf "$root/cache/openocd-0.12.0.tar.bz2"
tar -xf "$root/cache/stm32flash-0.7.tar.gz"
export CFLAGS='-O2'
export LDFLAGS='-static -static-libgcc -static-libstdc++'
cd "$root/build/libusb-1.0.29"
./configure --prefix="$root/install/libusb" --host=x86_64-w64-mingw32 --disable-shared --enable-static
make -j4
make install
cd "$root/build/openocd-0.12.0"
export PKG_CONFIG_PATH="$root/install/libusb/lib/pkgconfig"
./configure --prefix="$root/install/openocd" --host=x86_64-w64-mingw32 \
  --enable-stlink --enable-internal-jimtcl --disable-internal-libjaylink \
  --disable-jlink --disable-ftdi --disable-cmsis-dap --disable-doxygen-html \
  --disable-doxygen-pdf --disable-werror --without-capstone
make -j4
make install-exec
mkdir -p "$root/install/openocd/share/openocd/scripts"
cp -R tcl/. "$root/install/openocd/share/openocd/scripts/"
cd "$root/build/stm32flash-0.7"
make clean CC=gcc AR=ar
make -j4 CC=gcc AR=ar CFLAGS='-O2' LDFLAGS='-static -static-libgcc'
mkdir -p "$root/install/stm32flash/bin"
cp stm32flash.exe "$root/install/stm32flash/bin/"
gcc --version > "$root/logs/compiler.txt"
for exe in "$root/install/openocd/bin/openocd.exe" "$root/install/stm32flash/bin/stm32flash.exe"; do
  objdump -p "$exe" | sed -n '/DLL Name:/p'
done > "$root/logs/imports.txt"
mkdir -p "$root/licenses"
for name in gcc libgcc libwinpthread winpthreads; do
  test -d "/ucrt64/share/licenses/$name"
  cp -R "/ucrt64/share/licenses/$name" "$root/licenses/"
done
pacman -Q mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-libwinpthread \
  mingw-w64-ucrt-x86_64-winpthreads > "$root/logs/runtime-packages.txt"
