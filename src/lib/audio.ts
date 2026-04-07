export class AudioEngine {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  audioElements: Map<string, { audio: HTMLAudioElement, isTeam: boolean, source: MediaStreamAudioSourceNode | null, gain: GainNode | null }> = new Map();
  audioPool: HTMLAudioElement[] = [];
  activeStates: Map<string, boolean> = new Map();
  isDucking: boolean = false;

  init() {
    if (this.ctx) return;
    
    // Web Audio API requires user interaction to start in some browsers
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;

    // Anti-throttling: Keep AudioContext alive with a nearly silent oscillator
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0001; // Inaudible
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();

    // Set MediaSession to prevent background throttling
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }

    const silentWav = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

    // Pre-create audio elements during user interaction to bypass background autoplay restrictions
    for (let i = 0; i < 15; i++) {
      const audio = new Audio();
      audio.muted = true;
      audio.setAttribute('playsinline', 'true');
      audio.style.display = 'none';
      document.body.appendChild(audio);
      
      // Unlock the audio element for future background playback with a silent WAV
      audio.src = silentWav;
      audio.play().then(() => {
        audio.pause();
        audio.src = '';
        audio.srcObject = null;
      }).catch(e => {
        // Ignore autoplay errors here, they just mean we didn't have a strong enough user gesture yet
      });
      
      this.audioPool.push(audio);
    }
  }

  addStream(id: string, stream: MediaStream, isTeam: boolean = true) {
    this.init();
    this.removeStream(id);

    try {
      let audio = this.audioPool.find(a => !a.srcObject && !a.src);
      if (!audio) {
        audio = new Audio();
        audio.setAttribute('playsinline', 'true');
        audio.style.display = 'none';
        document.body.appendChild(audio);
        this.audioPool.push(audio);
      }

      const isActive = this.activeStates.get(id) || false;
      audio.muted = !isActive; // Sync with current active state immediately!
      audio.autoplay = true;
      audio.srcObject = stream;
      audio.play().catch(e => console.warn("Audio play failed (needs interaction):", e));

      // 2. Web Audio API for the Waveform Visualizer
      let source: MediaStreamAudioSourceNode | null = null;
      let gain: GainNode | null = null;

      if (this.ctx) {
        source = this.ctx.createMediaStreamSource(stream);
        gain = this.ctx.createGain();
        gain.gain.value = isActive ? 1 : 0; // Sync visualizer state
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
      item.audio.src = '';
      // We don't remove from DOM, we keep it in the pool for reuse
      if (item.source && item.gain) {
        item.source.disconnect();
        item.gain.disconnect();
      }
      this.audioElements.delete(id);
    }
  }

  setStreamActive(id: string, active: boolean, isTeam: boolean) {
    this.activeStates.set(id, active);
    const item = this.audioElements.get(id);
    if (item) {
      item.isTeam = isTeam;
      item.audio.muted = !active; // Unmute the speaker if they are talking to us
      if (active && item.audio.paused) {
        item.audio.play().catch(e => console.warn("Play failed on unmute", e));
      }
      if (item.gain) {
        item.gain.gain.value = active ? 1 : 0; // Show in waveform if active
      }
      this.updateVolumes();
    }
  }

  playAll() {
    this.audioElements.forEach(item => {
      if (item.audio.paused && !item.audio.muted) {
        item.audio.play().catch(e => console.warn("PlayAll failed", e));
      }
    });
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
