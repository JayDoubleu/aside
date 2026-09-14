import pyte, sys, re
raw=open(sys.argv[1],'rb').read()
cols,rows=140,45
screen=pyte.Screen(cols,rows); stream=pyte.ByteStream(screen)
# dump screen whenever a marker string is fed; simpler: feed in chunks and dump at requested byte fractions
n=int(sys.argv[2]) if len(sys.argv)>2 else 6
for i in range(1,n+1):
    a=len(raw)*(i-1)//n; b=len(raw)*i//n
    stream.feed(raw[a:b])
    print(f'\n======== screen after {b} bytes ({i}/{n}) ========')
    for line in screen.display:
        if line.strip(): print(line.rstrip())
