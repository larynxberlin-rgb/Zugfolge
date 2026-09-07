"""Convert actual browser screenshots into a timed GIF; no new image content."""
from pathlib import Path
import json
from hashlib import sha256
from PIL import Image

root = Path(__file__).resolve().parent
frames_dir = root / '../../outputs/conductor-offline/animation/frames'
frames = [Image.open(path).convert('RGB') for path in sorted(frames_dir.glob('*.png'))]
timing_path = frames_dir / 'timing.json'
timing = json.loads(timing_path.read_text()) if timing_path.exists() else None
times = timing['times'] if timing else None
durations = [max(20, round((times[i + 1] - times[i]) / 10) * 10) for i in range(len(times) - 1)] if times else [200] * (len(frames) - 1)
durations.append(durations[-1])
# One shared palette avoids changing colors between otherwise identical pixels.
sheet = Image.new('RGB', (frames[0].width, frames[0].height * len(frames)))
for index, frame in enumerate(frames):
    sheet.paste(frame, (0, index * frame.height))
palette = sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
converted = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
output = (root / '../../outputs/conductor-offline/M15-Atmen-Demo.gif').resolve()
converted[0].save(output, save_all=True, append_images=converted[1:], duration=durations, loop=0, optimize=True, disposal=1)
report = {'path': str(output), 'frames': len(frames), 'durationMs': sum(durations), 'bytes': output.stat().st_size,
          'htmlSha256': timing['htmlSha256'] if timing else None,
          'gifSha256': sha256(output.read_bytes()).hexdigest(),
          'timingSha256': sha256(timing_path.read_bytes()).hexdigest() if timing else None,
          'frameSha256': [sha256(path.read_bytes()).hexdigest() for path in sorted(frames_dir.glob('*.png'))]}
(root / '../../outputs/conductor-offline/assemble-idle-gif-report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
