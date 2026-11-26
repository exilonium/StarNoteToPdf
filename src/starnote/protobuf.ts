export type PbValue =
  | { type: 'varint'; value: bigint }
  | { type: 'fixed64'; bytes: Uint8Array }
  | { type: 'bytes'; bytes: Uint8Array }
  | { type: 'fixed32'; bytes: Uint8Array };

export type PbFieldMap = Map<number, PbValue[]>;

const textDecoder = new TextDecoder('utf-8');

function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = BigInt(buf[i++]);
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) {
      return [result, i];
    }
    shift += 7n;
  }
  throw new Error('Unexpected EOF while reading protobuf varint');
}

export function parseProtobuf(buf: Uint8Array): PbFieldMap {
  const fields: PbFieldMap = new Map();
  let i = 0;
  while (i < buf.length) {
    const [tag, nextI] = readVarint(buf, i);
    i = nextI;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNum === 0) break;

    let entry: PbValue;
    if (wireType === 0) {
      const [value, after] = readVarint(buf, i);
      i = after;
      entry = { type: 'varint', value };
    } else if (wireType === 1) {
      entry = { type: 'fixed64', bytes: buf.subarray(i, i + 8) };
      i += 8;
    } else if (wireType === 2) {
      const [lenBig, afterLen] = readVarint(buf, i);
      const len = Number(lenBig);
      i = afterLen;
      entry = { type: 'bytes', bytes: buf.subarray(i, i + len) };
      i += len;
    } else if (wireType === 5) {
      entry = { type: 'fixed32', bytes: buf.subarray(i, i + 4) };
      i += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType} at offset ${i}`);
    }

    const list = fields.get(fieldNum);
    if (list) list.push(entry);
    else fields.set(fieldNum, [entry]);
  }
  return fields;
}

export function getString(fields: PbFieldMap, num: number): string | undefined {
  const list = fields.get(num);
  if (!list || list.length === 0) return undefined;
  const last = list[list.length - 1];
  if (last.type !== 'bytes') return undefined;
  return textDecoder.decode(last.bytes);
}

export function getBytes(fields: PbFieldMap, num: number): Uint8Array | undefined {
  const list = fields.get(num);
  if (!list || list.length === 0) return undefined;
  const last = list[list.length - 1];
  if (last.type !== 'bytes') return undefined;
  return last.bytes;
}

export function getVarintNumber(fields: PbFieldMap, num: number): number | undefined {
  const list = fields.get(num);
  if (!list || list.length === 0) return undefined;
  const last = list[list.length - 1];
  if (last.type !== 'varint') return undefined;
  return Number(last.value);
}

export function getArgbFromVarint(fields: PbFieldMap, num: number): number | undefined {
  const list = fields.get(num);
  if (!list || list.length === 0) return undefined;
  const last = list[list.length - 1];
  if (last.type !== 'varint') return undefined;
  return Number(BigInt.asUintN(32, last.value));
}

export function getFloat32(fields: PbFieldMap, num: number): number | undefined {
  const list = fields.get(num);
  if (!list || list.length === 0) return undefined;
  const last = list[list.length - 1];
  if (last.type !== 'fixed32' || last.bytes.length < 4) return undefined;
  const dv = new DataView(last.bytes.buffer, last.bytes.byteOffset, 4);
  return dv.getFloat32(0, true);
}

export function getRepeatedMessages(fields: PbFieldMap, num: number): PbFieldMap[] {
  const list = fields.get(num);
  if (!list) return [];
  const out: PbFieldMap[] = [];
  for (const item of list) {
    if (item.type === 'bytes') {
      out.push(parseProtobuf(item.bytes));
    }
  }
  return out;
}
