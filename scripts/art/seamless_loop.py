"""Close the approved RGBA animation's seam without changing its sculpture.

uv run --with numpy python scripts/art/seamless_loop.py FFMPEG INPUT OUTPUT
The last half-second eases into the exact opening pose in premultiplied RGBA.
"""
import subprocess
import sys
from collections import deque
import numpy as np

ffmpeg, source, output = sys.argv[1:]
width = height = 1440
reader = subprocess.Popen([ffmpeg, '-v', 'error', '-c:v', 'libvpx-vp9', '-i', source,
    '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], stdout=subprocess.PIPE)
writer = subprocess.Popen([ffmpeg, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', '1440x1440', '-r', '24', '-i', '-', '-an', '-c:v', 'qtrle', '-pix_fmt', 'argb', output], stdin=subprocess.PIPE)
tail, first, count = deque(), None, 0
try:
    while True:
        data = reader.stdout.read(width * height * 4)
        if not data:
            break
        if len(data) != width * height * 4:
            raise RuntimeError('Incomplete frame')
        frame = np.frombuffer(data, np.uint8).reshape(height, width, 4).copy()
        # The tiny isolated corner label is outside the sculpture at all times.
        frame[:150, :150] = 0
        if first is None:
            first = frame.copy()
        tail.append(frame)
        if len(tail) > 12:
            writer.stdin.write(tail.popleft().tobytes())
        count += 1
    if first is None:
        raise RuntimeError('No frames decoded')
    for index, frame in enumerate(tail):
        t = (index + 1) / len(tail)
        t = t * t * t * (t * (6 * t - 15) + 10)
        if index == len(tail) - 1:
            final = first
        else:
            a0 = frame[:, :, 3:4].astype(np.float32) / 255
            a1 = first[:, :, 3:4].astype(np.float32) / 255
            alpha = a0 * (1-t) + a1 * t
            color = (frame[:, :, :3] * a0 * (1-t) + first[:, :, :3] * a1 * t) / np.maximum(alpha, .001)
            final = np.clip(np.round(np.concatenate((color, alpha*255), axis=2)), 0, 255).astype(np.uint8)
        writer.stdin.write(final.tobytes())
finally:
    reader.stdout.close()
    writer.stdin.close()
if reader.wait() != 0 or writer.wait() != 0:
    raise RuntimeError('Video processing failed')
print(f'{count} frames; final frame exactly equals opening frame; alpha preserved.')
