/**
 * EMS Signal Generator - AudioWorklet Processor (Pulse Trigger Mode)
 * 
 * Generates EMS carrier signals in response to prominence triggers.
 * When a pulse trigger is received, emits a short burst of the carrier wave
 * with configurable duration and intensity.
 */

class EMSProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ── Carrier parameters ──
    this.carrierFreq = 4000.0;    // Hz
    this.pulseWidth = 200.0;      // μs (within each carrier cycle period)
    this.waveform = 0;            // 0=sine, 1=square, 2=biphasic
    this.channelMode = 0;         // 0=mono, 1=L, 2=R, 3=alternating

    // ── Pulse trigger state ──
    this.pulseActive = false;
    this.pulseSamplesRemaining = 0;
    this.pulseIntensity = 0.0;    // 0-1 current pulse intensity
    this.maxAmplitude = 0.5;      // master amplitude cap (safety)

    // ── Envelope ──
    this.attackSamples = 0;
    this.decaySamples = 0;
    this.totalPulseSamples = 0;
    this.envelopePhase = 0;       // 0=attack, 1=sustain, 2=decay

    // ── Phase accumulator ──
    this.carrierPhase = 0.0;
    this.TWO_PI = 2.0 * Math.PI;
    this.invSampleRate = 1.0 / sampleRate;

    // ── Smooth ramp for safety ──
    this.rampValue = 0.0;
    this.rampRate = 0.002;

    // ── Global enable ──
    this.enabled = false;

    // ── Listen for messages from main thread ──
    this.port.onmessage = (event) => {
      const data = event.data;

      if (data.type === 'params') {
        if (data.carrierFreq !== undefined) this.carrierFreq = data.carrierFreq;
        if (data.pulseWidth !== undefined) this.pulseWidth = data.pulseWidth;
        if (data.waveform !== undefined) this.waveform = data.waveform;
        if (data.channelMode !== undefined) this.channelMode = data.channelMode;
        if (data.maxAmplitude !== undefined) this.maxAmplitude = Math.min(1.0, Math.max(0, data.maxAmplitude));
      }

      if (data.type === 'pulse') {
        // Trigger a pulse burst
        const durationMs = data.durationMs || 100;
        const intensity = Math.min(1.0, Math.max(0, data.intensity || 0.5));
        const attackMs = data.attackMs || 5;
        const decayMs = data.decayMs || 20;

        this.totalPulseSamples = Math.round((durationMs / 1000) * sampleRate);
        this.attackSamples = Math.round((attackMs / 1000) * sampleRate);
        this.decaySamples = Math.round((decayMs / 1000) * sampleRate);
        this.pulseSamplesRemaining = this.totalPulseSamples;
        this.pulseIntensity = intensity;
        this.pulseActive = true;
        this.envelopePhase = 0;
      }

      if (data.type === 'enable') {
        this.enabled = data.value;
        if (!data.value) {
          this.pulseActive = false;
          this.pulseSamplesRemaining = 0;
        }
      }

      if (data.type === 'stop') {
        this.pulseActive = false;
        this.pulseSamplesRemaining = 0;
        this.rampValue = 0;
        this.enabled = false;
      }
    };
  }

  generateCarrier(phase) {
    switch (this.waveform) {
      case 0: // Sine
        return Math.sin(phase);
      case 1: // Square
        return Math.sin(phase) >= 0 ? 1.0 : -1.0;
      case 2: { // Biphasic
        const p = ((phase % this.TWO_PI) + this.TWO_PI) % this.TWO_PI / this.TWO_PI;
        if (p < 0.25) return 1.0;
        if (p < 0.5) return -1.0;
        return 0.0;
      }
      default:
        return Math.sin(phase);
    }
  }

  computeEnvelope() {
    if (!this.pulseActive || this.pulseSamplesRemaining <= 0) return 0.0;

    const elapsed = this.totalPulseSamples - this.pulseSamplesRemaining;

    // Attack phase
    if (elapsed < this.attackSamples && this.attackSamples > 0) {
      return (elapsed / this.attackSamples) * this.pulseIntensity;
    }

    // Decay phase
    const decayStart = this.totalPulseSamples - this.decaySamples;
    if (elapsed >= decayStart && this.decaySamples > 0) {
      const decayElapsed = elapsed - decayStart;
      return (1.0 - decayElapsed / this.decaySamples) * this.pulseIntensity;
    }

    // Sustain phase
    return this.pulseIntensity;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const numSamples = output[0].length;

    for (let i = 0; i < numSamples; i++) {
      // Compute target amplitude
      let targetAmp = 0.0;
      if (this.enabled && this.pulseActive && this.pulseSamplesRemaining > 0) {
        targetAmp = 1.0;
      }

      // Smooth ramp
      if (this.rampValue < targetAmp) {
        this.rampValue = Math.min(this.rampValue + this.rampRate, targetAmp);
      } else if (this.rampValue > targetAmp) {
        this.rampValue = Math.max(this.rampValue - this.rampRate, targetAmp);
      }

      // Envelope
      const envelope = this.computeEnvelope();

      // Carrier wave
      const carrierAngle = this.TWO_PI * this.carrierPhase * this.invSampleRate;
      const carrier = this.generateCarrier(carrierAngle);

      // Final sample
      const sample = carrier * envelope * this.maxAmplitude * this.rampValue;

      // Channel routing
      const numChannels = output.length;
      for (let ch = 0; ch < numChannels; ch++) {
        switch (this.channelMode) {
          case 0: output[ch][i] = sample; break;
          case 1: output[ch][i] = (ch === 0) ? sample : 0.0; break;
          case 2: output[ch][i] = (ch === 1) ? sample : 0.0; break;
          default: output[ch][i] = sample;
        }
      }

      // Advance carrier phase
      this.carrierPhase += this.carrierFreq;
      if (this.carrierPhase > sampleRate * 10) {
        this.carrierPhase -= sampleRate * 10;
      }

      // Decrement pulse counter
      if (this.pulseActive && this.pulseSamplesRemaining > 0) {
        this.pulseSamplesRemaining--;
        if (this.pulseSamplesRemaining <= 0) {
          this.pulseActive = false;
        }
      }
    }

    // Send waveform data to main thread for visualization
    if (output[0]) {
      this.port.postMessage({
        type: 'waveform',
        data: new Float32Array(output[0])
      });
    }

    return true;
  }
}

registerProcessor('ems-processor', EMSProcessor);
