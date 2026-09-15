/* ============================================================================
   Deposit Elasticity — chat app (block-schema version)
   Architecture: one analyst agent emits { blocks: [...], data: {...} }.
   Blocks name what to show; "data" carries the actual tool output the
   agent used. The UI never invents numbers — it only ever renders what's
   in "data", keyed by each block's "source".
   Integration contract (unchanged from before):
     POST /api/conversation/send-async/{slot}   -> { traceId }
     GET  /api/conversation/send-status/{slot}/{traceId} -> { status, reply, error }
   ============================================================================ */

var BDE_SLOT = 'depositelasticity';
var BDE_DEMO_MODE = true; // set false once the real endpoints are wired up
var BDE_CHART_COUNTER = 0;
var BDE_CHART_INSTANCES = {};

function bdeScrollToBottom() {
  var scroll = document.getElementById('bdeScroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

function bdeHideEmptyState() {
  var empty = document.getElementById('bdeEmptyState');
  if (empty) empty.remove();
}

function bdeAppendUserMessage(text) {
  bdeHideEmptyState();
  var thread = document.getElementById('bdeThread');
  var row = document.createElement('div');
  row.className = 'bde-row user';
  row.innerHTML = '<div class="bde-row-avatar">YOU</div><div class="bde-bubble"></div>';
  row.querySelector('.bde-bubble').textContent = text;
  thread.appendChild(row);
  bdeScrollToBottom();
}

function bdeAppendTyping() {
  var thread = document.getElementById('bdeThread');
  var row = document.createElement('div');
  row.id = 'bdeTypingRow';
  row.className = 'bde-row agent';
  row.innerHTML =
    '<div class="bde-row-avatar">DE</div>' +
    '<div class="bde-bubble"><div class="bde-typing">Checking deposit data' +
    '<span class="bde-typing-dots"><span></span><span></span><span></span></span></div></div>';
  thread.appendChild(row);
  bdeScrollToBottom();
}

function bdeRemoveTyping() {
  var row = document.getElementById('bdeTypingRow');
  if (row) row.remove();
}

function bdeSetSending(isSending) {
  var btn = document.getElementById('bdeSendBtn');
  var input = document.getElementById('bdeInput');
  if (btn) btn.disabled = isSending;
  if (input) input.disabled = isSending;
}

/* ---- Markdown fallback (only used if a reply isn't the blocks schema) --- */

function bdeRenderMarkdown(text) {
  if (!text) return '';
  var html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  var lines = html.split(/\r?\n/);
  var out = [];
  lines.forEach(function (line) {
    var t = line.trim();
    if (!t) return;
    var bullet = t.match(/^[-*]\s+(.+)/);
    if (bullet) { out.push('<li>' + bullet[1] + '</li>'); return; }
    out.push('<p>' + t + '</p>');
  });
  return out.join('');
}

/* ---- Chart color palette ------------------------------------------------ */

var BDE_COLORS = {
  cyan: '#00AEEF', cyanDim: 'rgba(0,174,239,0.14)',
  navy: '#00395D', good: '#1B8A5A', warn: '#A66A00', bad: '#C23B3B',
  chartOrange: '#E07B00',
  grid: '#E1E7EC', muted: '#6B7C8C', ink: '#14212E'
};

function bdeBaseChartOptions(extra) {
  var base = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#FFFFFF', borderColor: '#C7D2DB', borderWidth: 1,
        titleColor: '#14212E', bodyColor: '#38495A', titleFont: { family: 'IBM Plex Mono', size: 11 },
        bodyFont: { family: 'IBM Plex Mono', size: 11 }
      }
    },
    scales: {
      x: { grid: { color: BDE_COLORS.grid }, ticks: { color: BDE_COLORS.muted, font: { family: 'IBM Plex Mono', size: 10 } } },
      y: { grid: { color: BDE_COLORS.grid }, ticks: { color: BDE_COLORS.muted, font: { family: 'IBM Plex Mono', size: 10 } } }
    }
  };
  return Object.assign(base, extra || {});
}

function bdeMakeCanvas(container) {
  BDE_CHART_COUNTER++;
  var wrap = document.createElement('div');
  wrap.className = 'bde-block-chart-canvas-wrap';
  var canvas = document.createElement('canvas');
  canvas.id = 'bdeChart' + BDE_CHART_COUNTER;
  wrap.appendChild(canvas);
  container.appendChild(wrap);
  return canvas;
}

/* ---- Chart type 1: rateVsBalance (dual-axis, area + line) --------------- */

function bdeRenderRateVsBalanceChart(container, daily) {
  var series = (daily && daily.series) || [];
  if (!series.length) { container.innerHTML = '<p class="bde-block-text-body">No daily series available to chart.</p>'; return; }
  var canvas = bdeMakeCanvas(container);
  var labels = series.map(function (p) { return p.date; });

  new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Operational ($m)', data: series.map(function (p) { return p.operationalBalance; }),
          yAxisID: 'yBal', borderColor: BDE_COLORS.good, backgroundColor: 'rgba(27,138,90,0.14)',
          fill: 'origin', stack: 'bal', pointRadius: 0, borderWidth: 1.5
        },
        {
          label: 'Surplus ($m)', data: series.map(function (p) { return p.surplusBalance; }),
          yAxisID: 'yBal', borderColor: BDE_COLORS.cyan, backgroundColor: BDE_COLORS.cyanDim,
          fill: '-1', stack: 'bal', pointRadius: 0, borderWidth: 1.5
        },
        {
          label: 'Applied rate (%)', data: series.map(function (p) { return p.appliedRate; }),
          yAxisID: 'yRate', borderColor: BDE_COLORS.chartOrange, backgroundColor: 'transparent',
          borderWidth: 2, pointRadius: 0, stepped: true, order: 0
        }
      ]
    },
    options: bdeBaseChartOptions({
      scales: {
        x: { grid: { color: BDE_COLORS.grid }, ticks: { color: BDE_COLORS.muted, maxTicksLimit: 8, font: { family: 'IBM Plex Mono', size: 10 } } },
        yBal: { position: 'left', stacked: true, grid: { color: BDE_COLORS.grid }, ticks: { color: BDE_COLORS.muted, font: { family: 'IBM Plex Mono', size: 10 } }, title: { display: true, text: 'Balance', color: BDE_COLORS.muted, font: { size: 10 } } },
        yRate: { position: 'right', grid: { display: false }, ticks: { color: BDE_COLORS.chartOrange, font: { family: 'IBM Plex Mono', size: 10 } }, title: { display: true, text: 'Rate %', color: BDE_COLORS.chartOrange, font: { size: 10 } } }
      }
    })
  });

  var legend = document.createElement('div');
  legend.className = 'bde-block-chart-legend';
  legend.innerHTML =
    '<span><i style="background:' + BDE_COLORS.good + '"></i>Operational</span>' +
    '<span><i style="background:' + BDE_COLORS.cyan + '"></i>Surplus</span>' +
    '<span><i style="background:' + BDE_COLORS.chartOrange + '"></i>Applied rate</span>';
  container.appendChild(legend);
}

/* ---- Chart type 2: operationalVsSurplus (stacked area, same shape) ------ */

function bdeRenderOperationalVsSurplusChart(container, daily) {
  var series = (daily && daily.series) || [];
  if (!series.length) { container.innerHTML = '<p class="bde-block-text-body">No daily series available to chart.</p>'; return; }
  var canvas = bdeMakeCanvas(container);
  new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: series.map(function (p) { return p.date; }),
      datasets: [
        { label: 'Operational', data: series.map(function (p) { return p.operationalBalance; }), borderColor: BDE_COLORS.good, backgroundColor: 'rgba(27,138,90,0.18)', fill: 'origin', pointRadius: 0, borderWidth: 1.5, stack: 's' },
        { label: 'Surplus', data: series.map(function (p) { return p.surplusBalance; }), borderColor: BDE_COLORS.cyan, backgroundColor: BDE_COLORS.cyanDim, fill: '-1', pointRadius: 0, borderWidth: 1.5, stack: 's' }
      ]
    },
    options: bdeBaseChartOptions({ scales: { x: { grid: { color: BDE_COLORS.grid }, ticks: { color: BDE_COLORS.muted, maxTicksLimit: 8, font: { family: 'IBM Plex Mono', size: 10 } } }, y: { stacked: true, grid: { color: BDE_COLORS.grid }, ticks: { color: BDE_COLORS.muted, font: { family: 'IBM Plex Mono', size: 10 } } } } })
  });
  var legend = document.createElement('div');
  legend.className = 'bde-block-chart-legend';
  legend.innerHTML = '<span><i style="background:' + BDE_COLORS.good + '"></i>Operational</span><span><i style="background:' + BDE_COLORS.cyan + '"></i>Surplus</span>';
  container.appendChild(legend);
}

/* ---- Chart type 3: elasticityScatter (portfolio-level) ------------------ */

function bdeRenderElasticityScatterChart(container, summary) {
  var rows = (summary || []).filter(function (r) { return r.response30dPct != null && r.policyLagDays != null; });
  if (!rows.length) { container.innerHTML = '<p class="bde-block-text-body">No comparable rate-sensitivity data available to chart.</p>'; return; }
  var canvas = bdeMakeCanvas(container);
  // Categorize by whether the customer's rate-change response beat its own baseline drift —
  // this is the actual signal the KB summary pages compute, not a separate discrete flag.
  var buckets = { 'More responsive than baseline': [], 'At or below baseline': [] };
  rows.forEach(function (r) {
    var bucket = (r.baseline30dPct == null || r.response30dPct > r.baseline30dPct) ? 'More responsive than baseline' : 'At or below baseline';
    buckets[bucket].push({ x: r.response30dPct, y: r.policyLagDays, label: r.customerName + (r.currency ? ' (' + r.currency + ')' : '') });
  });
  var colorMap = { 'More responsive than baseline': BDE_COLORS.warn, 'At or below baseline': BDE_COLORS.good };
  var datasets = Object.keys(buckets).filter(function (k) { return buckets[k].length; }).map(function (bucket) {
    return { label: bucket, data: buckets[bucket], backgroundColor: colorMap[bucket], pointRadius: 5, pointHoverRadius: 7 };
  });
  new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: { datasets: datasets },
    options: bdeBaseChartOptions({
      plugins: {
        legend: { display: true, position: 'top', labels: { color: BDE_COLORS.muted, font: { family: 'IBM Plex Mono', size: 10 }, boxWidth: 10 } },
        tooltip: { callbacks: { label: function (ctx) { return (ctx.raw.label || '') + ': (' + ctx.raw.x + ', ' + ctx.raw.y + ')'; } } }
      },
      scales: {
        x: { title: { display: true, text: '30-day response (%)', color: BDE_COLORS.muted, font: { size: 10 } }, grid: { color: BDE_COLORS.grid }, ticks: { color: BDE_COLORS.muted, font: { family: 'IBM Plex Mono', size: 10 } } },
        y: { title: { display: true, text: 'Policy-to-customer lag (days)', color: BDE_COLORS.muted, font: { size: 10 } }, grid: { color: BDE_COLORS.grid }, ticks: { color: BDE_COLORS.muted, font: { family: 'IBM Plex Mono', size: 10 } } }
      }
    })
  });
}

/* ---- Chart type 4: lagChain (hand-rolled SVG, not a Chart.js type) ------ */

function bdeRenderLagChainChart(container, summaryRow) {
  if (!summaryRow) { container.innerHTML = '<p class="bde-block-text-body">No account selected for a lag chain.</p>'; return; }
  var hops = [
    { label: 'Policy change', days: null },
    { label: 'Bank response', days: summaryRow.avgBankResponseLagDays },
    { label: 'Customer rate', days: summaryRow.bankToCustomerLagDays },
    { label: 'Balance moves', days: summaryRow.reactionLagDays }
  ];
  var w = 680, h = 130, nodeR = 26, gap = (w - nodeR * 2 * hops.length) / (hops.length - 1) + nodeR * 2;
  var svg = '<svg class="bde-lagchain-svg" viewBox="-20 0 ' + (w + 40) + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">';
  hops.forEach(function (hop, i) {
    var cx = nodeR + i * gap;
    var cy = h / 2 - 10;
    if (i > 0) {
      var prevCx = nodeR + (i - 1) * gap;
      svg += '<line class="bde-lagchain-arrow" x1="' + (prevCx + nodeR) + '" y1="' + cy + '" x2="' + (cx - nodeR) + '" y2="' + cy + '" marker-end="url(#bdeArrow)"></line>';
      svg += '<text class="bde-lagchain-day-label" x="' + ((prevCx + cx) / 2) + '" y="' + (cy - 8) + '" text-anchor="middle">' + (hop.days != null ? hop.days + 'd' : '') + '</text>';
    }
    svg += '<circle class="bde-lagchain-node" cx="' + cx + '" cy="' + cy + '" r="' + nodeR + '"></circle>';
    svg += '<text class="bde-lagchain-hop-label" x="' + cx + '" y="' + (cy + nodeR + 18) + '" text-anchor="middle">' + hop.label + '</text>';
  });
  svg += '<defs><marker id="bdeArrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#2C4A63"></path></marker></defs>';
  svg += '</svg>';
  container.innerHTML = svg;
  var foot = document.createElement('p');
  foot.className = 'bde-block-text-body';
  foot.style.marginTop = '4px';
  foot.textContent = 'End-to-end policy-to-balance lag: ' + (summaryRow.policyToBalanceLagDays != null ? summaryRow.policyToBalanceLagDays + ' days' : 'not available') + '.';
  container.appendChild(foot);
}

/* ---- Chart type 5: responseCurves (30d vs 60d response per event) ------- */

function bdeRenderResponseCurvesChart(container, daily) {
  var changes = (daily && daily.rateChanges) || [];
  if (!changes.length) { container.innerHTML = '<p class="bde-block-text-body">No rate-change events available to chart.</p>'; return; }
  var canvas = bdeMakeCanvas(container);
  new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: changes.map(function (c) { return c.date; }),
      datasets: [
        { label: '30-day response', data: changes.map(function (c) { return c.d30 != null ? c.d30 : null; }), backgroundColor: BDE_COLORS.cyan },
        { label: '60-day response', data: changes.map(function (c) { return c.d60; }), backgroundColor: BDE_COLORS.navy }
      ]
    },
    options: bdeBaseChartOptions({
      plugins: { legend: { display: true, position: 'top', labels: { color: BDE_COLORS.muted, font: { family: 'IBM Plex Mono', size: 10 }, boxWidth: 10 } } }
    })
  });
}

function bdeRenderChartBlock(block, data) {
  var wrap = document.createElement('div');
  wrap.className = 'bde-block bde-block-chart';
  var source = block.source === 'summary' ? (data.summary || []) : data.daily;
  switch (block.chart) {
    case 'rateVsBalance': bdeRenderRateVsBalanceChart(wrap, source); break;
    case 'operationalVsSurplus': bdeRenderOperationalVsSurplusChart(wrap, source); break;
    case 'elasticityScatter': bdeRenderElasticityScatterChart(wrap, data.summary || []); break;
    case 'lagChain':
      wrap.innerHTML = '<p class="bde-block-text-body" style="color:var(--faint);font-style:italic;">This deployment\'s data only has a single policy-lag figure, not the 4-hop breakdown this chart needs — the agent should state the lag as text instead.</p>';
      break;
    case 'responseCurves': bdeRenderResponseCurvesChart(wrap, data.daily); break;
    default: wrap.innerHTML = '<p class="bde-block-text-body">Unknown chart type: ' + block.chart + '</p>';
  }
  return wrap;
}

/* ---- Table block ---------------------------------------------------------*/

function bdeResolveTableSource(source, data) {
  if (Array.isArray(data[source])) return data[source];
  if (data.daily && Array.isArray(data.daily[source])) return data.daily[source];
  if (data.summary && source === 'summary') return data.summary;
  return [];
}

function bdeRenderTableBlock(block, data) {
  var rows = bdeResolveTableSource(block.source, data);
  var wrap = document.createElement('div');
  wrap.className = 'bde-block';
  if (!rows.length) { wrap.innerHTML = '<p class="bde-block-text-body">No table data available.</p>'; return wrap; }

  var cols = block.columns || Object.keys(rows[0]);
  var showRows = block.showRows || rows.length;
  var tableWrap = document.createElement('div');
  tableWrap.className = 'bde-block-table-wrap';

  function buildTable(limit) {
    var html = '<table class="bde-block-table"><thead><tr>';
    cols.forEach(function (c) { html += '<th>' + c + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.slice(0, limit).forEach(function (row) {
      html += '<tr>';
      cols.forEach(function (c) { html += '<td>' + (row[c] !== undefined ? row[c] : '') + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  tableWrap.innerHTML = buildTable(showRows);
  wrap.appendChild(tableWrap);

  if (rows.length > showRows) {
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'bde-block-table-toggle';
    toggle.textContent = 'Show all ' + rows.length + ' rows';
    toggle.addEventListener('click', function () {
      tableWrap.innerHTML = buildTable(rows.length);
      toggle.remove();
    });
    tableWrap.appendChild(toggle);
  }
  return wrap;
}

/* ---- Assemble a full blocks payload -------------------------------------*/

function bdeRenderBlocks(payload) {
  var data = payload.data || {};
  var container = document.createElement('div');
  container.className = 'bde-blocks';

  (payload.blocks || []).forEach(function (block) {
    try {
      if (block.type === 'text') {
        var el = document.createElement('div');
        el.className = 'bde-block bde-block-text';
        if (block.title) el.innerHTML += '<div class="bde-block-text-title">' + block.title + '</div>';
        el.innerHTML += '<div class="bde-block-text-body">' + block.body + '</div>';
        container.appendChild(el);
      } else if (block.type === 'chart') {
        container.appendChild(bdeRenderChartBlock(block, data));
      } else if (block.type === 'table') {
        container.appendChild(bdeRenderTableBlock(block, data));
      } else if (block.type === 'insight') {
        var ins = document.createElement('div');
        ins.className = 'bde-block bde-block-insight';
        ins.innerHTML = '<strong>What it means: </strong>' + block.body;
        container.appendChild(ins);
      } else if (block.type === 'suggestions') {
        var sug = document.createElement('div');
        sug.className = 'bde-block bde-suggestions';
        (block.items || []).forEach(function (item) {
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'bde-chip';
          chip.textContent = item;
          chip.addEventListener('click', function () { bdeSend(item); });
          sug.appendChild(chip);
        });
        container.appendChild(sug);
      }
    } catch (err) {
      // One malformed block should never take down the rest of the message.
      var fallback = document.createElement('div');
      fallback.className = 'bde-block bde-block-text';
      fallback.innerHTML = '<div class="bde-block-text-body" style="color:var(--faint);font-style:italic;">A ' + block.type + ' block failed to render.</div>';
      container.appendChild(fallback);
      if (window.console) console.error('Block render failed:', block, err);
    }
  });

  return container;
}

function bdeAppendAgentMessage(rawReply) {
  bdeHideEmptyState();
  var thread = document.getElementById('bdeThread');
  var row = document.createElement('div');
  row.className = 'bde-row agent';
  var avatar = document.createElement('div');
  avatar.className = 'bde-row-avatar';
  avatar.textContent = 'DE';
  var bubble = document.createElement('div');
  bubble.className = 'bde-bubble';
  row.appendChild(avatar);
  row.appendChild(bubble);

  try {
    var parsed = JSON.parse(rawReply);
    if (parsed.blocks) {
      bubble.appendChild(bdeRenderBlocks(parsed));
    } else {
      bubble.innerHTML = bdeRenderMarkdown(rawReply);
    }
  } catch (e) {
    bubble.innerHTML = bdeRenderMarkdown(rawReply);
  }

  thread.appendChild(row);
  bdeScrollToBottom();
}

/* ---- Send / poll -------------------------------------------------------- */

function bdePollStatus(traceId) {
  fetch('/api/conversation/send-status/' + BDE_SLOT + '/' + encodeURIComponent(traceId))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.status === 'PENDING') { setTimeout(function () { bdePollStatus(traceId); }, 2000); return; }
      bdeRemoveTyping();
      bdeSetSending(false);
      if (data.status === 'COMPLETED') bdeAppendAgentMessage(data.reply);
      else bdeAppendAgentMessage('Sorry — something went wrong: ' + (data.error || 'unknown error'));
    })
    .catch(function () { setTimeout(function () { bdePollStatus(traceId); }, 3000); });
}

/* ---- Demo payload — mirrors the Vodafone sample from the rebuild doc ---- */

function bdeGenerateVodafoneSeries() {
  var series = [];
  var start = new Date('2019-01-01');
  var end = new Date('2026-06-30');
  var rate = 0.69, operational = 81, surplus = 20;
  var cur = new Date(start);
  var months = 0;
  while (cur <= end) {
    months++;
    // rough shape: rate falls to 0.04 by mid-2020, climbs to 5.19 by mid-2023, eases to 4.19
    if (months < 16) rate = 0.69 - (months / 16) * 0.65;
    else if (months < 55) rate = 0.04 + ((months - 16) / 39) * 5.15;
    else rate = 5.19 - ((months - 55) / 34) * 1.0;
    rate = Math.max(0.01, Math.round(rate * 100) / 100);
    // surplus tracks rate with noise + growth, operational stays flat
    surplus = Math.max(5, 15 + (rate * 20) + (months * 0.6) + (Math.sin(months / 3) * 10));
    series.push({
      date: cur.toISOString().slice(0, 7),
      appliedRate: rate,
      balance: Math.round((operational + surplus) * 10) / 10,
      operationalBalance: operational,
      surplusBalance: Math.round(surplus * 10) / 10
    });
    cur.setMonth(cur.getMonth() + 1);
  }
  return series;
}

function bdeDemoPayload() {
  var series = bdeGenerateVodafoneSeries();
  var rateChanges = [
    { date: '2 May 2026', before: '3.94%', after: '4.19%', bps: '+25 bp', d30: 6.1, d60: 8.3 },
    { date: '2 Aug 2025', before: '4.44%', after: '3.94%', bps: '-50 bp', d30: -12.0, d60: -16.5 },
    { date: '2 Feb 2025', before: '4.94%', after: '4.44%', bps: '-50 bp', d30: -12.9, d60: -16.7 },
    { date: '16 Aug 2024', before: '5.19%', after: '4.94%', bps: '-25 bp', d30: -6.3, d60: -8.1 },
    { date: '4 Aug 2023', before: '4.94%', after: '5.19%', bps: '+25 bp', d30: 6.6, d60: 8.5 }
  ];
  var summaryRow = {
    customerName: 'Vodafone Treasury UK', country: 'United Kingdom', sector: 'Telecommunications', currency: 'GBP',
    balanceLatest: 289, operationalBalanceLatest: 81, surplusBalanceLatest: 208, avgPercentageOperationalBalance: 28.0,
    deviation: 6.4, response30d: 6.1, response60d: 8.3, elasticityFlag: 'Medium', handlingHint: 'OUTREACH',
    avgBankResponseLagDays: 3, bankToCustomerLagDays: 1, reactionLagDays: 21, policyToBalanceLagDays: 25
  };
  return JSON.stringify({
    blocks: [
      { type: 'text', title: 'Vodafone Treasury UK — rate changes and balance response',
        body: "Vodafone's applied rate has moved 20 times since 2019, tracking the bank's published rate minus 6 bp with full pass-through of every Bank of England decision. The balance follows with roughly £8m per 25 bp within 60 days, all of it in the £208m surplus tier." },
      { type: 'chart', chart: 'rateVsBalance', source: 'daily', annotations: 'boe' },
      { type: 'table', source: 'rateChanges', columns: ['date', 'before', 'after', 'bps', 'd60'], showRows: 5 },
      { type: 'insight', body: "A rate-following but slow account. Protect the operational tier's rate; the surplus tier can be repriced knowing each 25 bp moves about £8m over six weeks, with no cliff-edge risk." },
      { type: 'suggestions', items: ['What happened after the Feb 2025 cut?', 'Compare with Rolls-Royce Holdings', 'Which BoE moves drove the biggest shifts?'] }
    ],
    data: {
      daily: { customerName: 'Vodafone Treasury UK', series: series, rateChanges: rateChanges },
      summary: [summaryRow]
    }
  });
}

function bdeSend(text) {
  text = (text || (document.getElementById('bdeInput') && document.getElementById('bdeInput').value) || '').trim();
  if (!text) return;
  var input = document.getElementById('bdeInput');
  if (input) { input.value = ''; input.style.height = 'auto'; }
  bdeAppendUserMessage(text);
  bdeAppendTyping();
  bdeSetSending(true);

  if (BDE_DEMO_MODE) {
    setTimeout(function () {
      bdeRemoveTyping();
      bdeSetSending(false);
      bdeAppendAgentMessage(bdeDemoPayload());
    }, 1200);
    return;
  }

  var formData = new FormData();
  formData.append('query', text);
  fetch('/api/conversation/send-async/' + BDE_SLOT, { method: 'POST', body: formData })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.traceId) {
        bdeRemoveTyping(); bdeSetSending(false);
        bdeAppendAgentMessage('Sorry — something went wrong: ' + (data.error || 'unknown error'));
        return;
      }
      bdePollStatus(data.traceId);
    })
    .catch(function () {
      bdeRemoveTyping(); bdeSetSending(false);
      bdeAppendAgentMessage('Network error — please try again.');
    });
}

function bdeInitInput() {
  var input = document.getElementById('bdeInput');
  var btn = document.getElementById('bdeSendBtn');
  if (!input) return;
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); bdeSend(); }
  });
  if (btn) btn.addEventListener('click', function () { bdeSend(); });
}

document.addEventListener('DOMContentLoaded', bdeInitInput);
