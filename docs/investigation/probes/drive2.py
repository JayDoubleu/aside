import os, pty, sys, time, select, json, fcntl, termios, struct, re
# usage: drive2.py <rawout> <total_s> <script-json [[t,keys],...]> -- cmd...
raw, total, script = sys.argv[1], float(sys.argv[2]), (json.load(open(sys.argv[3][1:])) if sys.argv[3].startswith('@') else json.loads(sys.argv[3]))
cmd = sys.argv[sys.argv.index('--')+1:]
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM']='xterm-256color'
    os.environ.pop('CLAUDE_CODE_SESSION_ID', None)
    for k in ('CLAUDE_AUTO_BACKGROUND_TASKS','CLAUDE_CODE_BG_TASKS_REPORT_RUNNING'): os.environ.pop(k, None)
    os.environ['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS']='1'
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 140, 0, 0))
out=open(raw,'wb'); t0=time.time(); step=0
while time.time()-t0 < total:
    r,_,_=select.select([fd],[],[],0.1)
    if r:
        try: d=os.read(fd,65536)
        except OSError: break
        if not d: break
        out.write(d); out.flush()
    if step < len(script) and time.time()-t0 > script[step][0]:
        keys=script[step][1]; os.write(fd, keys.encode()); step+=1
        print(f'[{time.time()-t0:5.1f}s] sent {keys!r}', flush=True)
try: os.kill(pid, 9)
except Exception: pass
print('done; raw bytes', os.path.getsize(raw))
