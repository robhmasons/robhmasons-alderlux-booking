# Tiny local SMTP sink for testing: accepts AUTH LOGIN, stores each message as a file.
import asyncio, base64, sys, os, itertools
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True); n = itertools.count(1)
async def handle(r, w):
    def say(s): w.write((s + "\r\n").encode())
    say("220 sink ESMTP"); await w.drain(); state = None; mail_from = rcpt = None
    while True:
        line = await r.readline()
        if not line: break
        l = line.decode().rstrip("\r\n")
        if state == "user": user = base64.b64decode(l).decode(); say("334 UGFzc3dvcmQ6"); state = "pass"
        elif state == "pass": pw = base64.b64decode(l).decode(); say("235 ok" if pw == "test-pass" else "535 bad"); state = None; open(f"{OUT}/auth.txt","a").write(user+"\n")
        elif l.startswith("EHLO"): say("250-sink"); say("250 AUTH LOGIN")
        elif l == "AUTH LOGIN": say("334 VXNlcm5hbWU6"); state = "user"
        elif l.startswith("MAIL FROM"): mail_from = l; say("250 ok")
        elif l.startswith("RCPT TO"): rcpt = l; say("250 ok")
        elif l == "DATA":
            say("354 go"); await w.drain(); data = b""
            while not data.endswith(b"\r\n.\r\n"): data += await r.read(65536)
            open(f"{OUT}/msg{next(n)}.eml","wb").write((mail_from+"\n"+rcpt+"\n").encode()+data); say("250 queued")
        elif l == "QUIT": say("221 bye"); await w.drain(); break
        await w.drain()
    w.close()
async def main():
    s = await asyncio.start_server(handle, "127.0.0.1", 2525)
    async with s: await s.serve_forever()
asyncio.run(main())
