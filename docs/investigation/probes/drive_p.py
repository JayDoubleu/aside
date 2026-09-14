import json, os, subprocess, sys, time, threading, select
# usage: drive_p.py <logfile> <plugin-dir> <model> <turns-json> [extra cli args...]
logf, plugin, model, turns = sys.argv[1], sys.argv[2], sys.argv[3], (json.load(open(sys.argv[4][1:])) if sys.argv[4].startswith('@') else json.loads(sys.argv[4]))
extra = sys.argv[5:]
env = dict(os.environ); env.pop('CLAUDE_CODE_SESSION_ID', None); env['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'] = '1'
cmd = ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', model, '--plugin-dir', plugin, '--debug-file', logf] + extra
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True, bufsize=1)
out = open(logf + '.stdout.jsonl', 'w')
done = threading.Event(); results = []
def reader():
    for line in p.stdout:
        out.write(line); out.flush()
        try: j = json.loads(line)
        except Exception: continue
        t = j.get('type')
        if t == 'result': results.append(j); done.set()
        elif t in ('ui_log', 'system') or 'ui_log' in line[:200]: print('EV', line[:400].rstrip())
threading.Thread(target=reader, daemon=True).start()
t0 = time.time()
for i, (delay, text) in enumerate(turns):
    time.sleep(delay)
    done.clear()
    p.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}}) + '\n'); p.stdin.flush()
    print(f'[{time.time()-t0:6.1f}s] sent turn {i+1}: {text[:60]!r}')
    if not done.wait(240): print('timeout waiting for result'); break
    r = results[-1]; print(f'[{time.time()-t0:6.1f}s] result turn {i+1}: cost={r.get("total_cost_usd")} turns={r.get("num_turns")} usage={json.dumps(r.get("usage",{}))[:300]}')
time.sleep(float(os.environ.get('TAIL_WAIT', '3')))
p.stdin.close()
try: p.wait(60)
except subprocess.TimeoutExpired: p.kill()
print('exit', p.returncode); err = p.stderr.read(); print('STDERR', err[-3000:])
