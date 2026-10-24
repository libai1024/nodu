// SPDX-License-Identifier: MIT
/** Shared by planned lessons and the conversation that corrects them. */
export const TUTOR_CODE_POLICY = '工程API以本次提供的declarations及源码为准，用户提及的函数名不是存在性证明。按真实原型传参，不省略必填参数。若用户或旧计划提到了未声明的API，先纠正这一前提，优先使用已声明且能完成同一功能的API；不要为了凑名字建议只补声明，也不要在虚影中调用未知函数。上下文不足时不提供guidance，说明具体缺什么。计划步骤描述要实现的功能和位置，不提前给出未经当前源码核对的调用代码。批注和文件链接使用实际代码行号，光标所在行不等于代码所在行。字符串发送长度使用sizeof(字符串数组)-1，避免手算；C换行使用\\r\\n并正确JSON转义。';
