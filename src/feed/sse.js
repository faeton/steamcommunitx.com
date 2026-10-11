const encoder = new TextEncoder();

function frame(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Frames buffered for one client before it counts as too slow and is dropped,
// so a stalled connection cannot grow memory without bound.
const MAX_QUEUED_FRAMES = 64;

// Server-Sent Events fan-out. Each client is a ReadableStream controller; a
// client that disconnects cancels its stream and is dropped.
export class SseHub {
  constructor({ maxClients = 2000, maxPerKey = 4, heartbeatMs = 25_000 } = {}) {
    this.maxClients = maxClients;
    this.maxPerKey = maxPerKey;
    this.heartbeatMs = heartbeatMs;
    this.clients = new Set();
    this.keyOf = new Map();   // controller -> client key (IP)
    this.perKey = new Map();  // key -> open streams
    this.timer = null;
  }

  remove(c) {
    if (!this.clients.delete(c)) return;
    const key = this.keyOf.get(c);
    this.keyOf.delete(c);
    const n = (this.perKey.get(key) || 1) - 1;
    if (n > 0) this.perKey.set(key, n);
    else this.perKey.delete(key);
  }

  get size() {
    return this.clients.size;
  }

  // `key` identifies the client (its IP) so one peer cannot take every slot.
  connect(snapshot, key = '') {
    if (this.clients.size >= this.maxClients) return null;
    if ((this.perKey.get(key) || 0) >= this.maxPerKey) return null;
    const hub = this;
    let controller;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
        hub.clients.add(c);
        hub.keyOf.set(c, key);
        hub.perKey.set(key, (hub.perKey.get(key) || 0) + 1);
        c.enqueue(encoder.encode(`retry: 5000\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
      },
      cancel() {
        hub.remove(controller);
      }
    }, { highWaterMark: MAX_QUEUED_FRAMES });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  send(chunk) {
    for (const c of this.clients) {
      try {
        if (c.desiredSize !== null && c.desiredSize <= 0) {
          c.close(); // lagging client: it will reconnect and get a fresh snapshot
          this.remove(c);
          continue;
        }
        c.enqueue(chunk);
      } catch {
        this.remove(c);
      }
    }
  }

  broadcast(event, data) {
    this.send(frame(event, data));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.send(encoder.encode(': hb\n\n')), this.heartbeatMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const c of [...this.clients]) {
      try { c.close(); } catch { /* already closed */ }
      this.remove(c);
    }
  }
}
