/** Raster counterpart of SVG `feMorphology` for effect alpha masks. It uses a
 * separable max/min filter, so a spread pass is O(width × height) rather than
 * O(width × height × radius²). Outside the source surface is transparent. */
export function morphAlphaChannel(input: Uint8ClampedArray, width: number, height: number, spread: number): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || input.length !== width * height || !Number.isFinite(spread) || spread === 0) return input.slice();
  const radius = Math.ceil(Math.abs(spread));
  if (radius === 0) return input.slice();
  const dilate = spread > 0;
  return morphologyPass(morphologyPass(input, width, height, radius, dilate, true), width, height, radius, dilate, false);
}

function morphologyPass(input: Uint8ClampedArray, width: number, height: number, requestedRadius: number, dilate: boolean, horizontal: boolean) {
  const output = new Uint8ClampedArray(input.length);
  const lineLength = horizontal ? width : height;
  const lineCount = horizontal ? height : width;
  // An erosion window that cannot fit fully inside a line is entirely
  // transparent. A dilation may clamp its virtual transparent padding.
  if (!dilate && requestedRadius * 2 + 1 > lineLength) return output;
  const radius = dilate ? Math.min(requestedRadius, lineLength) : requestedRadius;
  const indices = new Int32Array(lineLength + radius * 2 + 1);
  const values = new Uint8Array(indices.length);
  for (let line = 0; line < lineCount; line += 1) {
    let head = 0;
    let tail = 0;
    for (let position = -radius; position < lineLength + radius; position += 1) {
      const value = position >= 0 && position < lineLength
        ? input[horizontal ? line * width + position : position * width + line]
        : 0;
      while (tail > head && (dilate ? value >= values[tail - 1] : value <= values[tail - 1])) tail -= 1;
      indices[tail] = position;
      values[tail] = value;
      tail += 1;
      const first = position - radius * 2;
      while (head < tail && indices[head] < first) head += 1;
      if (position >= radius) {
        const destination = position - radius;
        output[horizontal ? line * width + destination : destination * width + line] = values[head];
      }
    }
  }
  return output;
}
