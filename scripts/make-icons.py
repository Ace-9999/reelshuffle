from pathlib import Path
import struct
import zlib

root = Path(__file__).resolve().parent.parent / 'ReelShuffle' / 'icons'
root.mkdir(exist_ok=True)
segments = [(.22,.32,.33,.32),(.33,.32,.67,.68),(.67,.68,.8,.68),(.22,.68,.33,.68),(.33,.68,.46,.54),(.55,.43,.67,.32),(.67,.32,.8,.32),(.7,.22,.8,.32),(.8,.32,.7,.42),(.7,.58,.8,.68),(.8,.68,.7,.78)]
for size in [16, 32, 48, 128]:
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            xx, yy, r = (x + .5) / size, (y + .5) / size, .23
            inside = (r <= xx <= 1-r) or (r <= yy <= 1-r) or (min(abs(xx-r),abs(xx-(1-r)))**2 + min(abs(yy-r),abs(yy-(1-r)))**2 <= r*r)
            color = (190,201,255,255) if inside else (0,0,0,0)
            for ax,ay,bx,by in segments:
                dx,dy = bx-ax,by-ay
                t = max(0,min(1,((xx-ax)*dx+(yy-ay)*dy)/(dx*dx+dy*dy)))
                if (xx-ax-t*dx)**2 + (yy-ay-t*dy)**2 < .027**2:
                    color = (37,43,68,255)
            row.extend(color)
        rows.append(b'\0' + row)
    def chunk(kind, data):
        return struct.pack('>I',len(data)) + kind + data + struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    (root / f'icon{size}.png').write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0)) + chunk(b'IDAT',zlib.compress(b''.join(rows))) + chunk(b'IEND',b''))
print('Created icons: 16, 32, 48, 128')
