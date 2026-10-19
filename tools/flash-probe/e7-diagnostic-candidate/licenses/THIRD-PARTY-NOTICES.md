# Candidate input notices

Offline build only. No hardware execution is asserted. Per-file hashes and observed headers are in `../source-manifest.json`; adaptation references are in `../reuse-manifest.json`. SDK sources use Apache-2.0 except the explicitly retained tinyprintf header notice below; SDK bsp.h has no own header and is covered only by the repository LICENSE record. No ktool GPL SLIP source is used.

The linked runtime is not uniformly Apache: final allocated sections retain six official GCC 8.2 archive members: divdf3.o, muldf3.o, fixunsdfsi.o, floatunsidf.o, _clzsi2.o and _clz.o. soft-fp files use LGPL-2.1-or-later with their explicit additional linking permission; libgcc2.c and RISC-V sfp-machine.h use GPL-3.0-or-later with GCC Runtime Library Exception 3.1. Complete texts are retained as gcc-COPYING.LIB, gcc-COPYING3 and gcc-COPYING.RUNTIME. Actual newlib 3.0 headers are compile inputs, but no libc runtime is linked; newlib-COPYING.NEWLIB is retained. GCC16 builtin header notices are separate compiler inputs.

These records preserve upstream wording; they do not claim the toolchain binary was reproduced from source. See `../../../docs/flash-probe-runtime-audit.md` for fixed source commits and independent closure analysis.

## Homebrew GNU GCC 16.2.0 builtin headers / lib/gcc/riscv64-elf/16.2.0/include/stdarg.h

`SHA-256 173a81bfbe88a2da5ed5d238e14e0eaca61b090ee6d7b12b5f9614daeea21600`

```text
/* Copyright (C) 1989-2026 Free Software Foundation, Inc.

This file is part of GCC.

GCC is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 3, or (at your option)
any later version.

GCC is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

Under Section 7 of GPL version 3, you are granted additional
permissions described in the GCC Runtime Library Exception, version
3.1, as published by the Free Software Foundation.

You should have received a copy of the GNU General Public License and
a copy of the GCC Runtime Library Exception along with this program;
see the files COPYING3 and COPYING.RUNTIME respectively.  If not, see
<http://www.gnu.org/licenses/>.  */
```

## Homebrew GNU GCC 16.2.0 builtin headers / lib/gcc/riscv64-elf/16.2.0/include/stdbool.h

`SHA-256 f2a112e8b2128fb1d76e7c0b625cec8760955ebeae5cdf6b419ccf0c6d62768f`

```text
/* Copyright (C) 1998-2026 Free Software Foundation, Inc.

This file is part of GCC.

GCC is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 3, or (at your option)
any later version.

GCC is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

Under Section 7 of GPL version 3, you are granted additional
permissions described in the GCC Runtime Library Exception, version
3.1, as published by the Free Software Foundation.

You should have received a copy of the GNU General Public License and
a copy of the GCC Runtime Library Exception along with this program;
see the files COPYING3 and COPYING.RUNTIME respectively.  If not, see
<http://www.gnu.org/licenses/>.  */
```

## Homebrew GNU GCC 16.2.0 builtin headers / lib/gcc/riscv64-elf/16.2.0/include/stddef.h

`SHA-256 868352506950054491b9c76a4e2814f4f3601d227d3dea62a3e75875f327f2c1`

```text
/* Copyright (C) 1989-2026 Free Software Foundation, Inc.

This file is part of GCC.

GCC is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 3, or (at your option)
any later version.

GCC is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

Under Section 7 of GPL version 3, you are granted additional
permissions described in the GCC Runtime Library Exception, version
3.1, as published by the Free Software Foundation.

You should have received a copy of the GNU General Public License and
a copy of the GCC Runtime Library Exception along with this program;
see the files COPYING3 and COPYING.RUNTIME respectively.  If not, see
<http://www.gnu.org/licenses/>.  */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/crt.S

`SHA-256 df3405e87a52c9449dfd2e56f0793258f26725f102d08a780480b78c02f170df`

```text
# Copyright 2018 Canaan Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#include "encoding.h"
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/include/atomic.h

`SHA-256 d3867f898060ca3b7fde472b4dce2cd362bd46edf183994ba0f9bd9ba09b6f9a`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/include/bsp.h

`SHA-256 cee9e4e9ad6f9a7a203811fd9123477ad271cf83542f246bb864275cffa29e70`

```text
No explicit initial license notice; original source/header identity is fixed in source-manifest.json. Refer to the applicable aggregate license and upstream file.
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/include/encoding.h

`SHA-256 26d9e3b2e3deec96cd01dc423b91cfd78bd048fd6b9a34fd2f9c67a55509356c`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/include/entry.h

`SHA-256 1ae6f5a2726771d8a660c03005dce041c2f9f5af83cd3a212371599cd6e0b97b`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/include/platform.h

`SHA-256 560b28265f31ad73e853826a16f1d1082a1b2125d0e1bb2d428696799654e075`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/include/printf.h

`SHA-256 1906d32f609db6b74591ec0f0e957765c2cf47f443561f61d5d52e8a7b60ac69`

```text
/**
 * File: printf.h
 *
 * Copyright (c) 2004,2012 Kustaa Nyholm / SpareTimeLabs
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *     * Redistributions of source code must retain the above copyright
 *       notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright
 *       notice, this list of conditions and the following disclaimer in the
 *       documentation and/or other materials provided with the distribution.
 *     * Neither the name of Kustaa Nyholm or SpareTimeLabs nor the
 *       names of its contributors may be used to endorse or promote products
 *       derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL COPYRIGHT HOLDER BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this library; if not, write to the Free Software Foundation,
 * Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 *
 * This library is really just two files: 'tinyprintf.h' and 'tinyprintf.c'.
 *
 * They provide a simple and small (+400 loc) printf functionality to be used
 * in embedded systems.
 *
 * I've found them so useful in debugging that I do not bother with a debugger
 * at all.
 *
 * They are distributed in source form, so to use them, just compile them into
 * your project.
 *
 * Two printf variants are provided: printf and the 'sprintf' family of
 * functions ('snprintf', 'sprintf', 'vsnprintf', 'vsprintf').
 *
 * The formats supported by this implementation are: 'c' 'd' 'i' 'o' 'p' 'u'
 * 's' 'x' 'X'.
 *
 * Zero padding, field width, and precision are also supported.
 *
 * If the library is compiled with 'PRINTF_SUPPORT_LONG' defined, then the
 * long specifier is also supported. Note that this will pull in some long
 * math routines (pun intended!) and thus make your executable noticeably
 * longer. Likewise with 'PRINTF_LONG_LONG_SUPPORT' for the long long
 * specifier, and with 'PRINTF_SIZE_T_SUPPORT' for the size_t specifier.
 *
 * The memory footprint of course depends on the target CPU, compiler and
 * compiler options, but a rough guesstimate (based on a H8S target) is about
 * 1.4 kB for code and some twenty 'int's and 'char's, say 60 bytes of stack
 * space. Not too bad. Your mileage may vary. By hacking the source code you
 * can get rid of some hundred bytes, I'm sure, but personally I feel the
 * balance of functionality and flexibility versus  code size is close to
 * optimal for many embedded systems.
 *
 * To use the printf, you need to supply your own character output function,
 * something like :
 *
 * void putc ( void* p, char c) { while (!SERIAL_PORT_EMPTY) ;
 * SERIAL_PORT_TX_REGISTER = c; }
 *
 * Before you can call printf, you need to initialize it to use your character
 * output function with something like:
 *
 * init_printf(NULL,putc);
 *
 * Notice the 'NULL' in 'init_printf' and the parameter 'void* p' in 'putc',
 * the NULL (or any pointer) you pass into the 'init_printf' will eventually
 * be passed to your 'putc' routine. This allows you to pass some storage
 * space (or anything really) to the character output function, if necessary.
 * This is not often needed but it was implemented like that because it made
 * implementing the sprintf function so neat (look at the source code).
 *
 * The code is re-entrant, except for the 'init_printf' function, so it is
 * safe to call it from interrupts too, although this may result in mixed
 * output. If you rely on re-entrancy, take care that your 'putc' function is
 * re-entrant!
 *
 * The printf and sprintf functions are actually macros that translate to
 * 'tfp_printf' and 'tfp_sprintf' when 'TINYPRINTF_OVERRIDE_LIBC' is set
 * (default). Setting it to 0 makes it possible to use them along with
 * 'stdio.h' printf's in a single source file. When 'TINYPRINTF_OVERRIDE_LIBC'
 * is set, please note that printf/sprintf are not function-like macros, so if
 * you have variables or struct members with these names, things will explode
 * in your face.  Without variadic macros this is the best we can do to wrap
 * these function. If it is a problem, just give up the macros and use the
 * functions directly, or rename them.
 *
 * It is also possible to avoid defining tfp_printf and/or tfp_sprintf by
 * clearing 'TINYPRINTF_DEFINE_TFP_PRINTF' and/or
 * 'TINYPRINTF_DEFINE_TFP_SPRINTF' to 0. This allows for example to export
 * only tfp_format, which is at the core of all the other functions.
 *
 * For further details see source code.
 *
 * regs Kusti, 23.10.2004
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/include/sleep.h

`SHA-256 4608e1624a153d9142fd170168e6989233081b6ccac36928afc1fef7c9cb30b3`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/bsp/include/syscalls.h

`SHA-256 2c6c486d42bf3e4855eb0b6b066e3decbe0abfa30685ac45c679f6fb2822c48a`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/fpioa.c

`SHA-256 f3d24ebe61f3b1b4e4658968c348498531a48009d816ff203448415a835d5856`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/clint.h

`SHA-256 fc3687b749b2927cf7d5b5db166ed756a23a9faae770018deb3ee414a8b40a23`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/dmac.h

`SHA-256 8d74f3cc1489f9d6ccd2ecd6e0156bc231005acaa2539fd2ce9195effdb0c089`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/fpioa.h

`SHA-256 2abc9d8744f32f51a96e1c2e68a616c0dc7219c78b8a8dd2564bf7cc56123518`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/io.h

`SHA-256 83006d8844f6e2af04f0b03b84e7e952845fef2724f39824805ceb39c4eee262`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/plic.h

`SHA-256 3a8edb49d0f83abdf29b4375c2533239be1333c2c970b1b1874fc266c298b441`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/spi.h

`SHA-256 5105d5380895f5af18f0ace0e8fcfa7f9fe3351a201ba065efc581d41b7900fb`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/sysctl.h

`SHA-256 0c209febc35c040c6756b429953c5f63292b1d5491e967384dda32747f3e3485`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/uart.h

`SHA-256 174cd5f096e3acd2f2ad561a9f2af3f75e20cc7543f15d4fc76848334773cb95`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/include/uarths.h

`SHA-256 1e3436ecd91a6e715ccf6363f0b8d144f0a0fcd4e448490bfe7b58f1372ccf36`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/sysctl.c

`SHA-256 afce807b424e03e4fdd22dc058a5148a5a2d89729050c9f8c742649aefc02c01`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## SDK 45642af98f15c24d64703ff57c97360794ca6f55 / lib/drivers/uarths.c

`SHA-256 94e9961a539a5b673e3301e9ccb43fd6ae22e60950c79dc16091cbd026e817e2`

```text
/* Copyright 2018 Canaan Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/_ansi.h

`SHA-256 5c6403b471ee897c9a6c12e00a58617247804eb3ee72d7baeb7c08616090dd1d`

```text
/* Provide support for both ANSI and non-ANSI environments.  */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/_newlib_version.h

`SHA-256 8c97f2eae1449c9b7871828d1b331e9468650c8cfbfd1590f6b1943fc84aef46`

```text
/* _newlib_version.h.  Generated from _newlib_version.hin by configure.  */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/alloca.h

`SHA-256 fdebd60de65105d933b55dcde1650f6c9b3cf6142c225397c5f956638208d4de`

```text
/* libc/include/alloca.h - Allocate memory on stack */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/machine/_default_types.h

`SHA-256 5d8f9f7ead7927e4b8b7ed00172e84f2ae82ea7f5f6ba3240ff813a9236771b3`

```text
/*
 *  $Id$
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/machine/_endian.h

`SHA-256 6a2878de2ce76eed443de3891e5dd49c67e3f41eea7054b47f9bd7ec27a144d0`

```text
/* !__MACHINE_ENDIAN_H__ */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/machine/_types.h

`SHA-256 44544ecbbc10c8aa58ca2da6d0617ffeee5af847af24515ab108c8218d6d92c8`

```text
/*
 *  $Id$
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/machine/endian.h

`SHA-256 c9cb16333e537785dde867ed059915ef2d09661dbab7cc8b4519b646735eace4`

```text
No explicit initial license notice; original source/header identity is fixed in source-manifest.json. Refer to the applicable aggregate license and upstream file.
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/machine/ieeefp.h

`SHA-256 ba301ecf2f7263c5b8be86dc64a4875802d5d09f92a0c8ccb79ee6b8673ae9cf`

```text
/* This file can define macros to choose variations of the IEEE float
   format:

   _FLT_LARGEST_EXPONENT_IS_NORMAL

	Defined if the float format uses the largest exponent for finite
	numbers rather than NaN and infinity representations.  Such a
	format cannot represent NaNs or infinities at all, but it's FLT_MAX
	is twice the IEEE value.

   _FLT_NO_DENORMALS

	Defined if the float format does not support IEEE denormals.  Every
	float with a zero exponent is taken to be a zero representation.
 
   ??? At the moment, there are no equivalent macros above for doubles and
   the macros are not fully supported by --enable-newlib-hw-fp.

   __IEEE_BIG_ENDIAN

        Defined if the float format is big endian.  This is mutually exclusive
        with __IEEE_LITTLE_ENDIAN.

   __IEEE_LITTLE_ENDIAN
 
        Defined if the float format is little endian.  This is mutually exclusive
        with __IEEE_BIG_ENDIAN.

   Note that one of __IEEE_BIG_ENDIAN or __IEEE_LITTLE_ENDIAN must be specified for a
   platform or error will occur.

   __IEEE_BYTES_LITTLE_ENDIAN

        This flag is used in conjunction with __IEEE_BIG_ENDIAN to describe a situation 
	whereby multiple words of an IEEE floating point are in big endian order, but the
	words themselves are little endian with respect to the bytes.

   _DOUBLE_IS_32BITS 

        This is used on platforms that support double by using the 32-bit IEEE
        float type.

   _FLOAT_ARG

        This represents what type a float arg is passed as.  It is used when the type is
        not promoted to double.
	

   __OBSOLETE_MATH_DEFAULT

	Default value for __OBSOLETE_MATH if that's not set by the user.
	It should be set here based on predefined feature macros.

   __OBSOLETE_MATH

	If set to 1 then some new math code will be disabled and older libm
	code will be used instead.  This is necessary because the new math
	code does not support all targets, it assumes that the toolchain has
	ISO C99 support (hexfloat literals, standard fenv semantics), the
	target has IEEE-754 conforming binary32 float and binary64 double
	(not mixed endian) representation, standard SNaN representation,
	double and single precision arithmetics has similar latency and it
	has no legacy SVID matherr support, only POSIX errno and fenv
	exception based error handling.
*/
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/machine/stdlib.h

`SHA-256 43552e520d412993325ba62cb496839cd03fd46b0df67149a5ccbe1b95c45fdd`

```text
/* place holder so platforms may add stdlib.h extensions */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/machine/syscall.h

`SHA-256 765fd8cc8ec45e62ce79ad4502730440d2cab97f14ee2693ca4f0e7acc888b88`

```text
/* Copyright (c) 2017  SiFive Inc. All rights reserved.

   This copyrighted material is made available to anyone wishing to use,
   modify, copy, or redistribute it subject to the terms and conditions
   of the FreeBSD License.   This program is distributed in the hope that
   it will be useful, but WITHOUT ANY WARRANTY expressed or implied,
   including the implied warranties of MERCHANTABILITY or FITNESS FOR
   A PARTICULAR PURPOSE.  A copy of this license is available at
   http://www.opensource.org/licenses.
*/
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/machine/types.h

`SHA-256 2979fad7fe3ef1fc01bd06640841114f0a0f3b5d33ada20e35a2bd38c27a4931`

```text
/*
 * Newlib targets may provide an own version of this file in their machine
 * directory to add custom user types for <sys/types.h>.
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/math.h

`SHA-256 720fe02afd2adea43562ece16035eadcab5d79aa6af7b3155f42bb4fc45d2656`

```text
/* Natural log of 2 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/newlib.h

`SHA-256 916cc28baa514acd5fa3e4798a4113706a9a28e77c1aa194cad434887324c17b`

```text
/* newlib.h.  Generated from newlib.hin by configure.  */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/stdint.h

`SHA-256 99fe201684856075ccd92704f63b702f6fa882b9dab61bd7a9bcce2588275861`

```text
/*
 * Copyright (c) 2004, 2005 by
 * Ralf Corsepius, Ulm/Germany. All rights reserved.
 *
 * Permission to use, copy, modify, and distribute this software
 * is freely granted, provided that this notice is preserved.
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/stdio.h

`SHA-256 24cb51aa9f62bade0ba30a41c139d3acba00d1f346d6915b65d901eae2021634`

```text
/*
 * Copyright (c) 1990 The Regents of the University of California.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms are permitted
 * provided that the above copyright notice and this paragraph are
 * duplicated in all such forms and that any documentation,
 * advertising materials, and other materials related to such
 * distribution and use acknowledge that the software was developed
 * by the University of California, Berkeley.  The name of the
 * University may not be used to endorse or promote products derived
 * from this software without specific prior written permission.
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND WITHOUT ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, WITHOUT LIMITATION, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.
 *
 *	@(#)stdio.h	5.3 (Berkeley) 3/15/86
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/stdlib.h

`SHA-256 b599e3fd2ac0cef9fca383c569a34cb64e2aa8799f3aa523bd089c7731c48b7b`

```text
/*
 * stdlib.h
 *
 * Definitions for common types, variables, and functions.
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/string.h

`SHA-256 e70780479f4b1b1badbcbd34f403eea99e98e147704cbf690f5f1231ed62157a`

```text
/*
 * string.h
 *
 * Definitions for memory and string functions.
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/strings.h

`SHA-256 2a057e90dc6b5ed81774660b35a667fba51452601067b36408d91bd0acd2637d`

```text
/*-
 * Copyright (c) 2002 Mike Barcroft <mike@FreeBSD.org>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 *
 * $FreeBSD: head/include/strings.h 272673 2014-10-07 04:54:11Z delphij $
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/_intsup.h

`SHA-256 bafd67248df6ebffd5455a8c8f9aa9fcb572e84ffb88d89824115705764b3198`

```text
/*
 * Copyright (c) 2004, 2005 by
 * Ralf Corsepius, Ulm/Germany. All rights reserved.
 *
 * Permission to use, copy, modify, and distribute this software
 * is freely granted, provided that this notice is preserved.
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/_pthreadtypes.h

`SHA-256 e0924bdccdc1b9983c51436971b690cd58024aa7c56b83f3e076bfc4f51091b6`

```text
/*
 *  Written by Joel Sherrill <joel.sherrill@OARcorp.com>.
 *
 *  COPYRIGHT (c) 1989-2013, 2015.
 *  On-Line Applications Research Corporation (OAR).
 *
 *  Permission to use, copy, modify, and distribute this software for any
 *  purpose without fee is hereby granted, provided that this entire notice
 *  is included in all copies of any software which is or includes a copy
 *  or modification of this software.
 *
 *  THIS SOFTWARE IS BEING PROVIDED "AS IS", WITHOUT ANY EXPRESS OR IMPLIED
 *  WARRANTY.  IN PARTICULAR,  THE AUTHOR MAKES NO REPRESENTATION
 *  OR WARRANTY OF ANY KIND CONCERNING THE MERCHANTABILITY OF THIS
 *  SOFTWARE OR ITS FITNESS FOR ANY PARTICULAR PURPOSE.
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/_sigset.h

`SHA-256 16e78626ff97ef85ec70ba9898082fccf70b741b0c6586c57e4421fc60b9a07d`

```text
/*-
 * Copyright (c) 1982, 1986, 1989, 1991, 1993
 *	The Regents of the University of California.  All rights reserved.
 * (c) UNIX System Laboratories, Inc.
 * All or some portions of this file are derived from material licensed
 * to the University of California by American Telephone and Telegraph
 * Co. or Unix System Laboratories, Inc. and are reproduced herein with
 * the permission of UNIX System Laboratories, Inc.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 4. Neither the name of the University nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE REGENTS OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 *
 *	@(#)signal.h	8.4 (Berkeley) 5/4/95
 * $FreeBSD$
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/_stdint.h

`SHA-256 49f8328943afa2a83ed4a35fcb808ed08b8c9fcb55373c786fb1b1d3a21952d7`

```text
/*
 * Copyright (c) 2004, 2005 by
 * Ralf Corsepius, Ulm/Germany. All rights reserved.
 *
 * Permission to use, copy, modify, and distribute this software
 * is freely granted, provided that this notice is preserved.
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/_timespec.h

`SHA-256 5441000af785218d81879835ed0531582fb9723e01f478533e13a174389763bf`

```text
/*-
 * Copyright (c) 1982, 1986, 1993
 *	The Regents of the University of California.  All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 4. Neither the name of the University nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE REGENTS OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 *
 *	@(#)time.h	8.5 (Berkeley) 5/4/95
 * from: FreeBSD: src/sys/sys/time.h,v 1.43 2000/03/20 14:09:05 phk Exp
 *	$FreeBSD$
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/_timeval.h

`SHA-256 7ce0f145b07ef9fbf8e23af8691eeaeae055a67e1ce5b04bdc7d4962a1a8f6d8`

```text
/*-
 * Copyright (c) 2002 Mike Barcroft <mike@FreeBSD.org>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 *
 * $FreeBSD$
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/_types.h

`SHA-256 9a0a8ea26b7306579294e2245416023343a631901d285f11c1c3786a4cbe4fa6`

```text
/* ANSI C namespace clean utility typedefs */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/cdefs.h

`SHA-256 d8db73988994274b0d28d8abddb8bc555a9687db55d1f54f680e0842e959d296`

```text
/* libc/sys/linux/sys/cdefs.h - Helper macros for K&R vs. ANSI C compat. */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/config.h

`SHA-256 8c41585c4d6f2e504ea8f7deb6df8ae91a0e81d4b6df4260d0ab540e24ba6291`

```text
/* floating point macros */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/features.h

`SHA-256 e9af0ce5e56dd9a07f64c5a4a27721d4178e796e3a1162e2a0015962287aa751`

```text
/*
 *  Written by Joel Sherrill <joel@OARcorp.com>.
 *
 *  COPYRIGHT (c) 1989-2014.
 *
 *  On-Line Applications Research Corporation (OAR).
 *
 *  Permission to use, copy, modify, and distribute this software for any
 *  purpose without fee is hereby granted, provided that this entire notice
 *  is included in all copies of any software which is or includes a copy
 *  or modification of this software.
 *
 *  THIS SOFTWARE IS BEING PROVIDED "AS IS", WITHOUT ANY EXPRESS OR IMPLIED
 *  WARRANTY.  IN PARTICULAR,  THE AUTHOR MAKES NO REPRESENTATION
 *  OR WARRANTY OF ANY KIND CONCERNING THE MERCHANTABILITY OF THIS
 *  SOFTWARE OR ITS FITNESS FOR ANY PARTICULAR PURPOSE.
 *
 *  $Id$
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/lock.h

`SHA-256 3e99f56b816ef7d676765b2c0f289d6686832d60a9645196df94ce0679ffe519`

```text
No explicit initial license notice; original source/header identity is fixed in source-manifest.json. Refer to the applicable aggregate license and upstream file.
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/reent.h

`SHA-256 869f2baadb176cf9f115462ab4137cd017fa8f46733147b781705aae2976ea1a`

```text
/* This header file provides the reentrancy.  */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/sched.h

`SHA-256 a905a789e215093f6207948dc700e0ce9789cba8b491a6f1b58888a79b466526`

```text
/*
 *  Written by Joel Sherrill <joel@OARcorp.com>.
 *
 *  COPYRIGHT (c) 1989-2010.
 *  On-Line Applications Research Corporation (OAR).
 *
 *  Permission to use, copy, modify, and distribute this software for any
 *  purpose without fee is hereby granted, provided that this entire notice
 *  is included in all copies of any software which is or includes a copy
 *  or modification of this software.
 *
 *  THIS SOFTWARE IS BEING PROVIDED "AS IS", WITHOUT ANY EXPRESS OR IMPLIED
 *  WARRANTY.  IN PARTICULAR,  THE AUTHOR MAKES NO REPRESENTATION
 *  OR WARRANTY OF ANY KIND CONCERNING THE MERCHANTABILITY OF THIS
 *  SOFTWARE OR ITS FITNESS FOR ANY PARTICULAR PURPOSE.
 *
 *  $Id$
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/select.h

`SHA-256 c7a8995e47c133c28b7e976aa5cc6877b4a439b9064e8f555f4aed673a786c60`

```text
/* We don't define fd_set and friends if we are compiling POSIX
   source, or if we have included (or may include as indicated
   by __USE_W32_SOCKETS) the W32api winsock[2].h header which
   defines Windows versions of them.   Note that a program which
   includes the W32api winsock[2].h header must know what it is doing;
   it must not call the Cygwin select function.
*/
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/stdio.h

`SHA-256 bd987ea6fed5d31d8a4e7d183a7d988e981ecca3cffce76ee482fcb0bf65594b`

```text
/* Internal locking macros, used to protect stdio functions.  In the
   general case, expand to nothing. Use __SSTR flag in FILE _flags to
   detect if FILE is private to sprintf/sscanf class of functions; if
   set then do nothing as lock is not initialised. */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/string.h

`SHA-256 d63f8a6c30f864eb6864e61262ebe6268b6f871d97dcc220be8b4a3f51e433a7`

```text
/* Copyright (c) 2017  SiFive Inc. All rights reserved.

   This copyrighted material is made available to anyone wishing to use,
   modify, copy, or redistribute it subject to the terms and conditions
   of the FreeBSD License.   This program is distributed in the hope that
   it will be useful, but WITHOUT ANY WARRANTY expressed or implied,
   including the implied warranties of MERCHANTABILITY or FITNESS FOR
   A PARTICULAR PURPOSE.  A copy of this license is available at
   http://www.opensource.org/licenses.
*/
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/timespec.h

`SHA-256 c2c2dfdcf9deacccb8919ff633f212afa455e4779a2d12c47b9afa0eff7d73c1`

```text
/*-
 * Copyright (c) 1982, 1986, 1993
 *	The Regents of the University of California.  All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 4. Neither the name of the University nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE REGENTS OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 *
 *	@(#)time.h	8.5 (Berkeley) 5/4/95
 * from: FreeBSD: src/sys/sys/time.h,v 1.43 2000/03/20 14:09:05 phk Exp
 *	$FreeBSD$
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/sys/types.h

`SHA-256 1949651d2e8fa7c60874fea8bea0531e380fcf60208961c2f904c5d92d0b22ea`

```text
/* unified sys/types.h: 
   start with sef's sysvi386 version.
   merge go32 version -- a few ifdefs.
   h8300hms, h8300xray, and sysvnecv70 disagree on the following types:

   typedef int gid_t;
   typedef int uid_t;
   typedef int dev_t;
   typedef int ino_t;
   typedef int mode_t;
   typedef int caddr_t;

   however, these aren't "reasonable" values, the sysvi386 ones make far 
   more sense, and should work sufficiently well (in particular, h8300 
   doesn't have a stat, and the necv70 doesn't matter.) -- eichin
 */
```

## official GNU toolchain 8.2.0 target headers/runtime / riscv64-unknown-elf/include/xlocale.h

`SHA-256 0497f21fb59dae453769fd40e174adba47faa877a5a5f072c6348d6a00c6845b`

```text
/* Definition of opaque POSIX-1.2008 type locale_t for userspace. */
```

## Runtime source / gcc-libgcc-soft-fp-divdf3.c

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `f1aa76ca810a4474961045132535615127b05bcca46e144746d0858d21927fbd`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Return a / b
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com) and
		  Jakub Jelinek (jj@ultra.linux.cz).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-muldf3.c

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `51acdbbc186f46638b096b85f4a31adb610af1b5c521a9cdcbe33584c265237b`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Return a * b
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com) and
		  Jakub Jelinek (jj@ultra.linux.cz).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-fixunsdfsi.c

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `3809cef2d010bc9a3f7aeed67df400bc34bff3fc01c5888b9f223f8351a7c6d4`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Convert a to 32bit unsigned integer
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com) and
		  Jakub Jelinek (jj@ultra.linux.cz).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-floatunsidf.c

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `6ef711d02a5cbf5f51c46cbc37f4577bbc27b358d2f5f5edeba92ca9e3867522`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Convert a 32bit unsigned integer to IEEE double
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com) and
		  Jakub Jelinek (jj@ultra.linux.cz).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-libgcc2.c

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `778a65e9c9a716868afb27c906859bb0cbe21e447ecb9fa15f044093c9f246c0`. Source header retained verbatim:

```text
/* More subroutines needed by GCC output code on some machines.  */
```

## Runtime source / gcc-libgcc-soft-fp-soft-fp.h

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `a1f3889c3fbd6d490df1d97547a925ddc9e951bb234ce7124e3ebeea14486409`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com),
		  Jakub Jelinek (jj@ultra.linux.cz),
		  David S. Miller (davem@redhat.com) and
		  Peter Maydell (pmaydell@chiark.greenend.org.uk).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-double.h

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `bf655a37ddd101e7408b7dcf3f0d49a0736bebabc0425d075abfe23061c13a39`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Definitions for IEEE Double Precision
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com),
		  Jakub Jelinek (jj@ultra.linux.cz),
		  David S. Miller (davem@redhat.com) and
		  Peter Maydell (pmaydell@chiark.greenend.org.uk).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-op-common.h

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `8a8b239b8ecb8c47b061d712e11ec014e2fd6a1a16212493e33f84819ad693d6`. Source header retained verbatim:

```text
/* Software floating-point emulation. Common operations.
   Copyright (C) 1997-2017 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com),
		  Jakub Jelinek (jj@ultra.linux.cz),
		  David S. Miller (davem@redhat.com) and
		  Peter Maydell (pmaydell@chiark.greenend.org.uk).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-op-1.h

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `2e1bf563a20df888175e9b3d2c842430b3d9f2d304b4e724b9b392bb486ccbdc`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Basic one-word fraction declaration and manipulation.
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com),
		  Jakub Jelinek (jj@ultra.linux.cz),
		  David S. Miller (davem@redhat.com) and
		  Peter Maydell (pmaydell@chiark.greenend.org.uk).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-op-2.h

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `cf7a8894847d698073fc91bf02de7dd437bf1427918a6b93bbde541d9eccabe0`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Basic two-word fraction declaration and manipulation.
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com),
		  Jakub Jelinek (jj@ultra.linux.cz),
		  David S. Miller (davem@redhat.com) and
		  Peter Maydell (pmaydell@chiark.greenend.org.uk).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-op-4.h

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `15f45a5d0acbfd21e3404362a8c990f0cbed2dde010a925f5e43fc6f446c27e9`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Basic four-word fraction declaration and manipulation.
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com),
		  Jakub Jelinek (jj@ultra.linux.cz),
		  David S. Miller (davem@redhat.com) and
		  Peter Maydell (pmaydell@chiark.greenend.org.uk).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-soft-fp-op-8.h

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `ca9b4d06ec36d35a97056903c9e330e8d2d122d2e569b7fd5e7f603eed54ed9c`. Source header retained verbatim:

```text
/* Software floating-point emulation.
   Basic eight-word fraction declaration and manipulation.
   Copyright (C) 1997-2016 Free Software Foundation, Inc.
   This file is part of the GNU C Library.
   Contributed by Richard Henderson (rth@cygnus.com),
		  Jakub Jelinek (jj@ultra.linux.cz) and
		  Peter Maydell (pmaydell@chiark.greenend.org.uk).

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```

## Runtime source / gcc-libgcc-config-riscv-sfp-machine.h

Fixed GCC commit `bce905d919791374b0dbeb2d02ece8fae98ece5e`; SHA-256 `1dbf2fc348000e789635af738d3b1fe41573aabdf59876422a7fc063a2c55371`. Source header retained verbatim:

```text
/* Software floating-point machine description for RISC-V.

   Copyright (C) 2016-2018 Free Software Foundation, Inc.

This file is part of GCC.

GCC is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free
Software Foundation; either version 3, or (at your option) any later
version.

GCC is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
for more details.

Under Section 7 of GPL version 3, you are granted additional
permissions described in the GCC Runtime Library Exception, version
3.1, as published by the Free Software Foundation.

You should have received a copy of the GNU General Public License and
a copy of the GCC Runtime Library Exception along with this program;
see the files COPYING3 and COPYING.RUNTIME respectively.  If not, see
<http://www.gnu.org/licenses/>.  */
```

## Runtime source / include/longlong.h

Fixed GCC commit bce905d919791374b0dbeb2d02ece8fae98ece5e; SHA-256 `01ae4e4e2e35b91cd979b0fd6bacf1bcaa3c440070fa21b666b5e3887165d688`.

```text
/* longlong.h -- definitions for mixed size 32/64 bit arithmetic.
   Copyright (C) 1991-2018 Free Software Foundation, Inc.

   This file is part of the GNU C Library.

   The GNU C Library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   In addition to the permissions in the GNU Lesser General Public
   License, the Free Software Foundation gives you unlimited
   permission to link the compiled version of this file into
   combinations with other programs, and to distribute those
   combinations without any restriction coming from the use of this
   file.  (The Lesser General Public License restrictions do apply in
   other respects; for example, they cover modification of the file,
   and distribution when not linked into a combine executable.)

   The GNU C Library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with the GNU C Library; if not, see
   <http://www.gnu.org/licenses/>.  */
```
