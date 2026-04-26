/**
 * Visceral Resonance — Exhibition Web App
 *
 * Pipeline:
 *   Mic → AudioWorklet → syllable.wasm (ProminenceDetectorWasm)
 *     → prominence events → ACN scoring (acn.wasm / JS)
 *       → threshold check → EMS pulse trigger (ems-processor.js)
 *
 *   OR: Stereo WAV (L=Audio, R=EMS) → Dual-port playback
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════
// ProminenceDetectorWasm
// ═══════════════════════════════════════════════════════════════════

class ProminenceDetectorWasm {
  constructor(options = {}) {
    this.config = {
      sampleRate: options.sampleRate || 48000,
      prominenceThreshold: options.prominenceThreshold || 0.20,
      minSyllableDistMs: options.minSyllableDistMs || 150,
      calibrationDurationMs: options.calibrationDurationMs || 2000,
      minEnergyThreshold: options.minEnergyThreshold || 0.001,
    };

    this.wasmModule = null;
    this.detector = null;
    this.isReady = false;
    this.isRunning = false;
    this.isCalibrating = false;

    this.audioContext = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.sinkNode = null;
    this.scriptProcessor = null;
    this.mediaStream = null;
    this.useAudioWorklet = false;

    this.lastProminenceTime = 0;
    this.lastProminenceSample = -1;
    this.totalProcessedSamples = 0;
    this.minSyllableDistSamples = Math.max(
      1, Math.round((this.config.minSyllableDistMs * this.config.sampleRate) / 1000.0)
    );
    this.inputBuffer = null;
    this.inputBufferCapacity = 0;

    // ── VAD State ──
    this.vadEnabled = true;
    this.vadRatio = options.vadRatio || 3.0;
    this.vadNoiseFloor = 0.0;
    this.vadNoiseAlpha = 0.0;
    this.vadIsSpeech = false;
    this.vadHangoverMs = 200;
    this.vadHangoverSamples = 0;
    this.vadHangoverRemaining = 0;
    this.vadNoiseInitialized = false;
    this.vadCurrentRMS = 0.0;
    this.onVadChange = options.onVadChange || (() => {});

    this.onProminence = options.onProminence || (() => {});
    this.onCalibrationStart = options.onCalibrationStart || (() => {});
    this.onCalibrationEnd = options.onCalibrationEnd || (() => {});
    this.onError = options.onError || ((err) => console.error(err));
    this.onReady = options.onReady || (() => {});
  }

  async init() {
    try {
      this.wasmModule = await SyllableModule();
      this._syllable_create = this.wasmModule.cwrap('syllable_create', 'number', ['number']);
      this._syllable_process = this.wasmModule.cwrap('syllable_process', 'number',
        ['number', 'number', 'number', 'number', 'number']);
      this._syllable_destroy = this.wasmModule.cwrap('syllable_destroy', null, ['number']);
      this._syllable_set_realtime_mode = this.wasmModule.cwrap('syllable_set_realtime_mode', null, ['number', 'number']);
      this._syllable_recalibrate = this.wasmModule.cwrap('syllable_recalibrate', null, ['number']);
      this._syllable_is_calibrating = this.wasmModule.cwrap('syllable_is_calibrating', 'number', ['number']);
      this._syllable_set_snr_threshold = this.wasmModule.cwrap('syllable_set_snr_threshold', null, ['number', 'number']);

      this.detector = this._syllable_create(0);
      this._syllable_set_snr_threshold(this.detector, 6.0);
      this._syllable_set_realtime_mode(this.detector, 1);

      if (!this.detector) throw new Error('Failed to create WASM detector');
      this.isReady = true;
      this.onReady();
      return true;
    } catch (err) {
      this.onError(err);
      return false;
    }
  }

  async start() {
    if (!this.isReady) {
      const ok = await this.init();
      if (!ok) return false;
    }

    try {
      this.lastProminenceSample = -1;
      this.totalProcessedSamples = 0;

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: this.config.sampleRate
        }
      });

      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: this.config.sampleRate
      });
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      this.config.sampleRate = this.audioContext.sampleRate;
      this.minSyllableDistSamples = Math.max(
        1, Math.round((this.config.minSyllableDistMs * this.config.sampleRate) / 1000.0)
      );

      const vadTauS = 1.0;
      const chunkRate = this.config.sampleRate / 1024;
      this.vadNoiseAlpha = 1.0 / (vadTauS * chunkRate);
      this.vadHangoverSamples = Math.round((this.vadHangoverMs / 1000) * this.config.sampleRate);

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.sinkNode = this.audioContext.createGain();
      this.sinkNode.gain.value = 0;

      const workletReady = await this._setupAudioWorklet();
      if (!workletReady) this._setupScriptProcessorFallback();

      this.isRunning = true;
      this.startCalibration();
      return true;
    } catch (err) {
      this.onError(err);
      return false;
    }
  }

  stop() {
    this.isRunning = false;
    this.isCalibrating = false;
    if (this._calibrationCheckInterval) clearInterval(this._calibrationCheckInterval);
    if (this.scriptProcessor) { this.scriptProcessor.disconnect(); this.scriptProcessor = null; }
    if (this.workletNode) { this.workletNode.port.onmessage = null; this.workletNode.disconnect(); this.workletNode = null; }
    if (this.sourceNode) { this.sourceNode.disconnect(); this.sourceNode = null; }
    if (this.sinkNode) { this.sinkNode.disconnect(); this.sinkNode = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
    if (this.inputBuffer) { this.wasmModule._free(this.inputBuffer); this.inputBuffer = null; this.inputBufferCapacity = 0; }
  }

  startCalibration() {
    this.isCalibrating = true;
    this.onCalibrationStart();
    if (this._syllable_recalibrate) this._syllable_recalibrate(this.detector);
    this._calibrationCheckInterval = setInterval(() => {
      if (!this._syllable_is_calibrating(this.detector)) {
        this.isCalibrating = false;
        this.onCalibrationEnd();
        clearInterval(this._calibrationCheckInterval);
      }
    }, 100);
  }

  getSampleRate() { return this.config.sampleRate; }

  _readU64(ptr) {
    if (!this.wasmModule || !this.wasmModule.HEAPU32) return NaN;
    const lo = this.wasmModule.HEAPU32[ptr >> 2] >>> 0;
    const hi = this.wasmModule.HEAPU32[(ptr + 4) >> 2] >>> 0;
    return (hi * 4294967296) + lo;
  }

  async _setupAudioWorklet() {
    if (!this.audioContext || !this.audioContext.audioWorklet) return false;
    try {
      await this.audioContext.audioWorklet.addModule('./lib/worklets/audio-chunk-processor.js');
      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-chunk-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
        processorOptions: { chunkSize: 1024 }
      });
      this.workletNode.port.onmessage = (event) => {
        if (event?.data?.audio) this._processAudioSamples(event.data.audio);
      };
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.sinkNode);
      this.sinkNode.connect(this.audioContext.destination);
      this.useAudioWorklet = true;
      return true;
    } catch (e) {
      console.warn('[Prominence] AudioWorklet unavailable:', e);
      return false;
    }
  }

  _setupScriptProcessorFallback() {
    this.scriptProcessor = this.audioContext.createScriptProcessor(1024, 1, 1);
    this.scriptProcessor.onaudioprocess = (e) => this._processAudioSamples(e.inputBuffer.getChannelData(0));
    this.sourceNode.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.sinkNode);
    this.sinkNode.connect(this.audioContext.destination);
  }

  _ensureInputBuffer(numSamples) {
    if (this.inputBuffer && this.inputBufferCapacity >= numSamples) return;
    if (this.inputBuffer) { this.wasmModule._free(this.inputBuffer); this.inputBuffer = null; }
    this.inputBuffer = this.wasmModule._malloc(numSamples * 4);
    this.inputBufferCapacity = numSamples;
  }

  _computeRMS(data) {
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
    return Math.sqrt(sumSq / data.length);
  }

  _updateNoiseFloor(rms) {
    if (!this.vadNoiseInitialized) {
      this.vadNoiseFloor = rms;
      this.vadNoiseInitialized = true;
      return;
    }
    if (!this.vadIsSpeech) {
      this.vadNoiseFloor += this.vadNoiseAlpha * (rms - this.vadNoiseFloor);
    }
    if (this.vadNoiseFloor < 1e-6) this.vadNoiseFloor = 1e-6;
  }

  _vadDecision(rms, numSamples) {
    const speechDetected = rms > this.vadNoiseFloor * this.vadRatio;
    const prevState = this.vadIsSpeech;

    if (speechDetected) {
      this.vadIsSpeech = true;
      this.vadHangoverRemaining = this.vadHangoverSamples;
    } else {
      this.vadHangoverRemaining -= numSamples;
      if (this.vadHangoverRemaining <= 0) {
        this.vadIsSpeech = false;
        this.vadHangoverRemaining = 0;
      }
    }

    if (this.vadIsSpeech !== prevState) {
      this.onVadChange(this.vadIsSpeech, rms);
    }

    return this.vadIsSpeech;
  }

  _processAudioSamples(inputData) {
    if (!this.isRunning || !this.detector || !this.wasmModule) return;
    if (!inputData || inputData.length === 0) return;

    const numSamples = inputData.length;
    const blockStartSample = this.totalProcessedSamples;

    const rms = this._computeRMS(inputData);
    this.vadCurrentRMS = rms;
    this._updateNoiseFloor(rms);

    if (this.vadEnabled) {
      const isSpeech = this._vadDecision(rms, numSamples);
      if (!isSpeech) {
        this.totalProcessedSamples += numSamples;
        return;
      }
    }

    this._ensureInputBuffer(numSamples);

    for (let i = 0; i < numSamples; i++) {
      this.wasmModule.setValue(this.inputBuffer + i * 4, inputData[i], 'float');
    }

    const maxEvents = 8;
    const eventSize = 72;
    const eventBuffer = this.wasmModule._malloc(maxEvents * eventSize);
    const numEvents = this._syllable_process(this.detector, this.inputBuffer, numSamples, eventBuffer, maxEvents);

    if (numEvents > 0) {
      for (let i = 0; i < numEvents; i++) {
        const basePtr = eventBuffer + i * eventSize;
        const fusionScore = this.wasmModule.getValue(basePtr + 56, 'float');
        const energy = this.wasmModule.getValue(basePtr + 24, 'float');
        const spectralFlux = this.wasmModule.getValue(basePtr + 40, 'float');

        if (this.isCalibrating) continue;

        const now = performance.now();
        const rawSampleIndex = this._readU64(basePtr);
        const sampleIndex = Number.isFinite(rawSampleIndex) ? rawSampleIndex : (blockStartSample + Math.floor(numSamples * 0.5));
        const sampleDistance = this.lastProminenceSample < 0 ? Infinity : (sampleIndex - this.lastProminenceSample);
        const hasEnoughEnergy = energy > this.config.minEnergyThreshold || spectralFlux > 0.1;
        const passedThreshold = fusionScore > this.config.prominenceThreshold;
        const passedTiming = sampleDistance > this.minSyllableDistSamples;

        if (passedThreshold && passedTiming && hasEnoughEnergy) {
          this.lastProminenceTime = now;
          this.lastProminenceSample = sampleIndex;
          this.onProminence({
            timestamp: now,
            sampleIndex,
            sampleRate: this.config.sampleRate,
            fusionScore,
            features: {
              energy,
              durationS: this.wasmModule.getValue(basePtr + 36, 'float'),
              spectralFlux,
              highFreqEnergy: this.wasmModule.getValue(basePtr + 44, 'float'),
              mfccDelta: this.wasmModule.getValue(basePtr + 48, 'float'),
              f0: this.wasmModule.getValue(basePtr + 28, 'float')
            }
          });
        }
      }
    }

    this.wasmModule._free(eventBuffer);
    this.totalProcessedSamples += numSamples;
  }

  destroy() {
    this.stop();
    if (this.detector) { this._syllable_destroy(this.detector); this.detector = null; }
  }
}


// ═══════════════════════════════════════════════════════════════════
// EMSProminenceApp — Exhibition Main Application
// ═══════════════════════════════════════════════════════════════════

class EMSProminenceApp {
  constructor() {
    this.isRunning = false;
    this.prominenceDetector = null;
    this.acnFeatureExtractor = null;
    this.acnRuntime = null;
    this.enableAcn = false;

    this.emsAudioCtx = null;
    this.emsWorkletNode = null;

    this.eventBuffer = [];
    this.maxEventBufferSize = 100;

    this.cueBuffer = [];
    this.maxCueBufferSize = 50;

    // Default parameters
    this.threshold = 0.60;
    this.maxAmplitude = 0;
    this.carrierFreq = 4000;
    this.pulseDurationMs = 100;
    this.cooldownMs = 200;
    this.waveform = 0;
    this.lastPulseTime = 0;
    this.totalEvents = 0;
    this.totalPulses = 0;

    this.latencyMode = 'low';

    this.waveformData = new Float32Array(128);
    this.animFrameId = null;

    this.wooferCutoffHz = 120;
    this.wooferGain = 25;
    this.wooferSourceBuffer = null;
    this.wooferAudioUrl = null;
    this.wooferUsbUrl = null;
    this.wooferMeterFrame = null;
    this.wooferLiveStream = null;
    this.wooferLiveCtx = null;
    this.wooferLiveNodes = null;

    this.els = {};
  }

  // ── Initialize ──

  async init() {
    this._cacheDom();
    this._bindControls();
    this._setStatus('Initializing…', '');
    console.log('[VR] Initializing…');

    try {
      await this._initProminenceDetector();
      await this._initAcnRuntime();
      await this._initEmsAudio();
      this._setStatus('Ready — Press Start', 'ready');
      console.log('[VR] Ready');
    } catch (err) {
      console.error('[VR] Init error:', err);
      this._setStatus(`Error: ${err.message}`, 'error');
    }
  }

  async _initProminenceDetector() {
    if (typeof SyllableModule === 'undefined') {
      throw new Error('syllable.wasm not loaded. Check script path.');
    }

    this.prominenceDetector = new ProminenceDetectorWasm({
      sampleRate: 48000,
      prominenceThreshold: 0.20,
      minSyllableDistMs: 150,
      minEnergyThreshold: 0.001,
      calibrationDurationMs: 2000,
      vadRatio: 3.0,
      onReady: () => console.log('[Prominence] WASM ready'),
      onCalibrationStart: () => this._setStatus('Calibrating… Stay quiet', 'calibrating'),
      onCalibrationEnd: () => { if (this.isRunning) this._setStatus('Listening…', 'ready'); },
      onProminence: (event) => this._handleProminenceEvent(event),
      onVadChange: (isSpeech, rms) => this._handleVadChange(isSpeech, rms),
      onError: (err) => console.error('[Prominence] Error:', err),
    });
  }

  async _initAcnRuntime() {
    if (typeof ACNFeatureExtractor === 'undefined' || typeof ACNRuntime === 'undefined') {
      console.warn('[ACN] Runtime scripts not loaded. Using fusionScore only.');
      this.enableAcn = false;
      this.els.acnBackend.textContent = 'none';
      return;
    }

    this.acnFeatureExtractor = new ACNFeatureExtractor({
      minDurationSec: 0.02,
      nearbyToleranceMs: 250
    });

    const hasWeights = typeof window !== 'undefined' && window.ACN_MODEL_WEIGHTS;
    if (!hasWeights) {
      console.warn('[ACN] Model weights unavailable.');
      this.enableAcn = false;
      this.els.acnBackend.textContent = 'no weights';
      return;
    }

    // Try WASM backend
    if (typeof ACNWasmRuntime !== 'undefined') {
      try {
        const wasmRuntime = new ACNWasmRuntime({
          normalizationMode: 'session',
          moduleScriptUrl: './lib/acn.js',
          wasmBinaryUrl: './lib/acn.wasm'
        });
        const loaded = await wasmRuntime.loadModel(window.ACN_MODEL_WEIGHTS);
        if (loaded) {
          this.acnRuntime = wasmRuntime;
          this.enableAcn = true;
          this.els.acnBackend.textContent = 'wasm';
          console.log(`[ACN] Ready (${wasmRuntime.getModelVersion()}, backend=wasm)`);
          return;
        }
      } catch (e) {
        console.warn('[ACN] WASM unavailable, trying JS fallback:', e);
      }
    }

    // JS fallback
    this.acnRuntime = new ACNRuntime({ normalizationMode: 'session' });
    const loaded = this.acnRuntime.loadModel(window.ACN_MODEL_WEIGHTS);
    this.enableAcn = !!loaded;
    this.els.acnBackend.textContent = loaded ? 'js' : 'failed';
    if (loaded) console.log(`[ACN] Ready (${this.acnRuntime.getModelVersion()}, backend=js)`);
  }

  async _initEmsAudio() {
    this.emsAudioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'interactive',
    });

    await this.emsAudioCtx.audioWorklet.addModule('./ems-processor.js');

    this.emsWorkletNode = new AudioWorkletNode(this.emsAudioCtx, 'ems-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    this.emsWorkletNode.connect(this.emsAudioCtx.destination);

    this.emsWorkletNode.port.onmessage = (event) => {
      if (event.data.type === 'waveform') {
        this.waveformData = event.data.data;
      }
    };

    this._sendEmsParams();
    this.els.sampleRateInfo.textContent = `${(this.emsAudioCtx.sampleRate / 1000).toFixed(1)} kHz`;
    console.log('[EMS] Audio engine ready');
  }

  _sendEmsParams() {
    if (!this.emsWorkletNode) return;
    this.emsWorkletNode.port.postMessage({
      type: 'params',
      carrierFreq: this.carrierFreq,
      waveform: this.waveform,
      maxAmplitude: this.maxAmplitude / 100,
    });
  }

  _triggerPulse(intensity) {
    if (!this.emsWorkletNode || !this.isRunning) return;
    if (this.maxAmplitude <= 0) return;

    const now = performance.now();
    if (now - this.lastPulseTime < this.cooldownMs) return;

    this.lastPulseTime = now;
    this.totalPulses++;

    this.emsWorkletNode.port.postMessage({
      type: 'pulse',
      durationMs: this.pulseDurationMs,
      intensity: Math.min(1.0, intensity),
      attackMs: 5,
      decayMs: Math.min(30, this.pulseDurationMs * 0.3),
    });

    this.els.totalPulses.textContent = this.totalPulses;
    this.els.pulseCount.textContent = `${this.totalPulses} pulses`;
    this._flashPulseIndicator();
  }

  // ── Prominence Event Handling ──

  _handleProminenceEvent(event) {
    this.totalEvents++;
    this.els.eventCount.textContent = this.totalEvents;

    this.eventBuffer.push({
      timestamp: event.timestamp,
      sampleIndex: event.sampleIndex,
      fusionScore: event.fusionScore,
      features: event.features,
    });
    if (this.eventBuffer.length > this.maxEventBufferSize) this.eventBuffer.shift();

    let finalScore;
    if (this.latencyMode === 'low') {
      finalScore = event.fusionScore;
    } else {
      let acnScore = NaN;
      if (this.enableAcn && this.acnFeatureExtractor && this.acnRuntime) {
        acnScore = this._computeAcnScore(event);
      }
      finalScore = Number.isFinite(acnScore) ? acnScore : event.fusionScore;
    }

    this._updateProminenceMeter(finalScore);

    const triggered = finalScore >= this.threshold;
    this._addLogEntry(event.timestamp, finalScore, triggered);

    if (triggered) {
      const intensity = Math.min(1.0, (finalScore - this.threshold) / (1.0 - this.threshold) * 0.8 + 0.2);
      this._triggerPulse(intensity);
    }
  }

  _handleVadChange(isSpeech, rms) {
    if (this.els.vadDot) {
      this.els.vadDot.className = `vad-indicator__dot ${isSpeech ? 'active' : ''}`;
      this.els.vadText.textContent = isSpeech ? 'Speech' : 'Silence';
      this.els.vadText.style.color = isSpeech ? 'var(--accent-green)' : 'var(--text-muted)';
    }
    if (this.els.statusVad) {
      this.els.statusVad.textContent = isSpeech ? '🟢' : '🔴';
    }
  }

  _computeAcnScore(event) {
    const features = event.features || {};
    const duration = Number.isFinite(features.durationS) ? features.durationS : 0.1;
    const energy = Number.isFinite(features.energy) ? features.energy : 0.001;
    const spectralFlux = Number.isFinite(features.spectralFlux) ? features.spectralFlux : 0.001;
    const highFreq = Number.isFinite(features.highFreqEnergy) ? features.highFreqEnergy : 0;
    const mfccDelta = Number.isFinite(features.mfccDelta) ? Math.abs(features.mfccDelta) : 0;

    const eps = 1e-6;
    const cues = [
      Math.log(Math.max(duration, eps)),
      Math.log(Math.max(energy, eps)),
      Math.log(Math.max(spectralFlux + 0.5 * highFreq + mfccDelta, eps))
    ];

    this.cueBuffer.push({ cues, timestamp: event.timestamp });
    if (this.cueBuffer.length > this.maxCueBufferSize) this.cueBuffer.shift();

    const n = this.cueBuffer.length;
    if (n < 2) return NaN;

    const prevIdx = Math.max(0, n - 3);
    const currIdx = n - 2;
    const nextIdx = n - 1;

    try {
      return this.acnRuntime.scoreTriplet({
        prevCues: this.cueBuffer[prevIdx].cues,
        currCues: this.cueBuffer[currIdx].cues,
        nextCues: this.cueBuffer[nextIdx].cues,
        hasPrev: currIdx > 0,
        hasNext: true,
      });
    } catch (e) {
      return NaN;
    }
  }

  // ── UI Updates ──

  _updateProminenceMeter(score) {
    const pct = Math.max(0, Math.min(100, score * 100));
    this.els.prominenceBar.style.width = `${pct}%`;
    this.els.prominenceScoreText.textContent = score.toFixed(2);
  }

  _flashPulseIndicator() {
    this.els.pulseDot.classList.add('firing');
    this.els.pulseText.textContent = 'PULSE!';
    this.els.pulseText.style.color = 'var(--accent-red)';

    setTimeout(() => {
      this.els.pulseDot.classList.remove('firing');
      this.els.pulseText.textContent = 'Ready';
      this.els.pulseText.style.color = '';
    }, 200);
  }

  _addLogEntry(timestamp, score, triggered) {
    const log = this.els.eventLog;
    const placeholder = log.querySelector('.event-log__placeholder');
    if (placeholder) placeholder.remove();

    const entry = document.createElement('div');
    entry.className = 'event-log__entry';

    const timeStr = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    entry.innerHTML = `
      <span class="event-log__time">${timeStr}</span>
      <span class="event-log__score">${score.toFixed(3)}</span>
      <span class="${triggered ? 'event-log__pulse' : 'event-log__skip'}">${triggered ? '⚡ PULSE' : '— skip'}</span>
    `;

    log.appendChild(entry);
    while (log.children.length > 50) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  _setStatus(text, className) {
    const chip = this.els.statusChip;
    chip.className = `status-chip ${className || ''}`;
    chip.querySelector('.status-chip__text').textContent = text;
  }

  // ── Power Toggle ──

  async togglePower() {
    if (!this.isRunning) {
      this._setStatus('Starting…', 'calibrating');

      const ok = await this.prominenceDetector.start();
      if (!ok) {
        this._setStatus('Failed to start microphone', 'error');
        return;
      }

      if (this.emsAudioCtx.state === 'suspended') {
        await this.emsAudioCtx.resume();
      }

      this.emsWorkletNode.port.postMessage({ type: 'enable', value: true });

      this.isRunning = true;
      this.els.powerBtn.classList.add('active');
      this.els.powerLabel.textContent = 'ON';
      this.els.powerLabel.classList.add('active');
      this.els.statusDot.classList.add('active');
      this.els.statusText.textContent = 'Listening';
      this.els.statusMic.textContent = 'Active';

      this._startVisualization();
      this._setStatus('Calibrating… Stay quiet', 'calibrating');
    } else {
      this.prominenceDetector.stop();
      this.emsWorkletNode.port.postMessage({ type: 'stop' });

      this.isRunning = false;
      this.els.powerBtn.classList.remove('active');
      this.els.powerLabel.textContent = 'OFF';
      this.els.powerLabel.classList.remove('active');
      this.els.statusDot.classList.remove('active');
      this.els.statusText.textContent = 'Idle';
      this.els.statusMic.textContent = '--';

      this._stopVisualization();
      this._setStatus('Stopped', '');
    }
  }

  // ── Waveform Visualization ──

  _startVisualization() {
    const canvas = this.els.waveformCanvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const draw = () => {
      const w = rect.width;
      const h = rect.height;

      ctx.fillStyle = '#060610';
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (h / 4) * i;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Center line
      ctx.strokeStyle = 'rgba(77,159,255,0.1)';
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

      // Waveform
      const data = this.waveformData;
      if (data && data.length > 0) {
        const centerY = h / 2;
        const scaleY = h * 0.4;

        ctx.shadowColor = 'rgba(248,113,113,0.5)';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = '#f87171';
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        for (let x = 0; x < w; x++) {
          const idx = Math.min(Math.floor(x * data.length / w), data.length - 1);
          const y = centerY - data[idx] * scaleY;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        ctx.globalAlpha = 0.06;
        ctx.fillStyle = '#f87171';
        ctx.lineTo(w, centerY);
        ctx.lineTo(0, centerY);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }

      this.animFrameId = requestAnimationFrame(draw);
    };
    draw();
  }

  _stopVisualization() {
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
  }

  // ── DOM Caching ──

  _cacheDom() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      powerBtn: $('powerBtn'),
      powerLabel: $('powerLabel'),
      statusChip: $('statusChip'),
      prominenceBar: $('prominenceBar'),
      prominenceThresholdLine: $('prominenceThresholdLine'),
      prominenceScoreText: $('prominenceScoreText'),
      pulseDot: $('pulseDot'),
      pulseText: $('pulseText'),
      pulseCount: $('pulseCount'),
      acnBackend: $('acnBackend'),
      eventCount: $('eventCount'),
      totalPulses: $('totalPulses'),
      waveformCanvas: $('waveformCanvas'),
      sampleRateInfo: $('sampleRateInfo'),
      thresholdSlider: $('thresholdSlider'),
      thresholdValue: $('thresholdValue'),
      amplitudeSlider: $('amplitudeSlider'),
      amplitudeValue: $('amplitudeValue'),
      carrierFreqSlider: $('carrierFreqSlider'),
      carrierFreqValue: $('carrierFreqValue'),
      pulseDurationSlider: $('pulseDurationSlider'),
      pulseDurationValue: $('pulseDurationValue'),
      waveformSelect: $('waveformSelect'),
      cooldownSlider: $('cooldownSlider'),
      cooldownValue: $('cooldownValue'),
      clearLogBtn: $('clearLogBtn'),
      eventLog: $('eventLog'),
      statusDot: $('statusDot'),
      statusText: $('statusText'),
      statusMic: $('statusMic'),
      statusCarrier: $('statusCarrier'),
      statusAmplitude: $('statusAmplitude'),
      // VAD + Latency mode
      vadDot: $('vadDot'),
      vadText: $('vadText'),
      vadSensitivitySlider: $('vadSensitivitySlider'),
      vadSensitivityValue: $('vadSensitivityValue'),
      latencyModeSelect: $('latencyModeSelect'),
      latencyModeInfo: $('latencyModeInfo'),
      statusVad: $('statusVad'),
      // Playback mode
      dropZone: $('dropZone'),
      playbackFileInput: $('playbackFileInput'),
      playbackPlayer: $('playbackPlayer'),
      playbackFileName: $('playbackFileName'),
      playbackClearBtn: $('playbackClearBtn'),
      audioPortSelect: $('audioPortSelect'),
      emsPortSelect: $('emsPortSelect'),
      refreshDevicesBtn: $('refreshDevicesBtn'),
      playBtn: $('playBtn'),
      pauseBtn: $('pauseBtn'),
      stopBtn: $('stopBtn'),
      seekSlider: $('seekSlider'),
      transportTime: $('transportTime'),
      statusPlayback: $('statusPlayback'),
      // Ab Woofer mode
      modeWooferBtn: $('modeWooferBtn'),
      modeWooferSection: $('modeWooferSection'),
      refreshWooferDevicesBtn: $('refreshWooferDevicesBtn'),
      wooferAudioPortSelect: $('wooferAudioPortSelect'),
      wooferUsbPortSelect: $('wooferUsbPortSelect'),
      wooferCaptureBtn: $('wooferCaptureBtn'),
      wooferStopCaptureBtn: $('wooferStopCaptureBtn'),
      wooferLivePreview: $('wooferLivePreview'),
      wooferLiveState: $('wooferLiveState'),
      wooferDropZone: $('wooferDropZone'),
      wooferFileInput: $('wooferFileInput'),
      wooferPlayer: $('wooferPlayer'),
      wooferFileName: $('wooferFileName'),
      wooferPlayBtn: $('wooferPlayBtn'),
      wooferPauseBtn: $('wooferPauseBtn'),
      wooferStopBtn: $('wooferStopBtn'),
      wooferSeekSlider: $('wooferSeekSlider'),
      wooferTransportTime: $('wooferTransportTime'),
      wooferApplyBtn: $('wooferApplyBtn'),
      wooferClearBtn: $('wooferClearBtn'),
      wooferCutoffSlider: $('wooferCutoffSlider'),
      wooferCutoffValue: $('wooferCutoffValue'),
      wooferGainSlider: $('wooferGainSlider'),
      wooferGainValue: $('wooferGainValue'),
      wooferAudioMeter: $('wooferAudioMeter'),
      wooferUsbMeter: $('wooferUsbMeter'),
      // Mode tabs
      modeRealtimeBtn: $('modeRealtimeBtn'),
      modePlaybackBtn: $('modePlaybackBtn'),
      modeRealtimeSection: $('modeRealtimeSection'),
      modePlaybackSection: $('modePlaybackSection'),
      mediaLibrary: $('mediaLibrary'),
      // Warning
      warningBanner: $('warningBanner'),
      dismissWarning: $('dismissWarning'),
    };
  }

  // ── Controls ──

  _bindControls() {
    // Mode tabs
    this._currentMode = 'realtime';
    this.els.modeRealtimeBtn?.addEventListener('click', () => this._switchMode('realtime'));
    this.els.modePlaybackBtn?.addEventListener('click', () => this._switchMode('playback'));
    this.els.modeWooferBtn?.addEventListener('click', () => this._switchMode('woofer'));

    // Warning dismiss
    this.els.dismissWarning?.addEventListener('click', () => {
      this.els.warningBanner.classList.add('warning-banner--hidden');
    });

    // Power
    this.els.powerBtn.addEventListener('click', () => this.togglePower());

    // Threshold
    this.els.thresholdSlider.addEventListener('input', (e) => {
      this.threshold = parseInt(e.target.value) / 100;
      this.els.thresholdValue.textContent = this.threshold.toFixed(2);
      this.els.prominenceThresholdLine.style.left = `${this.threshold * 100}%`;
    });
    this.els.prominenceThresholdLine.style.left = `${this.threshold * 100}%`;

    // Amplitude
    this.els.amplitudeSlider.addEventListener('input', (e) => {
      this.maxAmplitude = parseInt(e.target.value);
      this.els.amplitudeValue.textContent = `${this.maxAmplitude}%`;
      this.els.statusAmplitude.textContent = `${this.maxAmplitude}%`;
      this._sendEmsParams();
    });

    // Carrier frequency
    this.els.carrierFreqSlider.addEventListener('input', (e) => {
      this.carrierFreq = parseInt(e.target.value);
      this.els.carrierFreqValue.textContent = `${this.carrierFreq} Hz`;
      this.els.statusCarrier.textContent = `${this.carrierFreq} Hz`;
      this._sendEmsParams();
    });

    // Pulse duration
    this.els.pulseDurationSlider.addEventListener('input', (e) => {
      this.pulseDurationMs = parseInt(e.target.value);
      this.els.pulseDurationValue.textContent = `${this.pulseDurationMs} ms`;
    });

    // Waveform
    this.els.waveformSelect.addEventListener('change', (e) => {
      this.waveform = parseInt(e.target.value);
      this._sendEmsParams();
    });

    // Cooldown
    this.els.cooldownSlider.addEventListener('input', (e) => {
      this.cooldownMs = parseInt(e.target.value);
      this.els.cooldownValue.textContent = `${this.cooldownMs} ms`;
    });

    // Clear log
    this.els.clearLogBtn.addEventListener('click', () => {
      this.els.eventLog.innerHTML = '<div class="event-log__placeholder">Waiting for prominence events…</div>';
    });

    // VAD sensitivity
    this.els.vadSensitivitySlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.els.vadSensitivityValue.textContent = val.toFixed(1);
      if (this.prominenceDetector) this.prominenceDetector.vadRatio = val;
    });

    // Latency mode
    this.els.latencyModeSelect?.addEventListener('change', (e) => {
      this.latencyMode = e.target.value;
      const info = this.latencyMode === 'low' ? '~21ms (Causal)' : '~270ms (ACN Triplet)';
      this.els.latencyModeInfo.textContent = info;
    });

    // ── Playback mode ──
    this._bindPlaybackControls();
    this._bindWooferControls();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !['SELECT', 'INPUT', 'BUTTON'].includes(e.target.tagName)) {
        e.preventDefault();
        if (this._currentMode === 'realtime') {
          this.togglePower();
        } else if (this._currentMode === 'playback') {
          if (this._audioL && !this._audioL.paused) this._playbackPause();
          else this._playbackPlay();
        } else if (this._currentMode === 'woofer') {
          if (this._wooferAudio && !this._wooferAudio.paused) this._wooferPause();
          else this._wooferPlay();
        }
      }
      if (e.code === 'Escape') {
        if (this.isRunning) {
          this.maxAmplitude = 0;
          this.els.amplitudeSlider.value = 0;
          this.els.amplitudeValue.textContent = '0%';
          this.els.statusAmplitude.textContent = '0%';
          this._sendEmsParams();
          this.togglePower();
        }
      }
    });

    // Resize
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (this.isRunning) { this._stopVisualization(); this._startVisualization(); }
      }, 200);
    });
  }

  // ── Mode Switching ──

  _switchMode(mode) {
    this._currentMode = mode;
    this.els.modeRealtimeBtn?.classList.toggle('mode-tab--active', mode === 'realtime');
    this.els.modePlaybackBtn?.classList.toggle('mode-tab--active', mode === 'playback');
    this.els.modeWooferBtn?.classList.toggle('mode-tab--active', mode === 'woofer');
    this.els.modeRealtimeSection?.classList.toggle('mode-section--hidden', mode !== 'realtime');
    this.els.modePlaybackSection?.classList.toggle('mode-section--hidden', mode !== 'playback');
    this.els.modeWooferSection?.classList.toggle('mode-section--hidden', mode !== 'woofer');

    if (mode === 'playback') {
      if (this.isRunning) this.togglePower();
      this._wooferPause();
      this._stopWooferCapture();
    } else if (mode === 'woofer') {
      if (this.isRunning) this.togglePower();
      if (this._audioL && !this._audioL.paused) this._playbackPause();
    } else {
      if (this._audioL && !this._audioL.paused) this._playbackPause();
      this._wooferPause();
      this._stopWooferCapture();
    }
  }

  // ── Playback Mode ──

  _bindPlaybackControls() {
    const dz = this.els.dropZone;
    const fi = this.els.playbackFileInput;
    if (!dz || !fi) return;

    this._audioL = new Audio();
    this._audioR = new Audio();
    this._playbackDuration = 0;
    this._seekAnimFrame = null;
    this._playbackReady = false;

    this._refreshDevices();
    this._loadMediaLibrary();

    this.els.refreshDevicesBtn?.addEventListener('click', () => this._refreshDevices());

    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer.files[0]) this._loadPlaybackFile(e.dataTransfer.files[0]);
    });

    fi.addEventListener('change', (e) => {
      if (e.target.files[0]) this._loadPlaybackFile(e.target.files[0]);
    });

    this.els.playBtn?.addEventListener('click', () => this._playbackPlay());
    this.els.pauseBtn?.addEventListener('click', () => this._playbackPause());
    this.els.stopBtn?.addEventListener('click', () => this._playbackStop());

    this.els.seekSlider?.addEventListener('input', (e) => {
      const t = (parseFloat(e.target.value) / 100) * this._playbackDuration;
      this._audioL.currentTime = t;
      this._audioR.currentTime = t;
    });

    this.els.playbackClearBtn?.addEventListener('click', () => this._clearPlayback());
    this.els.audioPortSelect?.addEventListener('change', () => this._applyPorts());
    this.els.emsPortSelect?.addEventListener('change', () => this._applyPorts());
  }

  async _refreshDevices() {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      const fillSelect = (sel) => {
        const prev = sel.value;
        sel.innerHTML = '';
        outputs.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;
          sel.appendChild(opt);
        });
        if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
      };

      if (this.els.audioPortSelect) fillSelect(this.els.audioPortSelect);
      if (this.els.emsPortSelect) fillSelect(this.els.emsPortSelect);
      if (this.els.wooferAudioPortSelect) fillSelect(this.els.wooferAudioPortSelect);
      if (this.els.wooferUsbPortSelect) fillSelect(this.els.wooferUsbPortSelect);
    } catch (err) {
      console.warn('[Playback] Could not enumerate devices:', err);
    }
  }

  async _applyPorts() {
    const audioId = this.els.audioPortSelect?.value || 'default';
    const emsId = this.els.emsPortSelect?.value || 'default';
    try {
      if (this._audioL.setSinkId) await this._audioL.setSinkId(audioId);
      if (this._audioR.setSinkId) await this._audioR.setSinkId(emsId);
    } catch (err) {
      console.warn('[Playback] setSinkId failed:', err);
    }
  }

  async _loadMediaLibrary() {
    const lib = this.els.mediaLibrary;
    if (!lib) return;

    try {
      const res = await fetch('./media/manifest.json');
      if (!res.ok) { lib.innerHTML = '<div class="media-library__loading">No media found</div>'; return; }
      const manifest = await res.json();
      const files = manifest.files || [];
      if (!files.length) { lib.innerHTML = '<div class="media-library__loading">No files</div>'; return; }

      lib.innerHTML = '';
      files.forEach(f => {
        const track = document.createElement('div');
        track.className = 'media-track';
        track.dataset.filename = f.name;
        const dur = this._fmtTime(f.duration_s || 0);
        track.innerHTML = `
          <span class="media-track__icon">🎵</span>
          <div class="media-track__info">
            <div class="media-track__label">${f.label || f.name}</div>
            <div class="media-track__meta">${dur} ・ ${f.size_mb} MB</div>
          </div>
          <button class="media-track__play">▶</button>
        `;
        track.addEventListener('click', () => this._loadServerFile(f.name, f.label || f.name));
        lib.appendChild(track);
      });
    } catch (err) {
      lib.innerHTML = '<div class="media-library__loading">manifest.json not found</div>';
    }
  }

  async _loadServerFile(filename, label) {
    this._playbackStop();
    this.els.playbackFileName.textContent = label || filename;
    this.els.dropZone.style.display = 'none';
    this.els.playbackPlayer.style.display = 'block';
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = '⏳ Loading…';

    this.els.mediaLibrary?.querySelectorAll('.media-track').forEach(t => {
      t.classList.toggle('media-track--active', t.dataset.filename === filename);
    });

    try {
      const res = await fetch(`./media/${filename}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuf = await res.arrayBuffer();

      const offCtx = new OfflineAudioContext(2, 1, 48000);
      const audioBuffer = await offCtx.decodeAudioData(arrayBuf);

      if (audioBuffer.numberOfChannels < 2) {
        alert('ステレオWAVが必要です (L=Audio, R=EMS)');
        this._clearPlayback();
        return;
      }

      const sr = audioBuffer.sampleRate;
      this._playbackDuration = audioBuffer.duration;

      const blobL = this._createMonoWavBlob(audioBuffer.getChannelData(0), sr);
      const blobR = this._createMonoWavBlob(audioBuffer.getChannelData(1), sr);

      this._audioL = new Audio();
      this._audioR = new Audio();
      await this._applyPorts();

      const waitReady = (audio, url) => new Promise((resolve) => {
        audio.addEventListener('canplay', resolve, { once: true });
        audio.src = url;
        audio.load();
      });

      await Promise.all([
        waitReady(this._audioL, URL.createObjectURL(blobL)),
        waitReady(this._audioR, URL.createObjectURL(blobR)),
      ]);

      this._audioL.currentTime = 0;
      this._audioR.currentTime = 0;
      if (this.els.seekSlider) this.els.seekSlider.value = 0;
      if (this.els.transportTime) {
        this.els.transportTime.textContent = `0:00 / ${this._fmtTime(this._playbackDuration)}`;
      }

      this._playbackReady = true;
      this._playbackPlay();
    } catch (err) {
      console.error('[Playback] Load error:', err);
      this._playbackReady = false;
      if (this.els.statusPlayback) this.els.statusPlayback.textContent = '❌ Load failed';
    }
  }

  async _loadPlaybackFile(file) {
    if (!file.name.toLowerCase().endsWith('.wav')) {
      alert('WAVファイルを選択してください');
      return;
    }

    this.els.playbackFileName.textContent = file.name;
    this.els.dropZone.style.display = 'none';
    this.els.playbackPlayer.style.display = 'block';
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = '⏳ Decoding…';

    try {
      const arrayBuf = await file.arrayBuffer();
      const offCtx = new OfflineAudioContext(2, 1, 48000);
      const audioBuffer = await offCtx.decodeAudioData(arrayBuf);

      if (audioBuffer.numberOfChannels < 2) {
        alert('ステレオWAVを選択してください (L=Audio, R=EMS)');
        this._clearPlayback();
        return;
      }

      const sr = audioBuffer.sampleRate;
      this._playbackDuration = audioBuffer.duration;

      const blobL = this._createMonoWavBlob(audioBuffer.getChannelData(0), sr);
      const blobR = this._createMonoWavBlob(audioBuffer.getChannelData(1), sr);

      this._audioL.src = URL.createObjectURL(blobL);
      this._audioR.src = URL.createObjectURL(blobR);
      await this._applyPorts();

      this._playbackReady = true;

      if (this.els.statusPlayback) this.els.statusPlayback.textContent = '⏹ Ready';
      if (this.els.transportTime) {
        this.els.transportTime.textContent = `0:00 / ${this._fmtTime(this._playbackDuration)}`;
      }
    } catch (err) {
      console.error('[Playback] Decode error:', err);
      alert('WAVファイルのデコードに失敗しました');
      this._clearPlayback();
    }
  }

  _createWavBlob(channels, sr) {
    const safeChannels = channels.filter(Boolean);
    const channelCount = Math.max(1, safeChannels.length);
    const n = safeChannels[0].length;
    const bytesPerSample = 2;
    const blockAlign = channelCount * bytesPerSample;
    const buffer = new ArrayBuffer(44 + n * blockAlign);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + n * blockAlign, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, n * blockAlign, true);
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < channelCount; ch++) {
        const s = Math.max(-1, Math.min(1, safeChannels[ch][i] || 0));
        view.setInt16(44 + (i * channelCount + ch) * 2, s * 32767, true);
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  _createMonoWavBlob(channelData, sr) {
    return this._createWavBlob([channelData], sr);
  }

  _playbackPlay() {
    if (!this._playbackReady || !this._audioL.src) return;
    if (this._audioL.duration && this._audioL.currentTime >= this._audioL.duration - 0.1) {
      this._audioL.currentTime = 0;
      this._audioR.currentTime = 0;
    }
    this._audioL.play().catch(() => {});
    this._audioR.play().catch(() => {});
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = '▶ Playing';
    this._startSeekUpdate();
  }

  _playbackPause() {
    if (!this._playbackReady) return;
    this._audioL.pause();
    this._audioR.pause();
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = '⏸ Paused';
    this._stopSeekUpdate();
  }

  _playbackStop() {
    if (!this._playbackReady) return;
    this._audioL.pause();
    this._audioR.pause();
    this._audioL.currentTime = 0;
    this._audioR.currentTime = 0;
    if (this.els.seekSlider) this.els.seekSlider.value = 0;
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = '⏹ Stopped';
    if (this.els.transportTime) this.els.transportTime.textContent = `0:00 / ${this._fmtTime(this._playbackDuration)}`;
    this._stopSeekUpdate();
  }

  _startSeekUpdate() {
    const update = () => {
      const t = this._audioL.currentTime || 0;
      const d = this._playbackDuration || 1;
      if (this.els.seekSlider) this.els.seekSlider.value = (t / d * 100).toFixed(1);
      if (this.els.transportTime) this.els.transportTime.textContent = `${this._fmtTime(t)} / ${this._fmtTime(d)}`;
      if (Math.abs(this._audioR.currentTime - t) > 0.1) this._audioR.currentTime = t;
      if (!this._audioL.paused) this._seekAnimFrame = requestAnimationFrame(update);
    };
    this._seekAnimFrame = requestAnimationFrame(update);
  }

  _stopSeekUpdate() {
    if (this._seekAnimFrame) cancelAnimationFrame(this._seekAnimFrame);
  }

  _fmtTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  _clearPlayback() {
    this._playbackStop();
    this._audioL.src = '';
    this._audioR.src = '';
    this._playbackDuration = 0;
    this.els.playbackFileName.textContent = '--';
    this.els.dropZone.style.display = '';
    this.els.playbackPlayer.style.display = 'none';
    this.els.playbackFileInput.value = '';
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = '--';
  }

  // Ab Woofer Mode

  _bindWooferControls() {
    const dz = this.els.wooferDropZone;
    const fi = this.els.wooferFileInput;
    if (!dz || !fi) return;

    this._wooferAudio = new Audio();
    this._wooferUsb = new Audio();
    this._wooferDuration = 0;
    this._wooferReady = false;

    this.els.refreshWooferDevicesBtn?.addEventListener('click', () => this._refreshDevices());

    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer.files[0]) this._loadWooferFile(e.dataTransfer.files[0]);
    });

    fi.addEventListener('change', (e) => {
      if (e.target.files[0]) this._loadWooferFile(e.target.files[0]);
    });

    this.els.wooferPlayBtn?.addEventListener('click', () => this._wooferPlay());
    this.els.wooferPauseBtn?.addEventListener('click', () => this._wooferPause());
    this.els.wooferStopBtn?.addEventListener('click', () => this._wooferStop());
    this.els.wooferClearBtn?.addEventListener('click', () => this._clearWoofer());
    this.els.wooferApplyBtn?.addEventListener('click', () => this._buildWooferSplit(false));
    this.els.wooferCaptureBtn?.addEventListener('click', () => this._startWooferCapture());
    this.els.wooferStopCaptureBtn?.addEventListener('click', () => this._stopWooferCapture());
    this.els.wooferAudioPortSelect?.addEventListener('change', () => this._applyWooferPorts());
    this.els.wooferUsbPortSelect?.addEventListener('change', () => this._applyWooferPorts());

    this.els.wooferSeekSlider?.addEventListener('input', (e) => {
      const t = (parseFloat(e.target.value) / 100) * this._wooferDuration;
      this._wooferAudio.currentTime = t;
      this._wooferUsb.currentTime = t;
    });

    this.els.wooferCutoffSlider?.addEventListener('input', (e) => {
      this.wooferCutoffHz = parseInt(e.target.value);
      this.els.wooferCutoffValue.textContent = `${this.wooferCutoffHz} Hz`;
      this._setLiveWooferParams();
      if (this._wooferReady && this.els.statusPlayback) this.els.statusPlayback.textContent = 'Split changed';
    });

    this.els.wooferGainSlider?.addEventListener('input', (e) => {
      this.wooferGain = parseInt(e.target.value);
      this.els.wooferGainValue.textContent = `${this.wooferGain}%`;
      this._setLiveWooferParams();
      if (this.els.statusPlayback) {
        if (this.wooferGain <= 0) {
          this.els.statusPlayback.textContent = 'USB bass muted';
        } else if (this._wooferReady) {
          this.els.statusPlayback.textContent = 'Split changed';
        } else if (this.wooferLiveStream) {
          this.els.statusPlayback.textContent = 'Live woofer active';
        }
      }
    });
  }

  async _applyWooferPorts() {
    const audioId = this.els.wooferAudioPortSelect?.value || 'default';
    const usbId = this.els.wooferUsbPortSelect?.value || 'default';
    try {
      if (this._wooferAudio?.setSinkId) await this._wooferAudio.setSinkId(audioId);
      if (this._wooferUsb?.setSinkId) await this._wooferUsb.setSinkId(usbId);
      if (this._wooferLiveAudio?.setSinkId) await this._wooferLiveAudio.setSinkId(audioId);
      if (this._wooferLiveUsb?.setSinkId) await this._wooferLiveUsb.setSinkId(usbId);
    } catch (err) {
      console.warn('[Woofer] setSinkId failed:', err);
    }
  }

  async _startWooferCapture() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      alert('Live capture is not supported in this browser.');
      return;
    }

    this._wooferPause();
    await this._stopWooferCapture();
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = 'Choose a live tab...';
    if (this.els.wooferLiveState) this.els.wooferLiveState.textContent = 'Waiting';

    try {
      const stream = await this._requestWooferDisplayStream();

      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach(t => t.stop());
        alert('No tab audio was shared. Choose a browser tab and enable audio sharing.');
        if (this.els.statusPlayback) this.els.statusPlayback.textContent = 'No live audio';
        if (this.els.wooferLiveState) this.els.wooferLiveState.textContent = 'No audio';
        return;
      }

      this.wooferLiveStream = stream;
      this.wooferLiveCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      if (this.wooferLiveCtx.state === 'suspended') await this.wooferLiveCtx.resume();

      const source = this.wooferLiveCtx.createMediaStreamSource(stream);
      const highFilter = this.wooferLiveCtx.createBiquadFilter();
      const lowFilter = this.wooferLiveCtx.createBiquadFilter();
      const lowGain = this.wooferLiveCtx.createGain();
      const audioDest = this.wooferLiveCtx.createMediaStreamDestination();
      const usbDest = this.wooferLiveCtx.createMediaStreamDestination();

      highFilter.type = 'highpass';
      lowFilter.type = 'lowpass';
      highFilter.Q.value = 0.707;
      lowFilter.Q.value = 0.707;
      this.wooferLiveNodes = { highFilter, lowFilter, lowGain };
      this._setLiveWooferParams();

      source.connect(highFilter).connect(audioDest);
      source.connect(lowFilter).connect(lowGain).connect(usbDest);

      this._wooferLiveAudio = new Audio();
      this._wooferLiveUsb = new Audio();
      this._wooferLiveAudio.srcObject = audioDest.stream;
      this._wooferLiveUsb.srcObject = usbDest.stream;
      this._wooferLiveAudio.autoplay = true;
      this._wooferLiveUsb.autoplay = true;
      this._wooferLiveAudio.muted = false;
      this._wooferLiveUsb.muted = false;
      this._wooferLiveAudio.volume = 1;
      this._wooferLiveUsb.volume = 1;
      await this._applyWooferPorts();

      if (this.els.wooferLivePreview) {
        this.els.wooferLivePreview.srcObject = stream;
        this.els.wooferLivePreview.classList.add('active');
      }

      stream.getTracks().forEach(track => {
        track.addEventListener('ended', () => this._stopWooferCapture(), { once: true });
      });

      await Promise.all([
        this._wooferLiveAudio.play(),
        this._wooferLiveUsb.play(),
      ]);

      if (this.els.statusPlayback) {
        this.els.statusPlayback.textContent = this.wooferGain > 0 ? 'Live woofer active' : 'USB bass muted';
      }
      if (this.els.wooferLiveState) this.els.wooferLiveState.textContent = 'Live / mute source tab if doubled';
    } catch (err) {
      console.warn('[Woofer] Live capture failed:', err);
      await this._stopWooferCapture();
      if (err.name !== 'NotAllowedError') alert('Live capture failed.');
      if (this.els.statusPlayback) this.els.statusPlayback.textContent = 'Live capture stopped';
    }
  }

  async _requestWooferDisplayStream() {
    const baseAudio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          ...baseAudio,
          suppressLocalAudioPlayback: true,
        },
      });
    } catch (err) {
      if (err.name === 'TypeError' || err.name === 'OverconstrainedError') {
        return navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: baseAudio,
        });
      }
      throw err;
    }
  }

  _setLiveWooferParams() {
    if (!this.wooferLiveNodes || !this.wooferLiveCtx) return;
    const now = this.wooferLiveCtx.currentTime;
    this.wooferLiveNodes.highFilter.frequency.setTargetAtTime(this.wooferCutoffHz, now, 0.015);
    this.wooferLiveNodes.lowFilter.frequency.setTargetAtTime(this.wooferCutoffHz, now, 0.015);
    this.wooferLiveNodes.lowGain.gain.setTargetAtTime(this.wooferGain / 100, now, 0.015);
  }

  async _stopWooferCapture() {
    if (this._wooferLiveAudio) {
      this._wooferLiveAudio.pause();
      this._wooferLiveAudio.srcObject = null;
    }
    if (this._wooferLiveUsb) {
      this._wooferLiveUsb.pause();
      this._wooferLiveUsb.srcObject = null;
    }
    this._wooferLiveAudio = null;
    this._wooferLiveUsb = null;

    if (this.wooferLiveStream) {
      this.wooferLiveStream.getTracks().forEach(t => t.stop());
      this.wooferLiveStream = null;
    }
    if (this.wooferLiveCtx) {
      await this.wooferLiveCtx.close().catch(() => {});
      this.wooferLiveCtx = null;
    }
    this.wooferLiveNodes = null;

    if (this.els.wooferLivePreview) {
      this.els.wooferLivePreview.pause();
      this.els.wooferLivePreview.srcObject = null;
      this.els.wooferLivePreview.classList.remove('active');
    }
    if (this.els.wooferLiveState) this.els.wooferLiveState.textContent = 'Idle';
  }

  async _loadWooferFile(file) {
    if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.name)) {
      alert('Choose an audio file.');
      return;
    }

    this._wooferStop();
    this.els.wooferFileName.textContent = file.name;
    this.els.wooferDropZone.style.display = 'none';
    this.els.wooferPlayer.style.display = 'block';
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = 'Decoding...';

    try {
      const arrayBuf = await file.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.wooferSourceBuffer = await ctx.decodeAudioData(arrayBuf);
      await ctx.close();
      this._wooferDuration = this.wooferSourceBuffer.duration;
      await this._buildWooferSplit(false);
    } catch (err) {
      console.error('[Woofer] Decode error:', err);
      alert('Audio decode failed.');
      this._clearWoofer();
    }
  }

  async _buildWooferSplit(autoPlay) {
    if (!this.wooferSourceBuffer) return;
    this._wooferStop();
    this._wooferReady = false;
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = 'Splitting...';

    try {
      const cutoff = this.wooferCutoffHz;
      const gain = this.wooferGain / 100;
      this.wooferAudioBandBuffer = await this._renderWooferBand('highpass', cutoff, 1.0);
      this.wooferUsbBandBuffer = await this._renderWooferBand('lowpass', cutoff, gain);

      const sr = this.wooferSourceBuffer.sampleRate;
      const audioChannels = [];
      const audioChannelCount = Math.min(2, this.wooferAudioBandBuffer.numberOfChannels);
      for (let ch = 0; ch < audioChannelCount; ch++) {
        audioChannels.push(this.wooferAudioBandBuffer.getChannelData(ch));
      }

      this._revokeWooferUrls();
      this.wooferAudioUrl = URL.createObjectURL(this._createWavBlob(audioChannels, sr));
      this.wooferUsbUrl = URL.createObjectURL(this._createMonoWavBlob(this.wooferUsbBandBuffer.getChannelData(0), sr));

      this._wooferAudio = new Audio();
      this._wooferUsb = new Audio();
      this._wooferAudio.muted = false;
      this._wooferUsb.muted = false;
      this._wooferAudio.volume = 1;
      this._wooferUsb.volume = 1;
      await this._applyWooferPorts();

      await Promise.all([
        this._waitAudioReady(this._wooferAudio, this.wooferAudioUrl),
        this._waitAudioReady(this._wooferUsb, this.wooferUsbUrl),
      ]);

      this._wooferAudio.currentTime = 0;
      this._wooferUsb.currentTime = 0;
      if (this.els.wooferSeekSlider) this.els.wooferSeekSlider.value = 0;
      if (this.els.wooferTransportTime) {
        this.els.wooferTransportTime.textContent = `0:00 / ${this._fmtTime(this._wooferDuration)}`;
      }

      this._wooferReady = true;
      if (this.els.statusPlayback) {
        this.els.statusPlayback.textContent = this.wooferGain > 0 ? 'Woofer ready' : 'USB bass muted';
      }
      if (autoPlay) this._wooferPlay();
    } catch (err) {
      console.error('[Woofer] Split error:', err);
      this._wooferReady = false;
      if (this.els.statusPlayback) this.els.statusPlayback.textContent = 'Split failed';
    }
  }

  async _renderWooferBand(type, cutoff, gainValue) {
    const source = this.wooferSourceBuffer;
    const sr = source.sampleRate;
    const frameCount = source.length;
    const isLow = type === 'lowpass';
    const outChannels = isLow ? 1 : Math.min(2, source.numberOfChannels);
    const offCtx = new OfflineAudioContext(outChannels, frameCount, sr);
    const src = offCtx.createBufferSource();

    if (isLow) {
      const mono = offCtx.createBuffer(1, frameCount, sr);
      const monoData = mono.getChannelData(0);
      for (let ch = 0; ch < source.numberOfChannels; ch++) {
        const data = source.getChannelData(ch);
        for (let i = 0; i < frameCount; i++) monoData[i] += data[i] / source.numberOfChannels;
      }
      src.buffer = mono;
    } else {
      src.buffer = source;
    }

    const filter = offCtx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = cutoff;
    filter.Q.value = 0.707;

    const gain = offCtx.createGain();
    gain.gain.value = gainValue;

    src.connect(filter).connect(gain).connect(offCtx.destination);
    src.start(0);
    return offCtx.startRendering();
  }

  _waitAudioReady(audio, url) {
    return new Promise((resolve, reject) => {
      audio.addEventListener('canplay', resolve, { once: true });
      audio.addEventListener('error', reject, { once: true });
      audio.src = url;
      audio.load();
    });
  }

  _wooferPlay() {
    if (!this._wooferReady || !this._wooferAudio.src) return;
    if (this._wooferAudio.duration && this._wooferAudio.currentTime >= this._wooferAudio.duration - 0.1) {
      this._wooferAudio.currentTime = 0;
      this._wooferUsb.currentTime = 0;
    }
    this._wooferAudio.play().catch(() => {});
    this._wooferUsb.play().catch((err) => console.warn('[Woofer] USB playback failed:', err));
    if (this.els.statusPlayback) {
      this.els.statusPlayback.textContent = this.wooferGain > 0 ? 'Woofer playing' : 'USB bass muted';
    }
    this._startWooferSeekUpdate();
    this._startWooferMeter();
  }

  _wooferPause() {
    if (!this._wooferReady) return;
    this._wooferAudio.pause();
    this._wooferUsb.pause();
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = 'Woofer paused';
    this._stopWooferSeekUpdate();
    this._stopWooferMeter();
  }

  _wooferStop() {
    if (!this._wooferAudio || !this._wooferUsb) return;
    this._wooferAudio.pause();
    this._wooferUsb.pause();
    this._wooferAudio.currentTime = 0;
    this._wooferUsb.currentTime = 0;
    if (this.els.wooferSeekSlider) this.els.wooferSeekSlider.value = 0;
    if (this.els.wooferTransportTime) this.els.wooferTransportTime.textContent = `0:00 / ${this._fmtTime(this._wooferDuration || 0)}`;
    if (this.els.statusPlayback && this._wooferReady) this.els.statusPlayback.textContent = 'Woofer stopped';
    this._stopWooferSeekUpdate();
    this._stopWooferMeter();
    this._setWooferMeter(0, 0);
  }

  _startWooferSeekUpdate() {
    this._stopWooferSeekUpdate();
    const update = () => {
      const t = this._wooferAudio.currentTime || 0;
      const d = this._wooferDuration || 1;
      if (this.els.wooferSeekSlider) this.els.wooferSeekSlider.value = (t / d * 100).toFixed(1);
      if (this.els.wooferTransportTime) this.els.wooferTransportTime.textContent = `${this._fmtTime(t)} / ${this._fmtTime(d)}`;
      if (Math.abs(this._wooferUsb.currentTime - t) > 0.1) this._wooferUsb.currentTime = t;
      if (!this._wooferAudio.paused) this._wooferSeekFrame = requestAnimationFrame(update);
    };
    this._wooferSeekFrame = requestAnimationFrame(update);
  }

  _stopWooferSeekUpdate() {
    if (this._wooferSeekFrame) cancelAnimationFrame(this._wooferSeekFrame);
    this._wooferSeekFrame = null;
  }

  _startWooferMeter() {
    this._stopWooferMeter();
    const update = () => {
      const t = this._wooferAudio.currentTime || 0;
      this._setWooferMeter(
        this._bufferRmsAt(this.wooferAudioBandBuffer, t),
        this._bufferRmsAt(this.wooferUsbBandBuffer, t)
      );
      if (!this._wooferAudio.paused) this.wooferMeterFrame = requestAnimationFrame(update);
    };
    this.wooferMeterFrame = requestAnimationFrame(update);
  }

  _stopWooferMeter() {
    if (this.wooferMeterFrame) cancelAnimationFrame(this.wooferMeterFrame);
    this.wooferMeterFrame = null;
  }

  _bufferRmsAt(buffer, timeSec) {
    if (!buffer) return 0;
    const start = Math.max(0, Math.floor(timeSec * buffer.sampleRate));
    const count = Math.min(2048, buffer.length - start);
    if (count <= 0) return 0;
    let sum = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < count; i++) sum += data[start + i] * data[start + i];
    }
    return Math.sqrt(sum / (count * buffer.numberOfChannels));
  }

  _setWooferMeter(audioRms, usbRms) {
    if (this.els.wooferAudioMeter) this.els.wooferAudioMeter.style.width = `${Math.min(100, audioRms * 450)}%`;
    if (this.els.wooferUsbMeter) this.els.wooferUsbMeter.style.width = `${Math.min(100, usbRms * 650)}%`;
  }

  _revokeWooferUrls() {
    if (this.wooferAudioUrl) URL.revokeObjectURL(this.wooferAudioUrl);
    if (this.wooferUsbUrl) URL.revokeObjectURL(this.wooferUsbUrl);
    this.wooferAudioUrl = null;
    this.wooferUsbUrl = null;
  }

  _clearWoofer() {
    this._wooferStop();
    this._stopWooferCapture();
    this._revokeWooferUrls();
    this.wooferSourceBuffer = null;
    this.wooferAudioBandBuffer = null;
    this.wooferUsbBandBuffer = null;
    this._wooferReady = false;
    this._wooferDuration = 0;
    this._wooferAudio = new Audio();
    this._wooferUsb = new Audio();
    if (this.els.wooferFileName) this.els.wooferFileName.textContent = '--';
    if (this.els.wooferDropZone) this.els.wooferDropZone.style.display = '';
    if (this.els.wooferPlayer) this.els.wooferPlayer.style.display = 'none';
    if (this.els.wooferFileInput) this.els.wooferFileInput.value = '';
    if (this.els.statusPlayback) this.els.statusPlayback.textContent = '--';
  }
}

// ── Initialize on DOM ready ──
document.addEventListener('DOMContentLoaded', () => {
  window.vrApp = new EMSProminenceApp();
  window.vrApp.init();
});
