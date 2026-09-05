const MAGIC = [0x4e, 0x43, 0x54, 0x33]; // "NCT3"
const encoder = new TextEncoder();

class Writer {
  bytes = [];

  u8(value) {
    this.bytes.push(value & 0xff);
  }

  varuint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid varuint ${value}`);
    let rest = value;
    while (rest >= 128) {
      this.u8((rest % 128) | 0x80);
      rest = Math.floor(rest / 128);
    }
    this.u8(rest);
  }

  float32(value) {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, true);
    for (const byte of new Uint8Array(buffer)) this.u8(byte);
  }

  raw(bytes) {
    for (const byte of bytes) this.u8(byte);
  }

  finish() {
    return Uint8Array.from(this.bytes);
  }
}

function collectStrings(value, strings) {
  if (typeof value === 'string') {
    strings.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      strings.add(key);
      collectStrings(item, strings);
    }
  }
}

function encodeValue(writer, value, stringIndex) {
  if (value === null) { writer.u8(0); return; }
  if (value === false) { writer.u8(1); return; }
  if (value === true) { writer.u8(2); return; }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      writer.u8(3);
      writer.varuint(value >= 0 ? value * 2 : -value * 2 - 1);
    } else {
      writer.u8(4);
      writer.float32(value);
    }
    return;
  }
  if (typeof value === 'string') {
    writer.u8(5);
    writer.varuint(stringIndex.get(value));
    return;
  }
  if (Array.isArray(value)) {
    writer.u8(6);
    writer.varuint(value.length);
    for (const item of value) encodeValue(writer, item, stringIndex);
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    writer.u8(7);
    writer.varuint(entries.length);
    for (const [key, item] of entries) {
      writer.varuint(stringIndex.get(key));
      encodeValue(writer, item, stringIndex);
    }
    return;
  }
  throw new Error(`unsupported tile value ${typeof value}`);
}

/**
 * Compact deterministic NCT3 tile encoding. Integer coordinates/flags use
 * zig-zag varints; non-integer elevations use float32; repeated keys, road
 * classes, names and semantic strings share one UTF-8 table per tile.
 */
export function encodeTileBinary(tile) {
  const stringSet = new Set();
  collectStrings(tile, stringSet);
  const strings = [...stringSet].sort();
  const stringIndex = new Map(strings.map((value, index) => [value, index]));
  const writer = new Writer();
  writer.raw(MAGIC);
  writer.u8(1);
  writer.varuint(strings.length);
  for (const value of strings) {
    const bytes = encoder.encode(value);
    writer.varuint(bytes.length);
    writer.raw(bytes);
  }
  encodeValue(writer, tile, stringIndex);
  return writer.finish();
}
