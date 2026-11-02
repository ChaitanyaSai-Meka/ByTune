// analyseBuffer exactly as it shipped in 26f6713, before the analysis ran in slices. FROZEN: never
// edit it. The sliced analysis (src/lib/analysis.ts) must match it bit for bit (tests/analysis.test.mjs).
// A deliberate change to the algorithm replaces this file and says so in its commit. Generated with:
//   git show 26f6713:src/lib/analysis.ts | sed -n '55,319p' > ref.ts
//   npx esbuild ref.ts --format=esm --outfile=tests/fixtures/analysis-reference.mjs
function onsetEnvelope(chans, from, to, hop) {
  const win = hop * 2;
  const frames = Math.floor((to - from - win) / hop);
  if (frames < 64) return null;
  const left = chans[0];
  const right = chans.length > 1 ? chans[1] : null;
  const onset = new Float32Array(frames - 1);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = from + f * hop;
    for (let i = base; i < base + win; i++) {
      const v = right ? (left[i] + right[i]) / 2 : left[i];
      sum += v * v;
    }
    const energy = Math.sqrt(sum / win);
    if (f > 0) onset[f - 1] = Math.max(0, energy - prev);
    prev = energy;
  }
  return onset;
}
function autocorrTempo(env, fps) {
  let onsetMean = 0;
  for (let f = 0; f < env.length; f++) onsetMean += env[f];
  onsetMean = onsetMean / Math.max(1, env.length) || 1e-9;
  const onset = env.map((v) => v - onsetMean);
  const minLag = Math.floor(60 / 220 * fps);
  const maxLag = Math.ceil(60 / 50 * fps);
  let bestLag = 0;
  let bestVal = 0;
  let sumSq = 0;
  for (let f = 0; f < onset.length; f++) sumSq += onset[f] * onset[f];
  if (sumSq <= 0) return null;
  for (let lag = minLag; lag <= maxLag && lag < onset.length; lag++) {
    let dot = 0;
    for (let f = 0; f + lag < onset.length; f++) dot += onset[f] * onset[f + lag];
    const norm = dot / Math.sqrt(sumSq * sumSq) * onset.length;
    let bpm2 = 60 * fps / lag;
    while (bpm2 < 85) bpm2 *= 2;
    while (bpm2 > 180) bpm2 /= 2;
    const octaveWeight = bpm2 >= 85 && bpm2 <= 180 ? 1 : 0.55;
    const val = norm * octaveWeight;
    if (val > bestVal) {
      bestVal = val;
      bestLag = lag;
    }
  }
  if (!bestLag) return null;
  let bpm = 60 * fps / bestLag;
  while (bpm < 85) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const confidence = Math.min(1, Math.max(0, bestVal));
  if (confidence < 0.08) return null;
  return { bpm, confidence };
}
function musicOnset(chans, sr, limitSec = 75) {
  const win = Math.floor(sr * 0.5);
  const total = Math.min(chans[0].length, Math.floor(sr * limitSec));
  const windows = Math.floor(total / win);
  if (windows < 8) return null;
  const threshold = 0.055;
  const need = 4;
  let run = 0;
  const data = chans[0];
  const data2 = chans.length > 1 ? chans[1] : null;
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    const base = w * win;
    for (let i = 0; i < win; i += 2) {
      const v = data2 ? (data[base + i] + data2[base + i]) / 2 : data[base + i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum * 2 / win);
    if (rms > threshold) {
      run += 1;
      if (run >= need) return Math.max(0, (w - need + 1) * win) / sr;
    } else {
      run = 0;
    }
  }
  return null;
}
function highShelfCoefs(f0, dbGain, q, fs) {
  const k = Math.tan(Math.PI * f0 / fs);
  const vh = Math.pow(10, dbGain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  return [
    (vh + vb * k / q + k * k) / a0,
    2 * (k * k - vh) / a0,
    (vh - vb * k / q + k * k) / a0,
    2 * (k * k - 1) / a0,
    (1 - k / q + k * k) / a0
  ];
}
function highPassCoefs(f0, q, fs) {
  const k = Math.tan(Math.PI * f0 / fs);
  const a0 = 1 + k / q + k * k;
  return [1, -2, 1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0];
}
function analyseBuffer(channels, sampleRate) {
  const chans = channels.slice(0, 2);
  const sr = sampleRate;
  const n = chans[0].length;
  const [b0, b1, b2, a1, a2] = highShelfCoefs(1681.974450955533, 3.999843853973347, 0.7071752369554196, sr);
  const [c0, c1, c2, d1, d2] = highPassCoefs(38.13547087602444, 0.5003270373238773, sr);
  const sub = Math.floor(sr / 10);
  const energy = new Float64Array(Math.floor(n / sub));
  let first = n;
  let last = -1;
  for (const d of chans) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, acc = 0, k = 0, j = 0;
    let dn = 1e-20;
    for (let i = 0; i < n; i++) {
      const s = d[i];
      if (s > 8e-3 || s < -8e-3) {
        if (i < first) first = i;
        if (i > last) last = i;
      }
      dn = -dn;
      const x0 = s + dn;
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      const z0 = c0 * y0 + c1 * y1 + c2 * y2 - d1 * z1 - d2 * z2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      z2 = z1;
      z1 = z0;
      acc += z0 * z0;
      if (++k === sub) {
        energy[j++] += acc;
        acc = 0;
        k = 0;
      }
    }
  }
  const margin = Math.max(1, Math.floor(sr * 0.04));
  const headAt = last < 0 ? 0 : Math.max(0, first - margin);
  const endAt = last < 0 ? n : Math.min(n, last + margin + 1);
  const gatedMean = (floor) => {
    let sum = 0;
    let count = 0;
    for (let b = 0; b + 4 <= energy.length; b++) {
      const z = (energy[b] + energy[b + 1] + energy[b + 2] + energy[b + 3]) / (4 * sub);
      if (z > floor) {
        sum += z;
        count++;
      }
    }
    return count ? sum / count : 0;
  };
  const absGate = Math.pow(10, (-70 + 0.691) / 10);
  const absMean = sr >= 8e3 && n >= sr ? gatedMean(absGate) : 0;
  const lufs = absMean > 0 ? -0.691 + 10 * Math.log10(gatedMean(Math.max(absGate, absMean / 10))) : null;
  const span = Math.round(15 * sr);
  return {
    head: headAt / sr,
    tail: (n - endAt) / sr,
    lufs,
    onset: musicOnset(chans, sr),
    intro: beatGrid(chans, sr, headAt, Math.min(endAt, headAt + span), headAt, true),
    outro: beatGrid(chans, sr, Math.max(headAt, endAt - span), endAt, endAt, false)
  };
}
function beatGrid(chans, sr, lo, hi, anchor, first) {
  const hop = Math.round(sr / 86);
  const from = Math.max(0, lo - 4 * hop);
  const env = onsetEnvelope(chans, from, Math.min(chans[0].length, hi + 4 * hop), hop);
  if (!env || !env.some((v) => v > 0)) return null;
  const fps = sr / hop;
  const coarse = autocorrTempo(env, fps);
  if (!coarse) return null;
  const p0 = 60 * fps / coarse.bpm;
  let best = -1;
  let period = p0;
  let phase = 0;
  for (let step = -30; step <= 30; step++) {
    const p = p0 * (1 + step / 1e3);
    for (let ph = 0; ph < p; ph++) {
      let sum = 0;
      let count = 0;
      for (let x = ph; x < env.length - 0.5; x += p) {
        sum += env[Math.round(x)];
        count++;
      }
      if (sum / count > best) {
        best = sum / count;
        period = p;
        phase = ph;
      }
    }
  }
  const a = (anchor - from) / hop - 2.5;
  const beat = phase + (first ? Math.ceil((a - 0.5 - phase) / period) : Math.ceil((a - phase) / period) - 1) * period;
  let at = beat;
  let peak = 0;
  for (let f = Math.max(0, Math.round(beat) - 2); f <= Math.min(env.length - 1, Math.round(beat) + 2); f++) {
    if (env[f] > peak) {
      peak = env[f];
      at = f;
    }
  }
  return { bpm: 60 * fps / period, at: Math.max(0, (from + (at + 2.5) * hop) / sr) };
}
export {
  analyseBuffer
};
