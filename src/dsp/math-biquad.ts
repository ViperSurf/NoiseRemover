export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export class StereoBiquadFilter {
  private b0 = 1; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  // Direct Form II Transposed state registers for Left (0) and Right (1)
  private z1L = 0; private z2L = 0;
  private z1R = 0; private z2R = 0;

  public setCoeffs(c: BiquadCoeffs): void {
    this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2;
    this.a1 = c.a1; this.a2 = c.a2;
  }

  public reset(): void {
    this.z1L = 0; this.z2L = 0;
    this.z1R = 0; this.z2R = 0;
  }

  public processL(x: number): number {
    const y = this.b0 * x + this.z1L;
    this.z1L = this.b1 * x - this.a1 * y + this.z2L;
    this.z2L = this.b2 * x - this.a2 * y;
    return y;
  }

  public processR(x: number): number {
    const y = this.b0 * x + this.z1R;
    this.z1R = this.b1 * x - this.a1 * y + this.z2R;
    this.z2R = this.b2 * x - this.a2 * y;
    return y;
  }
}

export function calcHighPass(fc: number, q: number, fs: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosW0) / 2 / a0,
    b1: -(1 + cosW0) / a0,
    b2: (1 + cosW0) / 2 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function calcNotch(fc: number, q: number, fs: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cosW0) / a0,
    b2: 1 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function calcBandPass(fc: number, q: number, fs: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function calcHighShelf(fc: number, gainDb: number, fs: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosW0 = Math.cos(w0);
  const sqrtA = Math.sqrt(A);
  const alpha = (Math.sin(w0) / 2) * Math.sqrt(2);
  const a0 = A + 1 - (A - 1) * cosW0 + 2 * sqrtA * alpha;
  return {
    b0: (A * (A + 1 + (A - 1) * cosW0 + 2 * sqrtA * alpha)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cosW0)) / a0,
    b2: (A * (A + 1 + (A - 1) * cosW0 - 2 * sqrtA * alpha)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cosW0)) / a0,
    a2: (A + 1 - (A - 1) * cosW0 - 2 * sqrtA * alpha) / a0,
  };
}

export function calcPeakingEq(fc: number, q: number, gainDb: number, fs: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cosW0) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha / A) / a0,
  };
}
