// Web Audio API Procedural Ambient Dream Soundscape Engine ($0 Cost)

class AmbientSoundEngine {
  private ctx: AudioContext | null = null;
  private isPlaying: boolean = false;
  private masterGain: GainNode | null = null;
  private oscillators: OscillatorNode[] = [];
  private noiseNode: AudioBufferSourceNode | null = null;

  public init() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioContextClass();
    }
  }

  public start(mood: string = 'ethereal') {
    if (this.isPlaying) return;
    this.init();
    if (!this.ctx) return;

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.isPlaying = true;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.01, this.ctx.currentTime);
    // Smoothly fade in over 2 seconds
    this.masterGain.gain.exponentialRampToValueAtTime(0.18, this.ctx.currentTime + 2.0);
    this.masterGain.connect(this.ctx.destination);

    // 1. Warm low fundamental drone (Root note C2 ~65.4Hz or A1 ~55Hz)
    const baseFreq = mood === 'cyberpunk' ? 55.0 : 65.41;
    this.createDroneOscillator(baseFreq, 'sine', 0.12);

    // 2. Ethereal 5th harmonic (G2 ~98Hz)
    this.createDroneOscillator(baseFreq * 1.5, 'sine', 0.08);

    // 3. Shimmering octave harmonic with slow gentle LFO detune
    this.createShimmerOscillator(baseFreq * 2.0, 0.04);

    // 4. Subtle vinyl/air texture noise
    this.createAmbientTexture();
  }

  private createDroneOscillator(freq: number, type: OscillatorType, gainVal: number) {
    if (!this.ctx || !this.masterGain) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

    // Subtle drift LFO
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.setValueAtTime(0.15, this.ctx.currentTime); // 0.15Hz slow breathing
    lfoGain.gain.setValueAtTime(1.5, this.ctx.currentTime);
    lfo.connect(osc.frequency);
    lfo.start();

    gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start();
    this.oscillators.push(osc);
  }

  private createShimmerOscillator(freq: number, gainVal: number) {
    if (!this.ctx || !this.masterGain) return;
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(450, this.ctx.currentTime);

    gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    osc.start();
    this.oscillators.push(osc);
  }

  private createAmbientTexture() {
    if (!this.ctx || !this.masterGain) return;
    // 2 seconds of pink/brown filtered noise looped
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0.0;

    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      // Brown noise integration
      data[i] = (lastOut + 0.02 * white) / 1.02;
      lastOut = data[i];
      data[i] *= 0.6;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(320, this.ctx.currentTime);
    noiseFilter.Q.setValueAtTime(1.0, this.ctx.currentTime);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.025, this.ctx.currentTime);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.masterGain);

    noise.start();
    this.noiseNode = noise;
  }

  public stop() {
    if (!this.isPlaying || !this.ctx || !this.masterGain) return;

    // Smoothly fade out over 1.2s before stopping
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
    this.masterGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 1.2);

    setTimeout(() => {
      this.oscillators.forEach(osc => {
        try { osc.stop(); osc.disconnect(); } catch (e) {}
      });
      this.oscillators = [];

      if (this.noiseNode) {
        try { this.noiseNode.stop(); this.noiseNode.disconnect(); } catch (e) {}
        this.noiseNode = null;
      }

      this.isPlaying = false;
    }, 1250);
  }

  public toggle(): boolean {
    if (this.isPlaying) {
      this.stop();
      return false;
    } else {
      this.start();
      return true;
    }
  }

  public getStatus(): boolean {
    return this.isPlaying;
  }
}

export const ambientSound = new AmbientSoundEngine();
