// Minimal QR Code encoder (byte mode, error correction level M, versions 1-15).
// Independent implementation of ISO/IEC 18004 sufficient for rendering the
// Bilibili login QR code locally. No external service or dependency involved.

const CODEWORDS = [0,
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706];

// Level M only (table column M of the QR spec).
const EC_BLOCKS_M = [0,
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
  31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

const EC_CODEWORDS_M = [0,
  10, 16, 26, 36, 48, 64, 72, 88, 110, 130,
  150, 176, 198, 216, 240, 280, 308, 338, 364, 416,
  442, 476, 504, 560, 588, 644, 700, 728, 784, 812,
  868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372];

const ECC_FORMAT_BITS = 0; // level M

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function generatorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data, ecLen) {
  const gen = generatorPoly(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  const out = new Uint8Array(ecLen);
  out.set(res.subarray(data.length), 0);
  return out;
}

function bitAt(value, index) {
  return (value >>> index) & 1;
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < numAlign; pos -= step) out.splice(1, 0, pos);
  return out;
}

function buildMatrix(version, textBytes) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  const set = (x, y, dark) => {
    modules[y * size + x] = dark ? 1 : 0;
    isFunction[y * size + x] = 1;
  };

  // finder patterns + separators
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const corner = (i === 0 || i === 6 || j === 0 || j === 6);
      const inner = (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      const dark = corner || inner;
      if (i < 7 && j < 7) set(j, i, dark);
      if (i < 8 && j < 8) isFunction[i * size + j] = 1;
    }
  }
  // top-right and bottom-left finders (copy the pattern)
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const dark = (i === 0 || i === 6 || j === 0 || j === 6) || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      if (i < 7 && j < 7) set(size - 1 - j, i, dark);
      if (i < 7 && j < 7) set(j, size - 1 - i, dark);
      isFunction[i * size + (size - 1 - j)] = 1;
      isFunction[(size - 1 - i) * size + j] = 1;
    }
  }

  // timing patterns
  for (let i = 0; i < size; i++) {
    if (!isFunction[6 * size + i]) set(i, 6, i % 2 === 0);
    if (!isFunction[i * size + 6]) set(6, i, i % 2 === 0);
  }

  // alignment patterns
  const positions = alignmentPositions(version);
  for (const cx of positions) {
    for (const cy of positions) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          set(cx + dx, cy + dy, dark);
        }
      }
    }
  }

  // reserve format areas
  for (let i = 0; i < 9; i++) {
    isFunction[8 * size + i] = 1;
    isFunction[i * size + 8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    isFunction[8 * size + (size - 1 - i)] = 1;
    isFunction[(size - 1 - i) * size + 8] = 1;
  }

  // version info (v >= 7)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = bitAt(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  const dataCodewords = CODEWORDS[version] - EC_CODEWORDS_M[version];
  const bits = [];
  const pushBits = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  pushBits(4, 4); // byte mode
  pushBits(textBytes.length, version < 10 ? 8 : 16);
  for (const byte of textBytes) pushBits(byte, 8);
  const capacityBits = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const dataBytes = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    dataBytes[i / 8] = value;
  }
  for (let i = bits.length / 8, pad = 0; i < dataCodewords; i++, pad++) {
    dataBytes[i] = pad % 2 === 0 ? 0xec : 0x11;
  }

  // split into blocks and compute error correction
  const totalCodewords = CODEWORDS[version];
  const ecTotal = EC_CODEWORDS_M[version];
  const blockCount = EC_BLOCKS_M[version];
  const numShortBlocks = blockCount - (totalCodewords % blockCount);
  const shortDataLen = Math.floor(totalCodewords / blockCount) - ecTotal / blockCount;
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const len = shortDataLen + (i < numShortBlocks ? 0 : 1);
    const dataPart = dataBytes.subarray(offset, offset + len);
    offset += len;
    blocks.push({ data: dataPart, ec: reedSolomon(dataPart, ecTotal / blockCount) });
  }
  const interleaved = new Uint8Array(totalCodewords);
  let k = 0;
  for (let i = 0; i < shortDataLen + 1; i++) {
    for (const block of blocks) {
      if (i < block.data.length) interleaved[k++] = block.data[i];
    }
  }
  for (let i = 0; i < ecTotal / blockCount; i++) {
    for (const block of blocks) interleaved[k++] = block.ec[i];
  }

  // place data bits zigzag
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        const idx = y * size + x;
        if (isFunction[idx]) continue;
        if (bitIndex < interleaved.length * 8) {
          modules[idx] = (interleaved[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        } else {
          modules[idx] = 0;
        }
      }
    }
  }

  return { size, modules, isFunction, version };
}

function applyMask(matrix, mask) {
  const { size, modules, isFunction } = matrix;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (isFunction[idx]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: break;
      }
      if (invert) modules[idx] ^= 1;
    }
  }
}

function drawFormatInfo(matrix, mask) {
  const { size, modules } = matrix;
  const set = (x, y, dark) => { modules[y * size + x] = dark ? 1 : 0; };
  let data = (ECC_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i < 6; i++) set(8, i, bitAt(bits, i));
  set(8, 7, bitAt(bits, 6));
  set(8, 8, bitAt(bits, 7));
  set(7, 8, bitAt(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bitAt(bits, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bitAt(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bitAt(bits, i));
  set(8, size - 8, true);
}

function penalty(matrix) {
  const { size, modules } = matrix;
  let score = 0;
  // rule 1: runs
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x <= size; x++) {
      if (x < size && modules[y * size + x] === modules[y * size + x - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y <= size; y++) {
      if (y < size && modules[y * size + x] === modules[(y - 1) * size + x]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
  }
  // rule 2: 2x2 blocks
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = modules[y * size + x];
      if (a === modules[y * size + x + 1] && a === modules[(y + 1) * size + x] && a === modules[(y + 1) * size + x + 1]) score += 3;
    }
  }
  // rule 3: finder-like patterns
  const patterns = [0x5d, 0x5d0];
  const checkPatterns = (get, length) => {
    for (let i = 0; i + 11 <= length; i++) {
      let value = 0;
      for (let j = 0; j < 11; j++) value = (value << 1) | (get(i + j) ? 1 : 0);
      if (patterns.includes(value)) score += 40;
    }
  };
  for (let y = 0; y < size; y++) checkPatterns(x => modules[y * size + x], size);
  for (let x = 0; x < size; x++) checkPatterns(y => modules[y * size + x], size);
  // rule 4: dark ratio
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const total = size * size;
  const k = Math.abs(Math.ceil((dark * 100 / total) / 5) - 10);
  score += k * 10;
  return score;
}

function chooseVersion(textBytes) {
  for (let version = 1; version <= 15; version++) {
    const dataCodewords = CODEWORDS[version] - EC_CODEWORDS_M[version];
    const lengthBits = version < 10 ? 8 : 16;
    if (textBytes.length * 8 + 4 + lengthBits <= dataCodewords * 8) return version;
  }
  throw new Error('二维码内容过长');
}

export function encodeQr(text, { ecc = 'M', forceMask = null } = {}) {
  if (ecc !== 'M') throw new Error('仅支持纠错等级 M');
  const textBytes = new TextEncoder().encode(String(text));
  const version = chooseVersion(textBytes);
  const masks = forceMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
  let best = null;
  let bestScore = Infinity;
  for (const mask of masks) {
    const matrix = buildMatrix(version, textBytes);
    applyMask(matrix, mask);
    drawFormatInfo(matrix, mask);
    const score = penalty(matrix);
    if (score < bestScore) {
      bestScore = score;
      best = matrix;
    }
  }
  return { size: best.size, version, modules: best.modules };
}

export function toSvg({ size, modules }, { margin = 2, width = 220 } = {}) {
  const dim = size + margin * 2;
  const cell = width / dim;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y * size + x]) {
        path += `M${(x + margin) * cell} ${(y + margin) * cell}h${cell}v${cell}h-${cell}z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${width} ${width}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/** 结构化矩阵：供界面用逐格 SVG 渲染，避免把原始 SVG/HTML 交给浏览器解释。 */
export function toMatrixRows({ size, modules }) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = new Array(size);
    for (let x = 0; x < size; x++) row[x] = modules[y * size + x] ? 1 : 0;
    rows.push(row);
  }
  return { size, rows };
}

export function qrDataUri(text, { width = 220, margin = 2 } = {}) {
  const svg = toSvg(encodeQr(text), { width, margin });
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}
