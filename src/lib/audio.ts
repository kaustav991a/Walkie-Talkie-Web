export class AudioEngine {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  audioElements: Map<string, { audio: HTMLAudioElement, isTeam: boolean, source: MediaStreamAudioSourceNode | null, gain: GainNode | null }> = new Map();
  isDucking: boolean = false;

  init() {
    if (this.ctx) return;
    
    // Web Audio API requires user interaction to start in some browsers
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    // We intentionally DO NOT connect the analyser to ctx.destination
    // Playback is handled entirely by the HTMLAudioElement to bypass background tab throttling
  }

  addStream(id: string, stream: MediaStream, isTeam: boolean = true) {
    this.init();
    this.removeStream(id);

    try {
      // 1. HTMLAudioElement for actual reliable playback (works in background tabs)
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = stream;
      audio.muted = true; // Start muted until they actually press PTT
      audio.setAttribute('playsinline', 'true'); 
      audio.play().catch(e => console.warn("Audio play failed (needs interaction):", e));

      // 2. Web Audio API for the Waveform Visualizer
      let source: MediaStreamAudioSourceNode | null = null;
      let gain: GainNode | null = null;

      if (this.ctx) {
        source = this.ctx.createMediaStreamSource(stream);
        gain = this.ctx.createGain();
        gain.gain.value = 0; // Start muted in visualizer too
        source.connect(gain);
        gain.connect(this.analyser!);
      }

      this.audioElements.set(id, { audio, isTeam, source, gain });
    } catch (e) {
      console.error("Error adding stream to AudioEngine:", e);
    }
  }

  removeStream(id: string) {
    const item = this.audioElements.get(id);
    if (item) {
      item.audio.pause();
      item.audio.srcObject = null;
      if (item.source && item.gain) {
        item.source.disconnect();
        item.gain.disconnect();
      }
      this.audioElements.delete(id);
    }
  }

  setStreamActive(id: string, active: boolean, isTeam: boolean) {
    const item = this.audioElements.get(id);
    if (item) {
      item.isTeam = isTeam;
      item.audio.muted = !active; // Unmute the speaker if they are talking to us
      if (item.gain) {
        item.gain.gain.value = active ? 1 : 0; // Show in waveform if active
      }
      this.updateVolumes();
    }
  }

  duckTeam(duck: boolean) {
    this.isDucking = duck;
    this.updateVolumes();
  }

  private updateVolumes() {
    this.audioElements.forEach((item) => {
      if (item.isTeam) {
        item.audio.volume = this.isDucking ? 0.2 : 1.0;
      } else {
        item.audio.volume = 1.0;
      }
    });
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
