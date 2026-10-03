class PCMPlayer extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = []; this.offset = 0; this.frames = 0;
    this.port.onmessage = ({data}) => {
      const pcm = new Float32Array(data);
      this.queue.push(pcm); this.frames += pcm.length / 2;
      while (this.frames > 9600 && this.queue.length > 1) { const old = this.queue.shift(); this.frames -= (old.length - this.offset) / 2; this.offset = 0; }
    };
  }
  process(_inputs, outputs) {
    const channels = outputs[0];
    for (let frame = 0; frame < channels[0].length; frame++) {
      const packet = this.queue[0];
      if (!packet) break;
      channels[0][frame] = packet[this.offset++]; channels[1][frame] = packet[this.offset++]; this.frames--;
      if (this.offset >= packet.length) { this.queue.shift(); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('filtered-pcm', PCMPlayer);
