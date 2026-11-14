// pkt-line framing, the length-prefixed packet format every git smart-HTTP
// message uses. A packet is four lowercase hex digits (the total length,
// header included) followed by that many minus four payload bytes. Three
// lengths are control packets instead of data: 0 is the flush that ends a
// list, 1 is the delimiter that separates a v2 command's header from its
// arguments, and 2 is the response-end marker of protocol v2.

/** The largest legal pkt-line, header included (0xfff0 plus headroom git allows). */
export const PKT_MAX = 65520;

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Frame one payload as a data pkt-line. The payload must fit in one packet. */
export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > PKT_MAX) throw new Error(`pkt-line payload too large: ${total} bytes`);
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Frame a list of text lines, each becoming one data packet. */
export function pktLines(lines: readonly string[]): Buffer {
  return Buffer.concat(lines.map((line) => pkt(line)));
}

/**
 * Split a buffer into its packets. Throws on a truncated header, a length
 * under four, or trailing bytes that cannot form a packet: callers turn that
 * into a protocol error answer rather than guessing at the sender's intent.
 */
export function unpkt(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const total = parseInt(head, 16);
    if (total === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (total === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (total === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (total < 4) throw new Error(`pkt-line length ${total} is under the header size`);
    if (offset + total > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + total)) });
    offset += total;
  }
  return packets;
}

/**
 * Parse a pkt-line stream that is followed by raw bytes (a receive-pack body:
 * the command list is pkt-framed, the pack after the flush is not). Answers
 * the packets up to and including the first flush, plus the remaining bytes.
 */
export function unpktPrefix(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const total = parseInt(head, 16);
    if (total === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, rest: Buffer.from(buffer.subarray(offset)) };
    }
    if (total === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (total === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (total < 4) throw new Error(`pkt-line length ${total} is under the header size`);
    if (offset + total > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + total)) });
    offset += total;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/**
 * Wrap pack bytes in sideband frames: each frame is a pkt-line whose payload
 * is one band byte followed by pack data. Band 1 is the pack stream itself.
 */
export function sidebandWrap(pack: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = PKT_MAX - 4 - 1; // header plus the band byte
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (pack.length === 0) {
    // An empty pack still needs one frame, or the section reads as absent.
    parts.push(pkt(Buffer.from([band])));
  }
  return Buffer.concat(parts);
}
