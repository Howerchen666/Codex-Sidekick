import test from "node:test";
import assert from "node:assert/strict";
import { crc32, inflateSync } from "node:zlib";
import { infobarImage } from "../apps/streamdeck-plugin/src/infobar-image.mts";

test("Infobar PNG uses the native pixel size and contains no blended text-edge colors", () => {
  const png = infobarImage({
    fiveHourLabel: "5h left", fiveHour: "5%", fiveHourColor: "#A12D20",
    weeklyLabel: "Week left", weekly: "20%", weeklyColor: "#815100",
    tokenLabel: "Tokens", tokens: "999.9K",
  });
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8;
  const images = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length));
    if (type === "IHDR") {
      assert.equal(data.readUInt32BE(0), 232);
      assert.equal(data.readUInt32BE(4), 50);
      assert.equal(data[8], 8);
      assert.equal(data[9], 2);
    }
    if (type === "IDAT") images.push(data);
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(images));
  const stride = 232 * 3 + 1;
  assert.equal(pixels.length, stride * 50);
  const colors = new Set();
  for (let y = 0; y < 50; y++) {
    assert.equal(pixels[y * stride], 0);
    for (let x = 0; x < 232; x++) {
      const start = y * stride + 1 + x * 3;
      colors.add(pixels.subarray(start, start + 3).toString("hex"));
    }
  }
  assert.deepEqual([...colors].sort(), ["171816", "815100", "a12d20", "faf9f5"]);
});
