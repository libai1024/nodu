#include "main.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

volatile uint32_t nodu_loop_count;
static uint8_t rx[512];
static unsigned used;
static int streaming;
static uint32_t sequence;
static void send_bytes(const uint8_t *data, unsigned n) { Board_DebugWrite((const char *)data, n); }
static void command(void) {
    unsigned end = used;
    while (end && (rx[end-1] == '\r' || rx[end-1] == '\n')) end--;
    char cmd[513]; memcpy(cmd, rx, end); cmd[end] = 0;
    if (!strcmp(cmd, "PING")) puts("PONG\r");
    else if (!strcmp(cmd, "UTF8")) { const uint8_t text[] = {228,184,173,230,150,135,228,184,178,229,143,163,230,181,139,232,175,149};
        for (unsigned i=0;i<sizeof(text);i++) { send_bytes(text+i,1); HAL_Delay(55); } puts("\r"); }
    else if (!strcmp(cmd, "GBK")) { const uint8_t text[] = {214,208,206,196,180,174,191,218,178,226,202,212};
        for (unsigned i=0;i<sizeof(text);i++) { send_bytes(text+i,1); HAL_Delay(55); } puts("\r"); }
    else if (!strcmp(cmd, "BINARY")) { const uint8_t raw[]={0,1,10,13,127,128,255,195,40,0,126}; send_bytes(raw,sizeof(raw)); }
    else if (!strcmp(cmd, "BURST")) { for (unsigned i=0;i<1000;i++) printf("BURST %04u abcdefghijklmnopqrstuvwxyz\r\n",i); }
    else if (!strcmp(cmd, "LONG")) { for (unsigned i=0;i<20000;i++) Board_DebugWrite("x",1); puts("\r"); }
    else if (!strcmp(cmd, "STREAM")) { streaming=1; sequence=0; puts("STREAM ON\r"); }
    else if (!strcmp(cmd, "STOP")) { streaming=0; puts("STREAM OFF\r"); }
    else if (!strncmp(cmd,"BAUD:",5)) { unsigned baud=atoi(cmd+5); if(baud==9600 || baud==115200) { puts("BAUD OK\r"); HAL_Delay(200); Board_DebugUartInit(baud); puts("READY\r"); } }
    else { printf("RX[%u]:",used); for(unsigned i=0;i<used;i++) printf("%02x",rx[i]); printf("\r\nECHO:"); send_bytes(rx,used); printf("\r\n"); }
    used=0;
}
int main(void) {
    HAL_Init(); SystemClock_Config(); Board_DebugUartInit(115200);
    puts("NODU UART READY\r");
    uint32_t last=HAL_GetTick(), report=last;
    while(1) {
        uint8_t byte; nodu_loop_count++;
        if(Board_DebugRead(&byte)) { if(used<sizeof(rx)) rx[used++]=byte; last=HAL_GetTick(); }
        if(used && HAL_GetTick()-last>40) command();
        if(streaming && HAL_GetTick()-report>=100) { printf("STREAM %06lu\r\n",(unsigned long)sequence++); report=HAL_GetTick(); }
    }
}
void Error_Handler(void) { __disable_irq(); while(1){} }
