'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBadgePngBuffer } = require('./badge-image');

test('creates non-empty 32px RGBA PNG badges for representative counts', () => {
  for (const count of [1, 9, 10, 99, 999]) {
    const png = createBadgePngBuffer(count);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 32);
    assert.equal(png.readUInt32BE(20), 32);
    assert.ok(png.length > 100);
  }
});
