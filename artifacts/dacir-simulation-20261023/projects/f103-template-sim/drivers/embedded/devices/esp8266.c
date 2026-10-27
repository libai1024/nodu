/* Modified 2026-10-23: generic file and API names; original license retained. */
/* SPDX-License-Identifier: AGPL-3.0-only */
#include "esp8266.h"
#include <string.h>

enum { EXPECT_OK = 1, EXPECT_PROMPT, EXPECT_SEND };
static size_t length_of(const char *s) { size_t n = 0; if (s) while (s[n]) ++n; return n; }
static int same(const char *a, const char *b) { while (*a && *a == *b) { ++a; ++b; } return *a == *b; }
static int begins(const char *a, const char *b) { while (*b) if (*a++ != *b++) return 0; return 1; }
static esp8266_status_t fail(esp8266_t *d, esp8266_status_t status, int desync)
{ d->status = status; d->expect = 0; if (desync) d->desynchronized = 1; return status; }
static void result_line(esp8266_t *d)
{
    d->line[d->line_used] = 0;
    if (same(d->line, "WIFI CONNECTED") || same(d->line, "WIFI GOT IP")) d->wifi_connected = 1;
    if (same(d->line, "WIFI DISCONNECT")) { d->wifi_connected = 0; d->tcp_connected = 0; }
    if (same(d->line, "CONNECT")) d->tcp_connected = 1;
    if (same(d->line, "CLOSED")) d->tcp_connected = 0;
    if (same(d->line, "ready")) { d->wifi_connected = 0; d->tcp_connected = 0; }
    if (d->status != ESP8266_BUSY) return;
    if (same(d->line, "ERROR") || same(d->line, "FAIL") || same(d->line, "SEND FAIL") ||
        begins(d->line, "busy ") || same(d->line, "link is not valid")) fail(d, ESP8266_ERROR, 0);
    else if ((d->expect == EXPECT_OK && same(d->line, "OK")) ||
             (d->expect == EXPECT_SEND && same(d->line, "SEND OK"))) fail(d, ESP8266_OK, 0);
}
static void feed(esp8266_t *d, uint8_t c)
{
    if (d->payload_left) {
        uint16_t next = (uint16_t)((d->rx_head + 1u) % ESP8266_RX_SIZE);
        if (next == d->rx_tail) { ++d->overflow_count; fail(d, ESP8266_OVERFLOW, 1); }
        else { d->rx[d->rx_head] = c; d->rx_head = next; }
        --d->payload_left;
        return;
    }
    if (c == '>' && !d->line_used && d->expect == EXPECT_PROMPT && d->status == ESP8266_BUSY) {
        fail(d, ESP8266_OK, 0); return;
    }
    if (c == '\r') return;
    if (c == '\n') {
        if (!d->line_drop) result_line(d);
        d->line_used = 0; d->line_drop = 0; return;
    }
    if (!d->line_used && c == ' ') return; /* optional space after send prompt */
    if (c == ':' && d->line_used >= 5 && begins(d->line, "+IPD,")) {
        uint32_t count = 0; unsigned i;
        for (i = 5; i < d->line_used; ++i) {
            if (d->line[i] < '0' || d->line[i] > '9' || count > 6553u) break;
            count = count * 10u + (unsigned)(d->line[i] - '0');
        }
        if (i != d->line_used || i == 5 || count > 65535u) { fail(d, ESP8266_DESYNC, 1); d->line_drop = 1; return; }
        d->payload_left = count; d->line_used = 0; return;
    }
    if (d->line_drop) return;
    if (d->line_used + 1u >= sizeof(d->line)) {
        ++d->overflow_count; d->line_drop = 1; fail(d, ESP8266_OVERFLOW, 1); return;
    }
    d->line[d->line_used++] = (char)c; d->line[d->line_used] = 0;
}
esp8266_status_t esp8266_init(esp8266_t *d, const esp8266_io_t *io)
{
    if (!d || !io || !io->write || !io->read || !io->millis) return ESP8266_ARGUMENT;
    memset(d, 0, sizeof(*d)); d->io = *io; return ESP8266_OK;
}
esp8266_status_t esp8266_poll(esp8266_t *d)
{
    if (!d || !d->io.read) return ESP8266_ARGUMENT;
    for (unsigned i = 0; i < 64; ++i) {
        int c = d->io.read(d->io.user);
        if (c == -1) break;
        if (c < -1 || c > 255) return fail(d, ESP8266_IO, 1);
        feed(d, (uint8_t)c);
    }
    if (d->status == ESP8266_BUSY && (uint32_t)(d->io.millis(d->io.user) - d->started_ms) >= d->timeout_ms)
        fail(d, ESP8266_TIMEOUT, 1);
    return d->status;
}
size_t esp8266_receive(esp8266_t *d, uint8_t *data, size_t capacity)
{
    size_t n = 0;
    if (!d || (!data && capacity)) return 0;
    while (n < capacity && d->rx_tail != d->rx_head) {
        data[n++] = d->rx[d->rx_tail]; d->rx_tail = (uint16_t)((d->rx_tail + 1u) % ESP8266_RX_SIZE);
    }
    return n;
}
static esp8266_status_t start(esp8266_t *d, const char *cmd, uint32_t timeout, unsigned expected)
{
    size_t n = length_of(cmd);
    if (!d || !d->io.write || !cmd || !n || n >= ESP8266_LINE_SIZE || !timeout || timeout > 0x7fffffffu) return ESP8266_ARGUMENT;
    if (d->status == ESP8266_BUSY) return ESP8266_BUSY;
    if (d->desynchronized) return ESP8266_DESYNC;
    for (size_t i = 0; i < n; ++i) if (cmd[i] == '\r' || cmd[i] == '\n') return ESP8266_ARGUMENT;
    esp8266_poll(d); /* process already queued async events before starting a new transaction */
    if (d->desynchronized) return ESP8266_DESYNC;
    d->expect = (uint8_t)expected; d->status = ESP8266_BUSY;
    d->started_ms = d->io.millis(d->io.user); d->timeout_ms = timeout;
    if (!d->io.write(d->io.user, (const uint8_t *)cmd, n) || !d->io.write(d->io.user, (const uint8_t *)"\r\n", 2))
        return fail(d, ESP8266_IO, 1);
    return ESP8266_BUSY;
}
esp8266_status_t esp8266_command(esp8266_t *d, const char *cmd, uint32_t timeout)
{ return start(d, cmd, timeout, EXPECT_OK); }
esp8266_status_t esp8266_wait(esp8266_t *d)
{
    if (!d) return ESP8266_ARGUMENT;
    while (esp8266_poll(d) == ESP8266_BUSY) if (d->io.idle) d->io.idle(d->io.user);
    return d->status;
}
esp8266_status_t esp8266_exec(esp8266_t *d, const char *cmd, uint32_t timeout)
{
    if (d && d->status == ESP8266_BUSY) return ESP8266_BUSY;
    esp8266_status_t s = esp8266_command(d, cmd, timeout);
    return s == ESP8266_BUSY ? esp8266_wait(d) : s;
}
esp8266_status_t esp8266_configure(esp8266_t *d, uint32_t timeout)
{
    const char *commands[] = {"AT", "ATE0", "AT+CWMODE=1", "AT+CIPMUX=0"};
    for (unsigned i = 0; i < sizeof(commands) / sizeof(commands[0]); ++i) {
        esp8266_status_t s = esp8266_exec(d, commands[i], timeout); if (s != ESP8266_OK) return s;
    }
    return ESP8266_OK;
}
static int append(char *out, size_t *n, const char *s)
{
    while (*s) { if (*n + 1u >= ESP8266_LINE_SIZE) return 0; out[(*n)++] = *s++; }
    out[*n] = 0; return 1;
}
static int quoted(char *out, size_t *n, const char *s)
{
    if (!s || !append(out, n, "\"")) return 0;
    while (*s) {
        unsigned char c = (unsigned char)*s++;
        if (c < 32 || c == 127) return 0;
        if ((c == '"' || c == '\\' || c == ',') && !append(out, n, "\\")) return 0;
        if (*n + 2u >= ESP8266_LINE_SIZE) return 0;
        out[(*n)++] = (char)c;
    }
    out[*n] = 0; return append(out, n, "\"");
}
static void decimal(char *out, uint32_t value)
{
    char reverse[10]; unsigned count = 0, i = 0;
    do { reverse[count++] = (char)('0' + value % 10u); value /= 10u; } while (value);
    while (count) out[i++] = reverse[--count];
    out[i] = 0;
}
esp8266_status_t esp8266_join(esp8266_t *d, const char *ssid, const char *password, uint32_t timeout)
{
    char cmd[ESP8266_LINE_SIZE]; size_t n = 0;
    if (!ssid || !*ssid || length_of(ssid) > 32 || !password || length_of(password) > 64) return ESP8266_ARGUMENT;
    if (!append(cmd, &n, "AT+CWJAP=") || !quoted(cmd, &n, ssid) || !append(cmd, &n, ",") || !quoted(cmd, &n, password)) return ESP8266_ARGUMENT;
    return esp8266_exec(d, cmd, timeout);
}
esp8266_status_t esp8266_tcp_connect(esp8266_t *d, const char *host, uint16_t port, uint32_t timeout)
{
    char cmd[ESP8266_LINE_SIZE], number[11]; size_t n = 0;
    if (!host || !*host || length_of(host) > 127 || !port) return ESP8266_ARGUMENT;
    decimal(number, port);
    if (!append(cmd, &n, "AT+CIPSTART=\"TCP\",") || !quoted(cmd, &n, host) || !append(cmd, &n, ",") || !append(cmd, &n, number)) return ESP8266_ARGUMENT;
    return esp8266_exec(d, cmd, timeout);
}
esp8266_status_t esp8266_tcp_send(esp8266_t *d, const uint8_t *data, size_t length, uint32_t timeout)
{
    char cmd[ESP8266_LINE_SIZE], number[11]; size_t n = 0;
    if (!d || !data || !length || length > ESP8266_SEND_MAX) return ESP8266_ARGUMENT;
    if (d->status == ESP8266_BUSY) return ESP8266_BUSY;
    decimal(number, (uint32_t)length); append(cmd, &n, "AT+CIPSEND="); append(cmd, &n, number);
    esp8266_status_t s = start(d, cmd, timeout, EXPECT_PROMPT);
    if (s != ESP8266_BUSY || (s = esp8266_wait(d)) != ESP8266_OK) return s;
    d->status = ESP8266_BUSY; d->expect = EXPECT_SEND; d->started_ms = d->io.millis(d->io.user);
    if (!d->io.write(d->io.user, data, length)) return fail(d, ESP8266_IO, 1);
    return esp8266_wait(d);
}
esp8266_status_t esp8266_tcp_close(esp8266_t *d, uint32_t timeout)
{ return esp8266_exec(d, "AT+CIPCLOSE", timeout); }

static size_t mqtt_header(uint8_t *out, size_t cap, uint8_t header, size_t body)
{
    size_t needed = body < 128 ? 2 : 3;
    if (!out || body > ESP8266_MQTT_SIZE || cap < body + needed) return 0;
    out[0] = header; out[1] = (uint8_t)(body % 128);
    if (needed == 3) { out[1] |= 128; out[2] = (uint8_t)(body / 128); }
    return needed;
}
static void put16(uint8_t *out, uint16_t value) { out[0] = (uint8_t)(value >> 8); out[1] = (uint8_t)value; }
size_t esp8266_mqtt_connect(uint8_t *out, size_t cap, const char *id, uint16_t keepalive)
{
    static const uint8_t base[] = {0, 4, 'M', 'Q', 'T', 'T', 4, 2};
    size_t length = length_of(id), n;
    if (!id || !length || length > 64 || !(n = mqtt_header(out, cap, 0x10, 12 + length))) return 0;
    memcpy(out + n, base, sizeof(base)); put16(out + n + 8, keepalive); put16(out + n + 10, (uint16_t)length);
    memcpy(out + n + 12, id, length); return n + 12 + length;
}
size_t esp8266_mqtt_subscribe(uint8_t *out, size_t cap, const char *topic, uint16_t id)
{
    size_t length = length_of(topic), n;
    if (!topic || !length || length > 128 || !id || !(n = mqtt_header(out, cap, 0x82, 5 + length))) return 0;
    put16(out + n, id); put16(out + n + 2, (uint16_t)length); memcpy(out + n + 4, topic, length);
    out[n + 4 + length] = 0; return n + 5 + length;
}
size_t esp8266_mqtt_publish(uint8_t *out, size_t cap, const char *topic, const uint8_t *payload, size_t length)
{
    size_t tlen = length_of(topic), n;
    if (!topic || !tlen || tlen > 128 || (!payload && length) || length > ESP8266_MQTT_SIZE - 2 - tlen ||
        !(n = mqtt_header(out, cap, 0x30, 2 + tlen + length))) return 0;
    for (size_t i = 0; i < tlen; ++i) if (topic[i] == '+' || topic[i] == '#') return 0;
    put16(out + n, (uint16_t)tlen); memcpy(out + n + 2, topic, tlen);
    if (length) memcpy(out + n + 2 + tlen, payload, length);
    return n + 2 + tlen + length;
}
void esp8266_mqtt_init(esp8266_mqtt_t *m) { if (m) memset(m, 0, sizeof(*m)); }
static esp8266_mqtt_event_t mqtt_complete(esp8266_mqtt_t *m)
{
    m->state = 0; m->topic_length = 0; m->payload_length = 0; m->packet_id = 0;
    if (m->header == 0x20 && m->used == 2 && !m->packet[0] && m->packet[1] <= 5) {
        m->return_code = m->packet[1]; return ESP_MQTT_CONNACK;
    }
    if (m->header == 0x90 && m->used == 3 && (m->packet[2] <= 2 || m->packet[2] == 128)) {
        m->packet_id = (uint16_t)((m->packet[0] << 8) | m->packet[1]);
        if (!m->packet_id) return ESP_MQTT_INVALID;
        m->return_code = m->packet[2]; return ESP_MQTT_SUBACK;
    }
    if ((m->header & 0xfe) == 0x30 && m->used >= 2) { /* QoS0; DUP=0; retained flag accepted */
        uint16_t length = (uint16_t)((m->packet[0] << 8) | m->packet[1]);
        if (!length || length > m->used - 2) return ESP_MQTT_INVALID;
        m->topic_offset = 2; m->topic_length = length; m->payload_offset = (uint16_t)(2 + length);
        m->payload_length = (uint16_t)(m->used - m->payload_offset); return ESP_MQTT_PUBLISH;
    }
    if (m->header == 0xd0 && !m->used) return ESP_MQTT_PINGRESP;
    return ESP_MQTT_INVALID;
}
esp8266_mqtt_event_t esp8266_mqtt_feed(esp8266_mqtt_t *m, uint8_t byte)
{
    if (!m) return ESP_MQTT_INVALID;
    if (m->state == 4) return ESP_MQTT_INVALID; /* malformed length requires explicit stream reset */
    if (m->discard_left) { --m->discard_left; if (!m->discard_left) m->state = 0; return ESP_MQTT_NONE; }
    if (!m->state) {
        m->header = byte; m->remaining = 0; m->multiplier = 1; m->length_bytes = 0; m->used = 0; m->state = 1;
        return ESP_MQTT_NONE;
    }
    if (m->state == 1) {
        m->remaining += (byte & 127u) * m->multiplier;
        if (++m->length_bytes == 4 && (byte & 128)) { m->state = 4; return ESP_MQTT_INVALID; }
        if (byte & 128) { m->multiplier *= 128; return ESP_MQTT_NONE; }
        if (m->length_bytes > 1 && !(byte & 127)) { m->state = 4; return ESP_MQTT_INVALID; }
        if (m->remaining > sizeof(m->packet)) { m->discard_left = m->remaining; m->state = 3; return ESP_MQTT_INVALID; }
        m->state = 2; if (!m->remaining) return mqtt_complete(m); return ESP_MQTT_NONE;
    }
    m->packet[m->used++] = byte;
    return m->used == m->remaining ? mqtt_complete(m) : ESP_MQTT_NONE;
}
