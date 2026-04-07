export class AudioEngine {
  ctx: AudioContext | null = null;
  teamGain: GainNode | null = null;
  individualGain: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  sources: Map<string, MediaStreamAudioSourceNode> = new Map();

  init() {
    if (this.ctx) return;
    
    // Web Audio API requires user interaction to start in some browsers
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    this.teamGain = this.ctx.createGain();
    this.individualGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    
    this.analyser.fftSize = 256;
    
    // Routing: Sources -> GainNodes -> Analyser -> Destination
    this.teamGain.connect(this.analyser);
    this.individualGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  addStream(id: string, stream: MediaStream, isTeam: boolean = true) {
    if (!this.ctx || !this.teamGain || !this.individualGain) this.init();
    
    if (this.sources.has(id)) {
      this.removeStream(id);
    }

    try {
      const source = this.ctx!.createMediaStreamSource(stream);
      source.connect(isTeam ? this.teamGain! : this.individualGain!);
      this.sources.set(id, source);
    } catch (e) {
      console.error("Error adding stream to AudioEngine:", e);
    }
  }

  removeStream(id: string) {
    const source = this.sources.get(id);
    if (source) {
      source.disconnect();
      this.sources.delete(id);
    }
  }

  duckTeam(duck: boolean) {
    if (!this.ctx || !this.teamGain) return;
    
    const now = this.ctx.currentTime;
    // Exponential ramp for smooth ducking
    if (duck) {
      this.teamGain.gain.cancelScheduledValues(now);
      this.teamGain.gain.setValueAtTime(this.teamGain.gain.value, now);
      this.teamGain.gain.exponentialRampToValueAtTime(0.2, now + 0.1);
    } else {
      this.teamGain.gain.cancelScheduledValues(now);
      this.teamGain.gain.setValueAtTime(this.teamGain.gain.value, now);
      this.teamGain.gain.exponentialRampToValueAtTime(1.0, now + 0.1);
    }
  }
  
  getWaveformData(): Uint8Array {
    if (!this.analyser) return new Uint8Array(0);
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    return dataArray;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }
}

export const audioEngine = new AudioEngine();
