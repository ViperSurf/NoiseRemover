/**
 * 60fps interpolated noise-reduction meter.
 *
 * Telemetry arrives from the AudioWorklet at ~30Hz (decimated in the DSP so
 * the IPC bus is never saturated); this renderer smooths it to the display
 * refresh rate with an exponential approach (0.25 per frame) on a <canvas>.
 */
export interface MeterRenderState {
  enabled: boolean;
  idleBypassed: boolean;
  autoTuneProgress: number | null;
}

export class ReductionMeter {
  private targetDb = 0;
  private displayedDb = 0;

  setTarget(attenuationDb: number): void {
    this.targetDb = attenuationDb;
  }

  get displayed(): number {
    return this.displayedDb;
  }

  render(canvas: HTMLCanvasElement, statusEl: HTMLElement, state: MeterRenderState): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    this.displayedDb += (this.targetDb - this.displayedDb) * 0.25;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (state.autoTuneProgress !== null) {
      statusEl.textContent = `Profiling Noise... ${Math.round(state.autoTuneProgress * 100)}%`;
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(0, 0, canvas.width * state.autoTuneProgress, canvas.height);
    } else if (!state.enabled || state.idleBypassed) {
      statusEl.textContent = state.idleBypassed ? 'Idle Bypass (0% CPU)' : '0.0 dB (Bypassed)';
    } else {
      statusEl.textContent = `-${this.displayedDb.toFixed(1)} dB static cut`;
      const fillRatio = Math.min(1, this.displayedDb / 30);
      ctx.fillStyle = '#10b981';
      ctx.fillRect(0, 0, canvas.width * fillRatio, canvas.height);
    }
  }
}
