#!/usr/bin/env python3
import socket, threading, time, sys

IH = bytes.fromhex('b47882a62eedec7767aa86b7a866f1dd846c5357')
REPLY = bytes([19]) + b'BitTorrent protocol' + bytes([0,0,0,0,0,0x10,0,0]) + IH + b'-TEST01-localpeer001'

def handle(conn, addr):
    print('ACCEPT', addr, flush=True)
    try:
        conn.settimeout(10)
        data = b''
        while len(data) < 68:
            chunk = conn.recv(68 - len(data))
            if not chunk:
                break
            data += chunk
        print('RECV', len(data), data.hex(), 'hashmatch', len(data) >= 48 and data[28:48] == IH, flush=True)
        conn.sendall(REPLY)
        print('SENT', len(REPLY), flush=True)
        time.sleep(20)
    except Exception as e:
        print('ERROR', type(e).__name__, e, flush=True)
    finally:
        conn.close()

def main():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('0.0.0.0', 9999))
    s.listen(8)
    print('LISTEN 9999', flush=True)
    while True:
        conn, addr = s.accept()
        threading.Thread(target=handle, args=(conn, addr), daemon=True).start()

main()
