/**
 * ACN Wasm runtime wrapper.
 * If wasm module is unavailable, caller should fall back to ACNRuntime (JS).
 */
class ACNWasmRuntime {
    constructor(options = {}) {
        this.model = null;
        this.module = null;
        this.normalizationMode = options.normalizationMode || 'session';
        this.minStd = Number.isFinite(options.minStd) ? options.minStd : 1e-3;
        this.moduleScriptUrl = options.moduleScriptUrl || 'wasm/acn.js';
        this.wasmBinaryUrl = options.wasmBinaryUrl || 'wasm/acn.wasm';
        this.moduleFactoryName = options.moduleFactoryName || 'ACNModule';
        this.modulePromise = null;

        this._acn_init = null;
        this._acn_set_weights = null;
        this._acn_score_triplet = null;
        this._acn_reset = null;
        this._acn_expected_weights = null;

        this.ptrPrev = 0;
        this.ptrCurr = 0;
        this.ptrNext = 0;
        this.ptrOut = 0;
        this.ready = false;
        this.resetSessionStats();
    }

    async loadModel(modelBlob) {
        if (!modelBlob || !modelBlob.weights || !modelBlob.architecture) {
            return false;
        }
        this.model = modelBlob;

        const module = await this._ensureModuleLoaded();
        if (!module) return false;
        this.module = module;
        this._bindExports();

        const arch = modelBlob.architecture || {};
        const nCues = Number(arch.nCues || 3);
        const nText = Number(arch.nText || 0);
        const hContrast = Number(arch.hContrast || 8);
        const hAgg = Number(arch.hAgg || 8);

        const initOk = !!this._acn_init(nCues, nText, hContrast, hAgg);
        if (!initOk) return false;

        const flat = this._flattenWeights(modelBlob);
        const expected = Number(this._acn_expected_weights());
        if (!Number.isFinite(expected) || expected !== flat.length) {
            return false;
        }

        const ptrWeights = this.module._malloc(flat.length * 4);
        this.module.HEAPF32.set(flat, ptrWeights >> 2);
        const setOk = !!this._acn_set_weights(ptrWeights, flat.length);
        this.module._free(ptrWeights);
        if (!setOk) return false;

        this._ensureScratchBuffers();
        this.resetSessionStats();
        this.ready = true;
        return true;
    }

    isReady() {
        return !!this.ready;
    }

    getModelVersion() {
        return this.model ? this.model.modelVersion : 'none';
    }

    getBackendName() {
        return 'wasm';
    }

    resetSessionStats() {
        this.runningCount = 0;
        this.runningMean = [0, 0, 0];
        this.runningM2 = [0, 0, 0];
    }

    scoreTriplet({ prevCues, currCues, nextCues, hasPrev, hasNext }) {
        if (!this.ready || !this.module) return NaN;
        if (!Array.isArray(currCues) || currCues.length < 3) return NaN;

        const prevOk = !!hasPrev && Array.isArray(prevCues) && prevCues.length >= 3;
        const nextOk = !!hasNext && Array.isArray(nextCues) && nextCues.length >= 3;
        if (!nextOk) return NaN;

        this._updateSessionStats(currCues);
        if (prevOk) this._updateSessionStats(prevCues);
        if (nextOk) this._updateSessionStats(nextCues);

        const prev = prevOk ? this._normalizeCues(prevCues) : [0, 0, 0];
        const curr = this._normalizeCues(currCues);
        const next = nextOk ? this._normalizeCues(nextCues) : [0, 0, 0];

        this.module.HEAPF32.set(prev, this.ptrPrev >> 2);
        this.module.HEAPF32.set(curr, this.ptrCurr >> 2);
        this.module.HEAPF32.set(next, this.ptrNext >> 2);

        const ok = this._acn_score_triplet(
            this.ptrPrev,
            this.ptrCurr,
            this.ptrNext,
            prevOk ? 1 : 0,
            nextOk ? 1 : 0,
            this.ptrOut
        );
        if (!ok) return NaN;

        const score = this.module.getValue(this.ptrOut, 'float');
        if (!Number.isFinite(score)) return NaN;
        return Math.max(0, Math.min(1, score));
    }

    destroy() {
        if (this._acn_reset) {
            this._acn_reset();
        }
        if (this.module) {
            if (this.ptrPrev) this.module._free(this.ptrPrev);
            if (this.ptrCurr) this.module._free(this.ptrCurr);
            if (this.ptrNext) this.module._free(this.ptrNext);
            if (this.ptrOut) this.module._free(this.ptrOut);
        }
        this.ptrPrev = 0;
        this.ptrCurr = 0;
        this.ptrNext = 0;
        this.ptrOut = 0;
        this.ready = false;
    }

    _ensureScratchBuffers() {
        if (!this.module) return;
        if (!this.ptrPrev) this.ptrPrev = this.module._malloc(3 * 4);
        if (!this.ptrCurr) this.ptrCurr = this.module._malloc(3 * 4);
        if (!this.ptrNext) this.ptrNext = this.module._malloc(3 * 4);
        if (!this.ptrOut) this.ptrOut = this.module._malloc(4);
    }

    _bindExports() {
        if (!this.module) return;
        this._acn_init = this.module.cwrap('acn_init', 'number', ['number', 'number', 'number', 'number']);
        this._acn_set_weights = this.module.cwrap('acn_set_weights', 'number', ['number', 'number']);
        this._acn_score_triplet = this.module.cwrap(
            'acn_score_triplet',
            'number',
            ['number', 'number', 'number', 'number', 'number', 'number']
        );
        this._acn_reset = this.module.cwrap('acn_reset', 'number', []);
        this._acn_expected_weights = this.module.cwrap('acn_expected_weights', 'number', []);
    }

    async _ensureModuleLoaded() {
        if (this.modulePromise) return this.modulePromise;

        this.modulePromise = (async () => {
            const hasFactory = typeof window !== 'undefined' && typeof window[this.moduleFactoryName] === 'function';
            if (!hasFactory) {
                const exists = await this._probeScript(this.moduleScriptUrl);
                if (!exists) return null;
                const loaded = await this._loadScript(this.moduleScriptUrl);
                if (!loaded) return null;
            }

            if (typeof window === 'undefined') return null;
            const factory = window[this.moduleFactoryName];
            if (typeof factory !== 'function') return null;
            return factory({
                locateFile: (path) => (path.endsWith('.wasm') ? this.wasmBinaryUrl : path)
            });
        })();

        return this.modulePromise;
    }

    async _probeScript(url) {
        if (typeof fetch === 'undefined') return true;
        try {
            const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
            return !!res.ok;
        } catch (_error) {
            return false;
        }
    }

    _loadScript(url) {
        if (typeof document === 'undefined') return Promise.resolve(false);
        return new Promise((resolve) => {
            const existing = document.querySelector(`script[data-acn-wasm-loader="${url}"]`);
            if (existing) {
                existing.addEventListener('load', () => resolve(true), { once: true });
                existing.addEventListener('error', () => resolve(false), { once: true });
                return;
            }

            const script = document.createElement('script');
            script.src = url;
            script.async = true;
            script.dataset.acnWasmLoader = url;
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
    }

    _flattenWeights(modelBlob) {
        const w = modelBlob.weights;
        const arch = modelBlob.architecture || {};
        const nCues = Number(arch.nCues || 3);
        const hContrast = Number(arch.hContrast || 8);
        const hAgg = Number(arch.hAgg || 8);
        const nText = Number(arch.nText || 0);
        const ai = (nCues * 2) + nText;

        const out = [];
        for (let c = 0; c < nCues; c++) {
            for (let r = 0; r < 2; r++) {
                for (let j = 0; j < hContrast; j++) out.push(Number(w.cW1[c][r][j]) || 0);
            }
            for (let j = 0; j < hContrast; j++) out.push(Number(w.cb1[c][j]) || 0);
            for (let j = 0; j < hContrast; j++) out.push(Number(w.cW2[c][j][0]) || 0);
            out.push(Number(w.cb2[c][0]) || 0);
            out.push(Number(w.attn[c][0]) || 0);
            out.push(Number(w.attn[c][1]) || 0);
        }

        for (let i = 0; i < ai; i++) {
            for (let j = 0; j < hAgg; j++) out.push(Number(w.aW1[i][j]) || 0);
        }
        for (let j = 0; j < hAgg; j++) out.push(Number(w.ab1[j]) || 0);
        for (let j = 0; j < hAgg; j++) out.push(Number(w.aW2[j][0]) || 0);
        out.push(Number(w.ab2[0]) || 0);
        return new Float32Array(out);
    }

    _normalizeCues(cues) {
        if (this.normalizationMode === 'model') {
            return this._normalizeWithModelScaler(cues);
        }
        return this._normalizeWithSessionScaler(cues);
    }

    _normalizeWithModelScaler(cues) {
        const mean = (this.model && this.model.scaler && this.model.scaler.mean) ? this.model.scaler.mean : [0, 0, 0];
        const scale = (this.model && this.model.scaler && this.model.scaler.scale) ? this.model.scaler.scale : [1, 1, 1];
        return [0, 1, 2].map((i) => {
            const s = Math.max(this.minStd, Number(scale[i]) || 1);
            return (Number(cues[i]) - (Number(mean[i]) || 0)) / s;
        });
    }

    _normalizeWithSessionScaler(cues) {
        const out = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const variance = this.runningCount > 1 ? (this.runningM2[i] / (this.runningCount - 1)) : 1;
            const std = Math.sqrt(Math.max(variance, this.minStd * this.minStd));
            out[i] = (Number(cues[i]) - this.runningMean[i]) / std;
        }
        return out;
    }

    _updateSessionStats(cues) {
        this.runningCount += 1;
        for (let i = 0; i < 3; i++) {
            const x = Number(cues[i]) || 0;
            const delta = x - this.runningMean[i];
            this.runningMean[i] += delta / this.runningCount;
            const delta2 = x - this.runningMean[i];
            this.runningM2[i] += delta * delta2;
        }
    }
}

if (typeof window !== 'undefined') {
    window.ACNWasmRuntime = ACNWasmRuntime;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ACNWasmRuntime;
}
