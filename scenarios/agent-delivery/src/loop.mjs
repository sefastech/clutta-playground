export class ProcessingLoop {
  constructor(tick, { intervalMs = 100, onError = () => {} } = {}) {
    this.tick = tick;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.paused = true;
    this.closed = false;
    this.timer = null;
    this.inFlight = null;
  }

  resume() {
    if (this.closed) throw new Error('Processing loop is closed');
    this.paused = false;
    this.schedule(0);
  }

  async pause() {
    this.paused = true;
    clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  async stop() {
    this.closed = true;
    await this.pause();
  }

  schedule(delay) {
    if (this.paused || this.closed || this.timer || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.runTick();
    }, delay);
  }

  async runTick() {
    let progressed = false;
    try { progressed = Boolean(await Promise.resolve().then(() => this.tick())); }
    catch (error) { this.onError(error); }
    finally {
      this.inFlight = null;
      this.schedule(progressed ? 0 : this.intervalMs);
    }
  }
}
