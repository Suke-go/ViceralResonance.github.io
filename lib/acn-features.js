/**
 * ACN feature extraction from real-time prominence events.
 * Produces a 3-cue vector:
 *   [log(duration), log(energy proxy), log(spectral proxy)]
 */
class ACNFeatureExtractor {
    constructor(options = {}) {
        this.minDurationSec = Number.isFinite(options.minDurationSec) ? options.minDurationSec : 0.02;
        this.nearbyToleranceMs = Number.isFinite(options.nearbyToleranceMs) ? options.nearbyToleranceMs : 250;
        this.eps = Number.isFinite(options.eps) ? options.eps : 1e-6;
    }

    extractWordCue({ startSample, endSample, events, sampleRate }) {
        if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) return null;
        if (!Array.isArray(events) || events.length === 0) return null;
        if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;

        const spanStart = Math.min(startSample, endSample);
        const spanEnd = Math.max(startSample, endSample);
        const durationSec = Math.max((spanEnd - spanStart) / sampleRate, this.minDurationSec);

        const inWord = events.filter((e) =>
            Number.isFinite(e.sampleIndex) && e.sampleIndex >= spanStart && e.sampleIndex <= spanEnd
        );
        const activeEvents = inWord.length > 0
            ? inWord
            : this._collectNearbyEvents(events, spanStart, spanEnd, sampleRate);

        if (activeEvents.length === 0) return null;

        const energyVals = [];
        const spectralFluxVals = [];
        const highFreqVals = [];
        const mfccDeltaVals = [];
        const fusionVals = [];

        for (const event of activeEvents) {
            const f = event.features || {};
            if (Number.isFinite(f.energy) && f.energy > 0) energyVals.push(f.energy);
            if (Number.isFinite(f.spectralFlux) && f.spectralFlux >= 0) spectralFluxVals.push(f.spectralFlux);
            if (Number.isFinite(f.highFreqEnergy) && f.highFreqEnergy >= 0) highFreqVals.push(f.highFreqEnergy);
            if (Number.isFinite(f.mfccDelta)) mfccDeltaVals.push(Math.abs(f.mfccDelta));
            if (Number.isFinite(event.score) && event.score >= 0) fusionVals.push(event.score);
        }

        const fusionPrior = this._mean(fusionVals) * 0.05;
        const energyProxy = this._safePositive(this._mean(energyVals), fusionPrior);
        const spectralCore = this._std(spectralFluxVals) + this._mean(mfccDeltaVals);
        const spectralProxy = this._safePositive(
            spectralCore + 0.5 * this._mean(highFreqVals),
            fusionPrior
        );

        return [
            Math.log(Math.max(durationSec, this.eps)),
            Math.log(Math.max(energyProxy, this.eps)),
            Math.log(Math.max(spectralProxy, this.eps))
        ];
    }

    _collectNearbyEvents(events, spanStart, spanEnd, sampleRate) {
        const tolerance = Math.max(1, Math.round((this.nearbyToleranceMs * sampleRate) / 1000));
        const from = spanStart - tolerance;
        const to = spanEnd + tolerance;
        return events.filter((e) =>
            Number.isFinite(e.sampleIndex) && e.sampleIndex >= from && e.sampleIndex <= to
        );
    }

    _safePositive(primary, fallback) {
        if (Number.isFinite(primary) && primary > 0) return primary;
        if (Number.isFinite(fallback) && fallback > 0) return fallback;
        return this.eps;
    }

    _mean(arr) {
        if (!arr || arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        return sum / arr.length;
    }

    _std(arr) {
        if (!arr || arr.length < 2) return 0;
        const mu = this._mean(arr);
        let acc = 0;
        for (let i = 0; i < arr.length; i++) {
            const d = arr[i] - mu;
            acc += d * d;
        }
        return Math.sqrt(acc / (arr.length - 1));
    }
}

if (typeof window !== 'undefined') {
    window.ACNFeatureExtractor = ACNFeatureExtractor;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ACNFeatureExtractor;
}
