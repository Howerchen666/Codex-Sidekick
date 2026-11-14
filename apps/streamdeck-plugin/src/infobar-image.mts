import { crc32, deflateSync } from "node:zlib";
import fontData from "./infobar-font.json" with { type: "json" };
import type { infobarText } from "./art.mts";

type BitmapFont = { advance: number; height: number; glyphs: Record<string, number[]> };
const fonts: Record<"label" | "value", BitmapFont> = fontData;
const WIDTH = 232;
const HEIGHT = 50;
const STRIDE = WIDTH * 3 + 1;

function pngChunk(type: string, data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([size, content, checksum]);
}

export function infobarImage(view: ReturnType<typeof infobarText>): Buffer {
  // Draw directly into the Neo's native pixel grid. PNG scanlines use filter 0.
  const pixels = Buffer.alloc(STRIDE * HEIGHT);
  const paper = Buffer.from("FAF9F5", "hex");
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) pixels.set(paper, y * STRIDE + 1 + x * 3);
  }

  function drawText(text: string, font: BitmapFont, x: number, y: number, width: number, height: number, color: string) {
    const ink = Buffer.from(color.slice(1), "hex");
    const characters = [...text];
    const left = x + Math.floor((width - characters.length * font.advance) / 2);
    const top = y + Math.floor((height - font.height) / 2);
    for (const [index, character] of characters.entries()) {
      const rows = font.glyphs[character] ?? font.glyphs["?"];
      for (let row = 0; row < rows.length; row++) {
        const pixelY = top + row;
        if (pixelY < y || pixelY >= y + height) continue;
        for (let column = 0; column < font.advance; column++) {
          const pixelX = left + index * font.advance + column;
          if (pixelX < x || pixelX >= x + width || !(rows[row] & (1 << column))) continue;
          pixels.set(ink, pixelY * STRIDE + 1 + pixelX * 3);
        }
      }
    }
  }

  const columns = [
    { x: 0, width: 76, label: view.fiveHourLabel, value: view.fiveHour, color: view.fiveHourColor },
    { x: 76, width: 76, label: view.weeklyLabel, value: view.weekly, color: view.weeklyColor },
    { x: 152, width: 80, label: view.tokenLabel, value: view.tokens, color: "#171816" },
  ];
  for (const column of columns) {
    drawText(column.label, fonts.label, column.x, 0, column.width, 18, "#171816");
    drawText(column.value, fonts.value, column.x, 18, column.width, 32, column.color);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // Eight bits per channel.
  header[9] = 2; // Opaque RGB.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
