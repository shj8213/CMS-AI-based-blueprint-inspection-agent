const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function percentile(histogram, pixelCount, fraction) {
  const target = Math.max(1, Math.ceil(pixelCount * fraction));
  let total = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    total += histogram[value];
    if (total >= target) return value;
  }
  return 255;
}

function normalizeThickStrokes(gray, width, height) {
  const distance = new Uint8Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (gray[pixel] >= 128) {
        distance[pixel] = 0;
      } else if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        distance[pixel] = 3;
      } else {
        distance[pixel] = 255;
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (distance[pixel] === 0) continue;
      let nearest = distance[pixel];
      if (x > 0) nearest = Math.min(nearest, distance[pixel - 1] + 3);
      if (y > 0) nearest = Math.min(nearest, distance[pixel - width] + 3);
      if (x > 0 && y > 0) nearest = Math.min(nearest, distance[pixel - width - 1] + 4);
      if (x + 1 < width && y > 0) nearest = Math.min(nearest, distance[pixel - width + 1] + 4);
      distance[pixel] = nearest;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const pixel = y * width + x;
      if (distance[pixel] === 0) continue;
      let nearest = distance[pixel];
      if (x + 1 < width) nearest = Math.min(nearest, distance[pixel + 1] + 3);
      if (y + 1 < height) nearest = Math.min(nearest, distance[pixel + width] + 3);
      if (x + 1 < width && y + 1 < height) nearest = Math.min(nearest, distance[pixel + width + 1] + 4);
      if (x > 0 && y + 1 < height) nearest = Math.min(nearest, distance[pixel + width - 1] + 4);
      distance[pixel] = nearest;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (distance[pixel] === 0) continue;
      let localMaximum = distance[pixel];
      for (let dy = -2; dy <= 2; dy += 1) {
        const row = y + dy;
        if (row < 0 || row >= height) continue;
        for (let dx = -2; dx <= 2; dx += 1) {
          const column = x + dx;
          if (column < 0 || column >= width) continue;
          localMaximum = Math.max(localMaximum, distance[row * width + column]);
        }
      }
      if (localMaximum >= 9 && distance[pixel] + 3 < localMaximum) gray[pixel] = 255;
    }
  }
}

export function enhanceDrawingPixels(data, width, height, options = {}) {
  const pixelCount = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      data.length !== pixelCount * 4) {
    throw new RangeError("이미지 크기와 픽셀 데이터가 맞지 않아요.");
  }

  const gray = new Uint8ClampedArray(pixelCount);
  const histogram = new Uint32Array(256);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const luminance = Math.round(
      data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722,
    );
    gray[pixel] = luminance;
    histogram[luminance] += 1;
  }

  const low = percentile(histogram, pixelCount, 0.005);
  const high = percentile(histogram, pixelCount, 0.995);
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(pixelCount / 20000)));
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const pixel = y * width + x;
      if (x + sampleStep < width) {
        edgeSum += Math.abs(gray[pixel] - gray[pixel + sampleStep]);
        edgeCount += 1;
      }
      if (y + sampleStep < height) {
        edgeSum += Math.abs(gray[pixel] - gray[pixel + sampleStep * width]);
        edgeCount += 1;
      }
    }
  }
  const edgeRatio = edgeSum / Math.max(1, edgeCount) / 255;
  const levelsRange = high - low;
  const contrastFactor = options.contrast === undefined
    ? clamp(1.35 + (160 - levelsRange) * 0.0025, 1.25, 1.75)
    : clamp(Number(options.contrast), 50, 300) / 100;
  const sharpenAmount = options.sharpness === undefined
    ? clamp(0.82 - edgeRatio * 2.5, 0.35, 0.82)
    : clamp(Number(options.sharpness), 0, 100) / 100 * 1.25;
  const emphasisAmount = options.emphasis === undefined
    ? clamp(0.58 - edgeRatio * 0.45, 0.35, 0.58)
    : clamp(Number(options.emphasis), 0, 100) / 100;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const stretched = levelsRange > 0
      ? clamp((gray[pixel] - low) * 255 / levelsRange, 0, 255)
      : gray[pixel];
    gray[pixel] = clamp((stretched - 127.5) * contrastFactor + 127.5, 0, 255);
  }

  normalizeThickStrokes(gray, width, height);

  const integral = emphasisAmount
    ? new Float64Array((width + 1) * (height + 1))
    : null;
  if (integral) {
    const stride = width + 1;
    for (let y = 0; y < height; y += 1) {
      let rowSum = 0;
      for (let x = 0; x < width; x += 1) {
        rowSum += gray[y * width + x];
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
      }
    }
  }

  const radius = Math.max(3, Math.min(12, Math.round(Math.min(width, height) * 0.004)));
  const margin = 24 - emphasisAmount * 20;
  const output = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      let sum = 0;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const row = y + dy;
        if (row < 0 || row >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const column = x + dx;
          if (column < 0 || column >= width) continue;
          sum += gray[row * width + column];
          neighbors += 1;
        }
      }
      const blur = sum / neighbors;
      let value = clamp(gray[pixel] + (gray[pixel] - blur) * sharpenAmount, 0, 255);
      if (integral) {
        const x0 = Math.max(0, x - radius);
        const y0 = Math.max(0, y - radius);
        const x1 = Math.min(width, x + radius + 1);
        const y1 = Math.min(height, y + radius + 1);
        const stride = width + 1;
        const localSum = integral[y1 * stride + x1] - integral[y0 * stride + x1]
          - integral[y1 * stride + x0] + integral[y0 * stride + x0];
        const localMean = localSum / ((x1 - x0) * (y1 - y0));
        const threshold = Math.max(1, localMean - margin);
        const emphasized = gray[pixel] < threshold ? 0 : 255;
        value = value * (1 - emphasisAmount) + emphasized * emphasisAmount;
      }
      const offset = pixel * 4;
      output[offset] = value;
      output[offset + 1] = value;
      output[offset + 2] = value;
      output[offset + 3] = data[offset + 3];
    }
  }
  return output;
}
