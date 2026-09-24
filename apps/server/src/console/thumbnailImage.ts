import { PNG } from 'pngjs';
import type { RfbFrame } from './rfbSnapshot.js';

/**
 * Box-filter downscale of an RGBA frame to at most `targetWidth` px wide,
 * preserving aspect ratio. Never upscales -- a frame already narrower than
 * `targetWidth` is returned unchanged, since thumbnails only ever need to
 * shrink a real VM display.
 */
export function downscaleFrame(frame: RfbFrame, targetWidth: number): RfbFrame {
  const { width, height, data } = frame;
  if (targetWidth >= width) return frame;

  const outWidth = Math.max(1, Math.round(targetWidth));
  const outHeight = Math.max(1, Math.round((height * outWidth) / width));
  const out = Buffer.alloc(outWidth * outHeight * 4);

  for (let oy = 0; oy < outHeight; oy++) {
    const srcY0 = Math.floor((oy * height) / outHeight);
    const srcY1 = Math.max(srcY0 + 1, Math.floor(((oy + 1) * height) / outHeight));
    for (let ox = 0; ox < outWidth; ox++) {
      const srcX0 = Math.floor((ox * width) / outWidth);
      const srcX1 = Math.max(srcX0 + 1, Math.floor(((ox + 1) * width) / outWidth));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = srcY0; sy < srcY1 && sy < height; sy++) {
        for (let sx = srcX0; sx < srcX1 && sx < width; sx++) {
          const off = (sy * width + sx) * 4;
          r += data[off]!;
          g += data[off + 1]!;
          b += data[off + 2]!;
          a += data[off + 3]!;
          count++;
        }
      }

      const destOff = (oy * outWidth + ox) * 4;
      out[destOff] = Math.round(r / count);
      out[destOff + 1] = Math.round(g / count);
      out[destOff + 2] = Math.round(b / count);
      out[destOff + 3] = Math.round(a / count);
    }
  }

  return { width: outWidth, height: outHeight, data: out };
}

/** Encodes an RGBA frame as a PNG buffer. */
export function encodePng(frame: RfbFrame): Buffer {
  const png = new PNG({ width: frame.width, height: frame.height });
  frame.data.copy(png.data);
  return PNG.sync.write(png);
}

/** Decodes a PNG buffer back into an RGBA frame (the cached master, re-derived per width). */
export function decodePng(png: Buffer): RfbFrame {
  const decoded = PNG.sync.read(png);
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}
