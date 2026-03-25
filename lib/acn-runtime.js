/**
 * ACN runtime (JS) for 3-cue acoustic model.
 * Accepts weights exported as `window.ACN_MODEL_WEIGHTS`.
 */
class ACNRuntime {
    constructor(options = {}) {
        this.model = null;
        this.normalizationMode = options.normalizationMode || 'session';
        this.minStd = Number.isFinite(options.minStd) ? options.minStd : 1e-3;
        this.resetSessionStats();
    }

    loadModel(modelBlob) {
        if (!modelBlob || !modelBlob.weights || !modelBlob.architecture) {
            return false;
        }

        const w = modelBlob.weights;
        if (!Array.isArray(w.cW1) || !Array.isArray(w.cW2) || !Array.isArray(w.aW1) || !Array.isArray(w.aW2)) {
            return false;
        }

        this.model = modelBlob;
        this.resetSessionStats();
        return true;
    }

    isReady() {
        return !!this.model;
    }

    getModelVersion() {
        return this.model ? this.model.modelVersion : 'none';
    }

    resetSessionStats() {
        this.runningCount = 0;
        this.runningMean = [0, 0, 0];
        this.runningM2 = [0, 0, 0];
    }

    scoreTriplet({ prevCues, currCues, nextCues, hasPrev, hasNext }) {
        if (!this.model) return NaN;
        if (!Array.isArray(currCues) || currCues.length < 3) return NaN;

        const prevOk = !!hasPrev && Array.isArray(prevCues) && prevCues.length >= 3;
        const nextOk = !!hasNext && Array.isArray(nextCues) && nextCues.length >= 3;
        if (!nextOk) return NaN; // one-word delay policy requires next context.

        this._updateSessionStats(currCues);
        if (prevOk) this._updateSessionStats(prevCues);
        if (nextOk) this._updateSessionStats(nextCues);

        const curr = this._normalizeCues(currCues);
        const prev = prevOk ? this._normalizeCues(prevCues) : [0, 0, 0];
        const next = nextOk ? this._normalizeCues(nextCues) : [0, 0, 0];

        const w = this.model.weights;
        const nCues = this.model.architecture.nCues || 3;
        const att = new Array(nCues).fill(0);

        for (let c = 0; c < nCues; c++) {
            const alpha = this._softmaxPair(w.attn[c]);
            const oPrev = this._contrastMLP(c, curr[c], prev[c], w);
            const oNext = this._contrastMLP(c, curr[c], next[c], w);
            att[c] = alpha[0] * oPrev * (prevOk ? 1 : 0) + alpha[1] * oNext;
        }

        const ai = att.concat(curr.slice(0, nCues));
        const ah = this._reluVec(this._affine(ai, w.aW1, w.ab1));
        const raw = this._dotWithColumn(ah, w.aW2) + this._scalarFromArray(w.ab2);
        const score = this._sigmoid(raw);

        if (!Number.isFinite(score)) return NaN;
        return Math.max(0, Math.min(1, score));
    }

    _contrastMLP(cueIndex, targetCue, neighborCue, weights) {
        const W1 = weights.cW1[cueIndex];
        const b1 = weights.cb1[cueIndex];
        const W2 = weights.cW2[cueIndex];
        const b2 = this._scalarFromArray(weights.cb2[cueIndex]);

        const hidden = new Array(b1.length);
        for (let j = 0; j < b1.length; j++) {
            const h = targetCue * W1[0][j] + neighborCue * W1[1][j] + b1[j];
            hidden[j] = h > 0 ? h : 0;
        }

        let out = b2;
        for (let j = 0; j < hidden.length; j++) {
            out += hidden[j] * this._scalarFromArray(W2[j]);
        }
        return out;
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

    _affine(vec, mat, bias) {
        const out = new Array(bias.length).fill(0);
        for (let j = 0; j < bias.length; j++) {
            let v = Number(bias[j]) || 0;
            for (let i = 0; i < vec.length; i++) {
                v += (Number(vec[i]) || 0) * (Number(mat[i][j]) || 0);
            }
            out[j] = v;
        }
        return out;
    }

    _reluVec(vec) {
        const out = new Array(vec.length);
        for (let i = 0; i < vec.length; i++) {
            out[i] = vec[i] > 0 ? vec[i] : 0;
        }
        return out;
    }

    _dotWithColumn(vec, matCol) {
        let sum = 0;
        for (let i = 0; i < vec.length; i++) {
            sum += (Number(vec[i]) || 0) * this._scalarFromArray(matCol[i]);
        }
        return sum;
    }

    _softmaxPair(logits) {
        const a = Number(logits[0]) || 0;
        const b = Number(logits[1]) || 0;
        const m = Math.max(a, b);
        const ea = Math.exp(a - m);
        const eb = Math.exp(b - m);
        const d = ea + eb + 1e-8;
        return [ea / d, eb / d];
    }

    _sigmoid(x) {
        if (x >= 0) {
            const z = Math.exp(-x);
            return 1 / (1 + z);
        }
        const z = Math.exp(x);
        return z / (1 + z);
    }

    _scalarFromArray(v) {
        return Array.isArray(v) ? (Number(v[0]) || 0) : (Number(v) || 0);
    }
}

if (typeof window !== 'undefined') {
    window.ACNRuntime = ACNRuntime;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ACNRuntime;
}
