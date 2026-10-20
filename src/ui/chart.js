// Mini-graphique en courbes sur <canvas> (hyétogramme, hydrogrammes, limnigramme).

function niceStep(range, target) {
  const raw = range / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * @param canvas
 * @param opts { series: [{ name, color, points: [[x,y]], fill? }], xMax, yLabel, xFormat, cursor, bars }
 */
export function drawChart(canvas, opts) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const text = cssVar('--muted', '#667');
  const grid = cssVar('--grid', 'rgba(127,127,127,0.18)');
  const pad = { l: 40, r: 8, t: 8, b: 20 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;

  const xMax = opts.xMax || Math.max(1, ...opts.series.flatMap((s) => s.points.map((p) => p[0])));
  let yMax = 0;
  for (const s of opts.series) for (const p of s.points) yMax = Math.max(yMax, p[1]);
  yMax = yMax > 0 ? yMax * 1.1 : 1;
  const X = (x) => pad.l + (x / xMax) * pw;
  const Y = (y) => pad.t + ph - (y / yMax) * ph;

  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = text;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  const ys = niceStep(yMax, 4);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let y = 0; y <= yMax; y += ys) {
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(y));
    ctx.lineTo(W - pad.r, Y(y));
    ctx.stroke();
    ctx.fillText(y >= 100 ? y.toFixed(0) : +y.toFixed(2) + '', pad.l - 4, Y(y));
  }
  const xs = niceStep(xMax, 6);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const fmt = opts.xFormat || ((x) => x.toFixed(0));
  for (let x = 0; x <= xMax + 1e-9; x += xs) ctx.fillText(fmt(x), X(x), H - pad.b + 4);
  if (opts.yLabel) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.yLabel, pad.l + 4, pad.t);
    ctx.restore();
  }

  for (const s of opts.series) {
    if (!s.points.length) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.6;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke();
    if (s.fill) {
      ctx.lineTo(X(s.points[s.points.length - 1][0]), Y(0));
      ctx.lineTo(X(s.points[0][0]), Y(0));
      ctx.closePath();
      ctx.fillStyle = s.fill;
      ctx.fill();
    }
  }

  if (opts.cursor != null) {
    ctx.strokeStyle = cssVar('--accent', '#d33');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(opts.cursor), pad.t);
    ctx.lineTo(X(opts.cursor), pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
