// Fixed-window counter per key, in memory only.
export class RateLimiter {
  constructor(limit, windowMs, clock = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.buckets = new Map();
  }

  allow(key) {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      bucket = { start: now, count: 0 };
      this.buckets.set(key, bucket);
      if (this.buckets.size > 50_000) this.sweep(now);
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  // Whether allow() would pass, without counting.
  can(key) {
    const bucket = this.buckets.get(key);
    return !bucket || this.clock() - bucket.start >= this.windowMs || bucket.count < this.limit;
  }

  sweep(now = this.clock()) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start >= this.windowMs) this.buckets.delete(key);
    }
  }
}
