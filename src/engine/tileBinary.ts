import type { TileJson } from './tileTypes';

const decoder = new TextDecoder();

class Reader {
  private offset = 0;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get remaining() {
    return this.bytes.length - this.offset;
  }

  u8(): number {
    if (this.offset >= this.bytes.length) throw new Error('truncated NCT3 tile');
    return this.bytes[this.offset++];
  }

  raw(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new Error('invalid NCT3 byte span');
    }
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  varuint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) throw new Error('unsafe NCT3 varuint');
        return value;
      }
      scale *= 128;
    }
    throw new Error('oversized NCT3 varuint');
  }

  float32(): number {
    if (this.remaining < 4) throw new Error('truncated NCT3 float32');
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }
}

function decodeValue(reader: Reader, strings: string[], depth: number): unknown {
  if (depth > 64) throw new Error('NCT3 nesting limit exceeded');
  switch (reader.u8()) {
    case 0: return null;
    case 1: return false;
    case 2: return true;
    case 3: {
      const zigzag = reader.varuint();
      return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
    }
    case 4: return reader.float32();
    case 5: {
      const index = reader.varuint();
      if (index >= strings.length) throw new Error('invalid NCT3 string reference');
      return strings[index];
    }
    case 6: {
      const length = reader.varuint();
      if (length > 5_000_000) throw new Error('oversized NCT3 array');
      const value = new Array<unknown>(length);
      for (let i = 0; i < length; i++) value[i] = decodeValue(reader, strings, depth + 1);
      return value;
    }
    case 7: {
      const length = reader.varuint();
      if (length > 100_000) throw new Error('oversized NCT3 object');
      const value = Object.create(null) as Record<string, unknown>;
      for (let i = 0; i < length; i++) {
        const keyIndex = reader.varuint();
        if (keyIndex >= strings.length) throw new Error('invalid NCT3 key reference');
        value[strings[keyIndex]] = decodeValue(reader, strings, depth + 1);
      }
      return value;
    }
    default:
      throw new Error('unknown NCT3 value tag');
  }
}

export function isTileBinary(source: ArrayBuffer): boolean {
  if (source.byteLength < 5) return false;
  const bytes = new Uint8Array(source, 0, 4);
  return bytes[0] === 0x4e && bytes[1] === 0x43 && bytes[2] === 0x54 && bytes[3] === 0x33;
}

export function decodeTileBinary(source: ArrayBuffer): TileJson {
  const reader = new Reader(source);
  const magic = reader.raw(4);
  if (magic[0] !== 0x4e || magic[1] !== 0x43 || magic[2] !== 0x54 || magic[3] !== 0x33) {
    throw new Error('invalid NCT3 tile magic');
  }
  if (reader.u8() !== 1) throw new Error('unsupported NCT3 tile version');
  const stringCount = reader.varuint();
  if (stringCount > 100_000) throw new Error('oversized NCT3 string table');
  const strings = new Array<string>(stringCount);
  for (let i = 0; i < stringCount; i++) {
    const length = reader.varuint();
    strings[i] = decoder.decode(reader.raw(length));
  }
  const value = decodeValue(reader, strings, 0) as TileJson;
  if (!value || typeof value !== 'object' || !Number.isFinite(value.x) || !Number.isFinite(value.z)) {
    throw new Error('invalid NCT3 tile root');
  }
  if (reader.remaining !== 0) throw new Error('trailing NCT3 tile bytes');
  return value;
}
