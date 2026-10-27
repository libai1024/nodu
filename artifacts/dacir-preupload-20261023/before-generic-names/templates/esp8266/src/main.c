/* SPDX-License-Identifier: AGPL-3.0-only
 * ESP-01S UART/TCP/MQTT teaching application, STM32F103C8T6 fixed 72 MHz.
 * Console on PA9/PA10 changes runtime credentials/address without rebuilding.
 * Network downlink, not console/UI, controls PB13 LED. DHT11 DATA = PB1.
 */
#include "studio.h"
#include "esp_io.h"
#include "DX_device_esp8266.h"
#include <string.h>
static esp8266_t esp;
static esp8266_mqtt_t mqtt;
static char ssid[33] = "Studio-Lab", password[65] = "studio123", host[128] = "127.0.0.1";
static uint16_t port = 18883;
static uint8_t mqtt_mode, mqtt_connected, mqtt_subscribed, led_state, pending_subscribe;
static uint8_t packet[ESP8266_MQTT_SIZE + 4];
static uint32_t next_sample, last_ping, sample, sequence;
static char tcp_line[32];
static size_t tcp_used;
static uint8_t tcp_dropped;
static size_t text_length(const char *s) { size_t n=0; while(s[n]) ++n; return n; }
static int equal(const char *a, const char *b) { while(*a && *a==*b) { ++a; ++b; } return *a==*b; }
static int prefix(const char *a, const char *b) { while(*b) if(*a++!=*b++) return 0; return 1; }
static int different(const void *a, const void *b, size_t n)
{ const uint8_t *x=a,*y=b; while(n--) if(*x++!=*y++) return 1; return 0; }
static int copy(char *out, size_t cap, const char *value)
{ size_t n=text_length(value); if(n>=cap) return 0; memcpy(out,value,n+1); return 1; }
static void log_status(const char *operation, unsigned status)
{
    studio_uart_write("{\"event\":\"esp_result\",\"seq\":"); esp_number(++sequence);
    studio_uart_write(",\"operation\":\""); studio_uart_write(operation);
    studio_uart_write("\",\"status\":"); esp_number(status);
    studio_uart_write(",\"tick_ms\":"); esp_number(HAL_GetTick());
    studio_uart_write(",\"wifi\":"); esp_number(esp.wifi_connected);
    studio_uart_write(",\"tcp\":"); esp_number(esp.tcp_connected);
    studio_uart_write(",\"led\":"); esp_number(led_state);
    studio_uart_write(",\"uart_errors\":"); esp_number(esp_io_errors()); studio_uart_write("}\r\n");
}
static void log_bytes(const uint8_t *bytes, size_t length)
{
    static const char digits[]="0123456789abcdef";
    studio_uart_write("{\"event\":\"esp_rx\",\"hex\":\"");
    for(size_t i=0;i<length;i++) { char s[3]={digits[bytes[i]>>4],digits[bytes[i]&15],0}; studio_uart_write(s); }
    studio_uart_write("\",\"tick_ms\":"); esp_number(HAL_GetTick()); studio_uart_write("}\r\n");
}
static void downlink(const uint8_t *bytes, size_t length)
{
    int value=-1;
    if((length==2 && bytes[0]=='O' && bytes[1]=='N') || (length==5 && !different(bytes,"LED=1",5))) value=1;
    if((length==3 && !different(bytes,"OFF",3)) || (length==5 && !different(bytes,"LED=0",5))) value=0;
    if(value>=0) {
        led_state=(uint8_t)value; HAL_GPIO_WritePin(GPIOB,GPIO_PIN_13,value?GPIO_PIN_SET:GPIO_PIN_RESET);
        log_status("network_led",ESP8266_OK);
    }
}
static void receive_network(void)
{
    uint8_t bytes[64]; size_t n;
    esp8266_poll(&esp);
    while((n=esp8266_receive(&esp,bytes,sizeof(bytes)))) {
        log_bytes(bytes,n);
        for(size_t i=0;i<n;i++) {
            if(mqtt_mode) {
                esp8266_mqtt_event_t event=esp8266_mqtt_feed(&mqtt,bytes[i]);
                if(event==ESP_MQTT_CONNACK) {
                    mqtt_connected=mqtt.return_code==0; pending_subscribe=mqtt_connected;
                    log_status("mqtt_connack",mqtt.return_code);
                } else if(event==ESP_MQTT_SUBACK) {
                    mqtt_subscribed=mqtt.packet_id==1 && mqtt.return_code==0;
                    log_status("mqtt_suback",mqtt_subscribed?0:3);
                } else if(event==ESP_MQTT_PUBLISH && mqtt.topic_length==14 && !different(mqtt.packet+mqtt.topic_offset,"studio/control",14)) {
                    downlink(mqtt.packet+mqtt.payload_offset,mqtt.payload_length);
                } else if(event==ESP_MQTT_PINGRESP) log_status("mqtt_pong",0);
                else if(event==ESP_MQTT_INVALID) { mqtt_connected=mqtt_subscribed=0; log_status("mqtt_invalid",3); }
            } else if(bytes[i]=='\n') { if(!tcp_dropped) downlink((const uint8_t *)tcp_line,tcp_used); tcp_used=0; tcp_dropped=0; }
            else if(bytes[i]!='\r') { if(tcp_used<sizeof(tcp_line)) tcp_line[tcp_used++]=(char)bytes[i]; else tcp_dropped=1; }
        }
    }
    if(!esp.tcp_connected) { mqtt_connected=mqtt_subscribed=pending_subscribe=0; tcp_used=0; tcp_dropped=0; }
    if(pending_subscribe) {
        pending_subscribe=0;
        size_t length=esp8266_mqtt_subscribe(packet,sizeof(packet),"studio/control",1);
        log_status("mqtt_subscribe",esp8266_tcp_send(&esp,packet,length,5000));
    }
}
static void reset_module(void)
{
    esp_io_reset_module(); esp8266_io_t io=esp_io_callbacks(); esp8266_init(&esp,&io);
    esp8266_mqtt_init(&mqtt); mqtt_mode=mqtt_connected=mqtt_subscribed=pending_subscribe=0;
    tcp_used=0; tcp_dropped=0;
}
static unsigned connect_wifi(void)
{
    unsigned status=esp8266_configure(&esp,2000);
    if(!status) status=esp8266_join(&esp,ssid,password,20000);
    return status;
}
static int hex_digit(char c)
{ return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1; }
static void command(char *line)
{
    unsigned status=ESP8266_ARGUMENT; const char *op="command";
    if(equal(line,"RESET")) { reset_module(); status=0; op="reset"; }
    else if(equal(line,"STATUS")) { status=esp.status; op="status"; }
    else if(equal(line,"JOIN")) { op="join"; status=connect_wifi(); }
    else if(equal(line,"TCP")) { mqtt_mode=0; op="tcp"; status=esp8266_tcp_connect(&esp,host,port,10000); }
    else if(equal(line,"CLOSE")) { op="close"; status=esp8266_tcp_close(&esp,5000); mqtt_connected=mqtt_subscribed=0; }
    else if(prefix(line,"AT")) { op="at"; status=esp8266_exec(&esp,line,5000); }
    else if(prefix(line,"SERVER ")) {
        char *split=line+7; while(*split && *split!=' ') ++split;
        if(*split) { *split++=0; uint32_t p=0; unsigned digits=0;
            while(*split>='0' && *split<='9' && digits<5) { p=p*10+(*split++-'0'); ++digits; }
            if(!*split && p && p<=65535 && copy(host,sizeof(host),line+7)) { port=(uint16_t)p; status=0; }
        } op="server";
    } else if(prefix(line,"WIFI ")) {
        char *split=line+5; while(*split && *split!='|') ++split;
        if(*split) { *split++=0;
            if(text_length(line+5)>0 && text_length(line+5)<sizeof(ssid) && text_length(split)<sizeof(password)) {
                copy(ssid,sizeof(ssid),line+5); copy(password,sizeof(password),split); status=0;
            }
        } op="wifi_config"; /* never echo credentials to logs */
    } else if(prefix(line,"TEXT ")) { op="send"; status=esp8266_tcp_send(&esp,(uint8_t *)line+5,text_length(line+5),5000); }
    else if(prefix(line,"SEND ")) {
        size_t n=text_length(line+5), count=0; int valid=n>0 && !(n&1) && n/2<=sizeof(packet);
        for(size_t i=5;valid && line[i];i+=2) { int a=hex_digit(line[i]),b=hex_digit(line[i+1]);
            if(a<0 || b<0) valid=0; else packet[count++]=(uint8_t)(a*16+b);
        } op="send"; if(valid) status=esp8266_tcp_send(&esp,packet,count,5000);
    } else if(equal(line,"MQTT")) {
        op="mqtt_connect"; status=connect_wifi();
        if(!status) status=esp8266_tcp_connect(&esp,host,port,10000);
        if(!status) {
            esp8266_mqtt_init(&mqtt); mqtt_mode=1; mqtt_connected=mqtt_subscribed=0;
            /* Broker keepalive is wall-clock time. Slow electrical simulation
             * needs headroom; choose the production value for the real network. */
            size_t n=esp8266_mqtt_connect(packet,sizeof(packet),"stm32-study",300);
            status=esp8266_tcp_send(&esp,packet,n,5000); last_ping=HAL_GetTick();
        }
    } else if(prefix(line,"PUB ")) {
        op="publish";
        if(mqtt_connected && mqtt_subscribed) {
            size_t n=esp8266_mqtt_publish(packet,sizeof(packet),"studio/telemetry",(uint8_t *)line+4,text_length(line+4));
            status=esp8266_tcp_send(&esp,packet,n,5000);
        }
    }
    log_status(op,status);
}
static char *append_number(char *p, uint32_t n)
{ char reverse[10]; unsigned count=0; do { reverse[count++]='0'+n%10; n/=10; } while(n); while(count) *p++=reverse[--count]; *p=0; return p; }
static char *append_text(char *p, const char *text) { while(*text) *p++=*text++; *p=0; return p; }
static void publish_sensor(void)
{
    dht11_reading_t reading; uint8_t status=dht11_read(&reading);
    char payload[128], *p=payload;
    p=append_text(p,"{\"sample\":"); p=append_number(p,++sample);
    p=append_text(p,",\"dht_status\":"); p=append_number(p,status);
    p=append_text(p,",\"temperature_tenths\":");
    p=status?append_text(p,"null"):append_number(p,(uint32_t)reading.temperature_tenths);
    p=append_text(p,",\"humidity_tenths\":"); p=status?append_text(p,"null"):append_number(p,reading.humidity_tenths);
    p=append_text(p,",\"led\":"); p=append_number(p,led_state); append_text(p,"}");
    size_t n=esp8266_mqtt_publish(packet,sizeof(packet),"studio/telemetry",(uint8_t *)payload,text_length(payload));
    log_status("sensor_publish",esp8266_tcp_send(&esp,packet,n,5000));
}
int main(void)
{
    studio_board_init(); esp_io_init(); dht11_config(GPIOB,GPIO_PIN_1); dht11_init();
    reset_module();
    studio_uart_write("{\"event\":\"esp_ready\",\"uart\":"); esp_number(ESP_UART3?3:2);
    studio_uart_write(",\"baud\":"); esp_number(ESP_BAUD); studio_uart_write("}\r\n");
    char line[512]; size_t used=0; uint8_t drop=0;
    for(;;) {
        receive_network();
        int ch=esp_console_read();
        if(ch==-2) { drop=1; log_status("console_overflow",ESP8266_IO); }
        else if(ch=='\n') {
            line[used]=0; if(!drop && used) command(line); else if(drop) log_status("console_overflow",ESP8266_OVERFLOW);
            used=0; drop=0;
        } else if(ch>=0 && ch!='\r') { if(used+1<sizeof(line)) line[used++]=(char)ch; else drop=1; }
        uint32_t now=HAL_GetTick();
        if(mqtt_connected && mqtt_subscribed && (int32_t)(now-next_sample)>=0) { next_sample=now+2500; publish_sensor(); }
        if(mqtt_connected && (uint32_t)(now-last_ping)>=15000) {
            const uint8_t ping[]={0xc0,0}; last_ping=now; log_status("mqtt_ping",esp8266_tcp_send(&esp,ping,2,5000));
        }
    }
}
