"""Clean the approved Dreamina animation and emit a lossless RGBA master.

Usage: uv run --with numpy --with opencv-python python scripts/art/finish_hinged_video.py FFMPEG INPUT OUTPUT
"""
import subprocess
import sys
from collections import deque

import cv2
import numpy as np

ffmpeg, source, output = sys.argv[1:]
size = 720
reader = subprocess.Popen([ffmpeg, '-v', 'error', '-i', source, '-an', '-vf',
    'fps=24,scale=720:720:flags=lanczos', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
writer = subprocess.Popen([ffmpeg, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', '720x720', '-r', '24', '-i', '-', '-an', '-c:v', 'qtrle', '-pix_fmt', 'argb', output], stdin=subprocess.PIPE)
count = 0
tail = deque()
first = None
try:
    while True:
        data = reader.stdout.read(size * size * 3)
        if not data:
            break
        if len(data) != size * size * 3:
            raise RuntimeError('Incomplete decoded frame')
        rgb = np.frombuffer(data, np.uint8).reshape(size, size, 3).copy()
        rgb[:75, :75] = (7, 144, 237)
        color = rgb.astype(np.float32)
        distance = np.linalg.norm(color - np.array([7, 144, 237]), axis=2)
        alpha = np.clip((distance - 53) / 35, 0, 1)
        # Remove isolated keying specks, preserving the connected sculpture.
        n, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > .1).astype(np.uint8))
        if n > 1:
            main = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
            keep = cv2.dilate((labels == main).astype(np.uint8), np.ones((3, 3), np.uint8))
            alpha *= keep
        # Decontaminate partially covered edge pixels against the known screen.
        a = alpha[:, :, None]
        rgb = np.clip((color - (1 - a) * np.array([7, 144, 237])) / np.maximum(a, .01), 0, 255).astype(np.uint8)
        # Generated reference-brand lettering is not part of the office identity.
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        mean = cv2.blur(gray, (23, 23)).astype(np.int16)
        mask = np.zeros((size, size), np.uint8)
        bright = (gray > 145) & (mean < 115) & (gray.astype(np.int16) - mean > 60)
        dark = (gray < 120) & (mean > 95) & (mean - gray.astype(np.int16) > 40)
        mask[315:590, 240:470] = ((bright | dark)[315:590, 240:470] * 255).astype(np.uint8)
        mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
        rgb = cv2.inpaint(rgb, mask, 3, cv2.INPAINT_TELEA)
        # The reference's column recedes gently at its foot. Fade only the
        # sculpture alpha, never draw a background-colored gradient rectangle.
        fade = np.clip((625 - np.arange(size)) / 70, 0, 1)
        fade = fade * fade * (3 - 2 * fade)
        alpha *= fade[:, None]
        rgba = np.dstack((rgb, np.round(alpha * 255).astype(np.uint8)))
        rgba[alpha == 0, :3] = 0
        if first is None:
            first = rgba.copy()
        tail.append(rgba)
        if len(tail) > 8:
            writer.stdin.write(tail.popleft().tobytes())
        count += 1
    # Ease the tiny generated pose drift back to the exact first frame.
    for index, rgba in enumerate(tail):
        t = (index + 1) / len(tail)
        t = t * t * (3 - 2 * t)
        a0 = rgba[:, :, 3:4].astype(np.float32) / 255
        a1 = first[:, :, 3:4].astype(np.float32) / 255
        alpha = a0 * (1 - t) + a1 * t
        color = (rgba[:, :, :3] * a0 * (1 - t) + first[:, :, :3] * a1 * t) / np.maximum(alpha, .001)
        blended = np.concatenate((color, alpha * 255), axis=2)
        writer.stdin.write(np.clip(np.round(blended), 0, 255).astype(np.uint8).tobytes())
finally:
    reader.stdout.close()
    writer.stdin.close()
if reader.wait() != 0 or writer.wait() != 0 or count == 0:
    raise RuntimeError('Media conversion failed')
print(f'Processed {count} frames at 24 fps; transparent RGBA master: {output}')
