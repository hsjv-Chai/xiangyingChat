/*
 * AMR 解码器（渲染进程版）
 * 改编自 @audio/decode-amr（Apache-2.0，https://github.com/audiojs/decode）
 * 依赖：vendor/amr.wasm.cjs 以经典脚本加载，提供全局 createAMR。
 */
(function () {
  'use strict';

  const EMPTY = Object.freeze({ channelData: [], sampleRate: 0 });

  // AMR-NB 帧大小（字节，含头），按下标 0-15 的模式索引
  const NB_SIZES = [13, 14, 16, 18, 20, 21, 27, 32, 6, 6, 6, 6, 1, 1, 1, 1];
  // AMR-WB 帧大小（字节，含头），按下标 0-15 的模式索引
  const WB_SIZES = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 1, 1, 1, 1, 1, 1];

  let _modP;

  async function getMod() {
    if (_modP) return _modP;
    const p = (async () => {
      const createAMR = globalThis.createAMR;
      if (typeof createAMR !== 'function') throw new Error('AMR WASM 模块未加载');
      return createAMR();
    })();
    _modP = p;
    try {
      return await p;
    } catch (e) {
      _modP = null;
      throw e;
    }
  }

  class AMRDecoder {
    constructor(mod) {
      this.m = mod;
      this.done = false;
      this._ptr = 0;
      this._cap = 0;
      this._isWB = null;
      this._h = null;
      this._left = null;
      this._sr = 0;
    }

    decode(data) {
      if (this.done) throw new Error('Decoder already freed');
      if (!data || !data.length) return EMPTY;

      let buf = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (this._left) {
        const r = new Uint8Array(this._left.length + buf.length);
        r.set(this._left);
        r.set(buf, this._left.length);
        buf = r;
        this._left = null;
      }

      let off = 0;

      // 首次调用时识别 AMR 文件头（#!AMR / #!AMR-WB）
      if (this._isWB === null) {
        if (buf.length < 9) {
          this._left = buf.slice();
          return EMPTY;
        }
        if (
          buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x41 &&
          buf[3] === 0x4d && buf[4] === 0x52
        ) {
          if (buf.length > 8 && buf[5] === 0x2d && buf[6] === 0x57 && buf[7] === 0x42 && buf[8] === 0x0a) {
            this._isWB = true;
            off = 9;
          } else if (buf[5] === 0x0a) {
            this._isWB = false;
            off = 6;
          }
        }
        if (this._isWB === null) return EMPTY;
        this._sr = this._isWB ? 16000 : 8000;
        this._h = this._isWB ? this.m._amr_wb_create() : this.m._amr_nb_create();
      }

      const sizes = this._isWB ? WB_SIZES : NB_SIZES;
      const chunks = [];

      while (off < buf.length) {
        const mode = (buf[off] >> 3) & 0x0f;
        const frameSize = sizes[mode];
        if (!frameSize || off + frameSize > buf.length) break;

        const ptr = this._alloc(frameSize);
        this.m.HEAPU8.set(buf.subarray(off, off + frameSize), ptr);

        const n = this._isWB
          ? this.m._amr_wb_decode(this._h, ptr, frameSize)
          : this.m._amr_nb_decode(this._h, ptr, frameSize);

        const outPtr = this._isWB ? this.m._amr_wb_output() : this.m._amr_nb_output();
        chunks.push(new Float32Array(this.m.HEAPF32.buffer, outPtr, n).slice());

        off += frameSize;
      }

      if (off < buf.length) this._left = buf.subarray(off).slice();
      if (!chunks.length) return EMPTY;

      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Float32Array(total);
      let pos = 0;
      for (const c of chunks) {
        out.set(c, pos);
        pos += c.length;
      }
      return { channelData: [out], sampleRate: this._sr };
    }

    flush() {
      this._left = null;
      return EMPTY;
    }

    free() {
      if (this.done) return;
      this.done = true;
      if (this._h) {
        if (this._isWB) this.m._amr_wb_close(this._h);
        else this.m._amr_nb_close(this._h);
        this._h = null;
      }
      if (this._ptr) {
        this.m._free(this._ptr);
        this._ptr = 0;
        this._cap = 0;
      }
      this._left = null;
    }

    _alloc(len) {
      if (len > this._cap) {
        if (this._ptr) this.m._free(this._ptr);
        this._cap = len;
        this._ptr = this.m._malloc(len);
      }
      return this._ptr;
    }
  }

  /** 解码完整 AMR 文件，返回 { channelData: Float32Array[], sampleRate } */
  async function decode(src) {
    const buf = src instanceof Uint8Array ? src : new Uint8Array(src);
    const dec = new AMRDecoder(await getMod());
    try {
      return dec.decode(buf);
    } finally {
      dec.free();
    }
  }

  globalThis.AMRDecode = { decode };
})();
