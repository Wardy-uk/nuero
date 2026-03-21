/**
 * Generate PNG icons for NEURO PWA.
 * Uses raw PNG binary — no external dependencies.
 * Produces icon-192.png and icon-512.png in frontend/public/
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [10, 10, 10];       // #0a0a0a
const FG = [0, 255, 136];      // #00ff88

function createPNG(size) {
  const width = size;
  const height = size;

  // Create raw pixel data (RGBA)
  const rawData = Buffer.alloc(height * (1 + width * 4)); // 1 filter byte per row

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // filter: None

    for (let x = 0; x < width; x++) {
      const pixOffset = rowOffset + 1 + x * 4;
      // Default: background
      rawData[pixOffset] = BG[0];
      rawData[pixOffset + 1] = BG[1];
      rawData[pixOffset + 2] = BG[2];
      rawData[pixOffset + 3] = 255;
    }
  }

  // Draw "N" letter
  const margin = Math.floor(size * 0.2);
  const strokeW = Math.max(Math.floor(size * 0.12), 2);
  const left = margin;
  const right = size - margin - strokeW;
  const top = margin;
  const bottom = size - margin;
  const letterHeight = bottom - top;

  function setPixel(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const rowOffset = y * (1 + width * 4);
    const pixOffset = rowOffset + 1 + x * 4;
    rawData[pixOffset] = FG[0];
    rawData[pixOffset + 1] = FG[1];
    rawData[pixOffset + 2] = FG[2];
    rawData[pixOffset + 3] = 255;
  }

  function fillRect(x1, y1, x2, y2) {
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        setPixel(x, y);
      }
    }
  }

  // Left vertical stroke
  fillRect(left, top, left + strokeW, bottom);

  // Right vertical stroke
  fillRect(right, top, right + strokeW, bottom);

  // Diagonal stroke
  for (let i = 0; i < letterHeight; i++) {
    const progress = i / letterHeight;
    const x = left + strokeW + progress * (right - left - strokeW);
    const y = top + i;
    fillRect(Math.floor(x), y, Math.floor(x) + strokeW, y + 1);
  }

  // Compress with zlib deflate
  const compressed = zlib.deflateSync(rawData);

  // Build PNG file
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    const crcInput = Buffer.concat([typeBuffer, data]);
    const crc = crc32(crcInput);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc, 0);

    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
  }

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', compressed);
  const iendChunk = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// CRC32 implementation
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Generate both sizes
const outDir = path.join(__dirname, 'frontend', 'public');

const icon192 = createPNG(192);
fs.writeFileSync(path.join(outDir, 'icon-192.png'), icon192);
console.log('Created icon-192.png (%d bytes)', icon192.length);

const icon512 = createPNG(512);
fs.writeFileSync(path.join(outDir, 'icon-512.png'), icon512);
console.log('Created icon-512.png (%d bytes)', icon512.length);
