class AudioChunkProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const processorOptions = options && options.processorOptions ? options.processorOptions : {};
        this.chunkSize = Math.max(128, processorOptions.chunkSize || 1024);
        this.buffer = new Float32Array(this.chunkSize);
        this.offset = 0;
    }

    process(inputs, outputs) {
        const input = (inputs[0] && inputs[0][0]) ? inputs[0][0] : null;
        const output = (outputs[0] && outputs[0][0]) ? outputs[0][0] : null;

        if (input && output) {
            output.set(input);
        } else if (output) {
            output.fill(0);
        }

        if (!input || input.length === 0) {
            return true;
        }

        let readOffset = 0;
        while (readOffset < input.length) {
            const writable = this.chunkSize - this.offset;
            const take = Math.min(writable, input.length - readOffset);
            this.buffer.set(input.subarray(readOffset, readOffset + take), this.offset);
            this.offset += take;
            readOffset += take;

            if (this.offset >= this.chunkSize) {
                const chunk = this.buffer;
                this.port.postMessage({ audio: chunk });
                this.buffer = new Float32Array(this.chunkSize);
                this.offset = 0;
            }
        }

        return true;
    }
}

registerProcessor('audio-chunk-processor', AudioChunkProcessor);
