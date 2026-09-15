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
var BDE_DEMO_MODE = false; // connected to the real Purple Fabric agent
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

function bdeFormatTime(iso) {
  var d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function bdeAppendUserMessage(text, timestampIso) {
  bdeHideEmptyState();
  var thread = document.getElementById('bdeThread');
  var row = document.createElement('div');
  row.className = 'bde-row user';
  row.innerHTML =
    '<div class="bde-row-avatar">YOU</div>' +
    '<div class="bde-msg-col">' +
      '<div class="bde-bubble"></div>' +
      '<div class="bde-msg-meta">' + bdeFormatTime(timestampIso) + '</div>' +
    '</div>';
  row.querySelector('.bde-bubble').textContent = text;
  thread.appendChild(row);
  bdeScrollToBottom();
}

var BDE_LOADING_MESSAGES = [
  'Searching the Knowledge Garden…',
  'Retrieving customer summary…',
  'Checking rate-change history…',
  'Cross-referencing central bank events…',
  'Calculating rate-change responsiveness…',
  'Reviewing operational vs surplus balance…',
  'Comparing against baseline movement…',
  'Checking policy-to-customer lag…',
  'Assembling the response…'
];
var BDE_LOADING_TIMER = null;

function bdeAppendTyping() {
  var thread = document.getElementById('bdeThread');
  var row = document.createElement('div');
  row.id = 'bdeTypingRow';
  row.className = 'bde-row agent';
  row.innerHTML =
    '<div class="bde-row-avatar">DE</div>' +
    '<div class="bde-bubble"><div class="bde-typing"><span id="bdeLoadingText">' + BDE_LOADING_MESSAGES[0] + '</span>' +
    '<span class="bde-typing-dots"><span></span><span></span><span></span></span></div></div>';
  thread.appendChild(row);
  bdeScrollToBottom();

  var idx = 0;
  clearInterval(BDE_LOADING_TIMER);
  BDE_LOADING_TIMER = setInterval(function () {
    idx = (idx + 1) % BDE_LOADING_MESSAGES.length;
    var el = document.getElementById('bdeLoadingText');
    if (el) el.textContent = BDE_LOADING_MESSAGES[idx];
  }, 1700);
}

function bdeRemoveTyping() {
  clearInterval(BDE_LOADING_TIMER);
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
  wrap.className = 'bde-block bde-collapsible';
  if (!rows.length) { wrap.innerHTML = '<p class="bde-block-text-body">No table data available.</p>'; return wrap; }

  var cols = block.columns || Object.keys(rows[0]);
  var showRows = block.showRows || rows.length;

  var header = document.createElement('button');
  header.type = 'button';
  header.className = 'bde-collapsible-header';
  header.innerHTML =
    '<span class="bde-collapsible-chevron">&#9656;</span>' +
    '<span>View data — ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + '</span>';

  var bodyWrap = document.createElement('div');
  bodyWrap.className = 'bde-collapsible-body';

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
  bodyWrap.appendChild(tableWrap);

  if (rows.length > showRows) {
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'bde-block-table-toggle';
    toggle.textContent = 'Show all ' + rows.length + ' rows';
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      tableWrap.innerHTML = buildTable(rows.length);
      toggle.remove();
    });
    tableWrap.appendChild(toggle);
  }

  header.addEventListener('click', function () {
    var isOpen = wrap.classList.contains('open');
    wrap.classList.toggle('open', !isOpen);
    header.querySelector('.bde-collapsible-chevron').innerHTML = isOpen ? '&#9656;' : '&#9662;';
  });

  wrap.appendChild(header);
  wrap.appendChild(bodyWrap);
  return wrap;
}

/* ---- Assemble a full blocks payload -------------------------------------*/

function bdeBuildSuggestionsBlock(items) {
  var sug = document.createElement('div');
  sug.className = 'bde-block bde-suggestions';
  items.forEach(function (item) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bde-chip';
    chip.textContent = item;
    chip.addEventListener('click', function () { bdeSend(item); });
    sug.appendChild(chip);
  });
  return sug;
}

// Used only when the agent's response has no suggestions block of its own —
// generic but genuinely relevant to this use case, so follow-ups are always
// available rather than depending on the agent remembering to include them.
var BDE_FALLBACK_SUGGESTIONS = [
  'Compare this with another company',
  'What is the operational vs surplus split?',
  'Show related central bank rate events'
];

function bdeRenderBlocks(payload) {
  var data = payload.data || {};
  var container = document.createElement('div');
  container.className = 'bde-blocks';
  var hasSuggestions = false;

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
        hasSuggestions = true;
        container.appendChild(bdeBuildSuggestionsBlock(block.items || []));
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

  if (!hasSuggestions) {
    container.appendChild(bdeBuildSuggestionsBlock(BDE_FALLBACK_SUGGESTIONS));
  }

  return container;
}

function bdeAppendAgentMessage(rawReply, timestampIso, responseTimeMs) {
  bdeHideEmptyState();
  var thread = document.getElementById('bdeThread');
  var row = document.createElement('div');
  row.className = 'bde-row agent';
  var avatar = document.createElement('div');
  avatar.className = 'bde-row-avatar';
  avatar.textContent = 'DE';
  var col = document.createElement('div');
  col.className = 'bde-msg-col';
  var bubble = document.createElement('div');
  bubble.className = 'bde-bubble';
  col.appendChild(bubble);
  row.appendChild(avatar);
  row.appendChild(col);

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

  var meta = document.createElement('div');
  meta.className = 'bde-msg-meta';
  var metaText = bdeFormatTime(timestampIso);
  if (responseTimeMs != null && responseTimeMs >= 0) {
    var secs = (responseTimeMs / 1000).toFixed(1);
    metaText += ' · responded in ' + secs + 's';
  }
  meta.textContent = metaText;
  col.appendChild(meta);

  thread.appendChild(row);
  bdeScrollToBottom();
}

/* ---- Send / poll -------------------------------------------------------- */

function bdePollStatus(traceId, sendStartMs) {
  fetch('/api/conversation/send-status/' + BDE_SLOT + '/' + encodeURIComponent(traceId))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.status === 'PENDING') { setTimeout(function () { bdePollStatus(traceId, sendStartMs); }, 2000); return; }
      bdeRemoveTyping();
      bdeSetSending(false);
      if (data.status === 'COMPLETED') {
        var elapsed = sendStartMs != null ? (Date.now() - sendStartMs) : null;
        bdeAppendAgentMessage(data.reply, new Date().toISOString(), elapsed);
        bdeRefreshSessionList();
      }
      else bdeAppendAgentMessage('Sorry — something went wrong: ' + (data.error || 'unknown error'));
    })
    .catch(function () { setTimeout(function () { bdePollStatus(traceId, sendStartMs); }, 3000); });
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
  var sendStartMs = Date.now();
  bdeAppendUserMessage(text, new Date(sendStartMs).toISOString());
  bdeAppendTyping();
  bdeSetSending(true);

  if (BDE_DEMO_MODE) {
    var sid = BDE_ACTIVE_SESSION_ID;
    if (sid) {
      if (!BDE_DEMO_MESSAGES[sid]) BDE_DEMO_MESSAGES[sid] = [];
      BDE_DEMO_MESSAGES[sid].push({ role: 'user', content: text, createdAt: new Date(sendStartMs).toISOString() });
    }
    setTimeout(function () {
      bdeRemoveTyping();
      bdeSetSending(false);
      var reply = bdeDemoPayload();
      var nowIso = new Date().toISOString();
      if (sid) {
        BDE_DEMO_MESSAGES[sid].push({ role: 'agent', content: reply, createdAt: nowIso });
        bdeTouchDemoSession(sid, text);
      }
      bdeAppendAgentMessage(reply, nowIso, Date.now() - sendStartMs);
    }, 1200);
    return;
  }

  var formData = new FormData();
  formData.append('query', text);
  if (BDE_ACTIVE_SESSION_ID) formData.append('sessionId', BDE_ACTIVE_SESSION_ID);
  fetch('/api/conversation/send-async/' + BDE_SLOT, { method: 'POST', body: formData })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.traceId) {
        bdeRemoveTyping(); bdeSetSending(false);
        bdeAppendAgentMessage('Sorry — something went wrong: ' + (data.error || 'unknown error'));
        return;
      }
      bdePollStatus(data.traceId, sendStartMs);
    })
    .catch(function () {
      bdeRemoveTyping(); bdeSetSending(false);
      bdeAppendAgentMessage('Network error — please try again.');
    });
}

/* ============================================================================
   SESSIONS — multiple named analyses, each resumable.
   Real mode: backed by /api/sessions (SQLite server-side). What's persisted
   there is Purple Fabric's own conversation_id per session, which is the
   actual thing needed to resume a thread — NOT an auth token, since that's
   short-lived and re-fetched automatically by the backend on every call.
   Demo mode: an in-memory mirror of the same shape, so session switching is
   fully testable (new/switch/replay) without a real backend — mirrors how
   BDE_DEMO_MODE already fakes the chat reply itself.
   ============================================================================ */

var BDE_SESSIONS_CACHE = [];
var BDE_ACTIVE_SESSION_ID = null;
var BDE_EMPTY_STATE_HTML = '';
var BDE_DEMO_SESSIONS = [];
var BDE_DEMO_MESSAGES = {};

function bdeApiListSessions() {
  if (BDE_DEMO_MODE) {
    return Promise.resolve(BDE_DEMO_SESSIONS.slice().sort(function (a, b) { return b.updatedAt.localeCompare(a.updatedAt); }));
  }
  // Real mode: real sessions come from the backend, but the example session
  // is purely local and always merged in — it never touches the server.
  return fetch('/api/sessions').then(function (r) { return r.json(); }).then(function (real) {
    var example = BDE_DEMO_SESSIONS.filter(function (s) { return s.id === BDE_EXAMPLE_SESSION_ID; });
    return (real || []).concat(example);
  });
}

function bdeApiCreateSession() {
  if (BDE_DEMO_MODE) {
    var now = new Date().toISOString();
    var s = { id: 'demo-' + Math.random().toString(36).slice(2), title: 'New analysis', createdAt: now, updatedAt: now };
    BDE_DEMO_SESSIONS.unshift(s);
    BDE_DEMO_MESSAGES[s.id] = [];
    return Promise.resolve(s);
  }
  return fetch('/api/sessions', { method: 'POST' }).then(function (r) { return r.json(); });
}

function bdeApiGetMessages(id) {
  if (id === BDE_EXAMPLE_SESSION_ID) return Promise.resolve(BDE_DEMO_MESSAGES[id] || []);
  if (BDE_DEMO_MODE) return Promise.resolve(BDE_DEMO_MESSAGES[id] || []);
  return fetch('/api/sessions/' + encodeURIComponent(id) + '/messages').then(function (r) { return r.json(); });
}

function bdeFormatSessionMeta(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function bdeDateBucket(iso) {
  var d = new Date(iso);
  var now = new Date();
  var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  var start7 = new Date(startOfToday); start7.setDate(start7.getDate() - 7);
  var start30 = new Date(startOfToday); start30.setDate(start30.getDate() - 30);

  if (d >= startOfToday) return 'Today';
  if (d >= startOfYesterday) return 'Yesterday';
  if (d >= start7) return 'Previous 7 days';
  if (d >= start30) return 'Previous 30 days';
  return 'Older';
}

var BDE_RAIL_GROUP_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];
var BDE_RAIL_GROUP_COLLAPSED = {}; // persists collapse choices across re-renders this session

function bdeRenderSessionList(sessions) {
  var list = document.getElementById('bdeRailList');
  if (!list) return;
  list.innerHTML = '';

  var groups = {};
  sessions.forEach(function (s) {
    var bucket = bdeDateBucket(s.updatedAt);
    if (!groups[bucket]) groups[bucket] = [];
    groups[bucket].push(s);
  });

  BDE_RAIL_GROUP_ORDER.forEach(function (bucket) {
    var items = groups[bucket];
    if (!items || !items.length) return;

    var groupEl = document.createElement('div');
    groupEl.className = 'bde-rail-group' + (BDE_RAIL_GROUP_COLLAPSED[bucket] ? ' collapsed' : '');

    var header = document.createElement('button');
    header.type = 'button';
    header.className = 'bde-rail-group-header';
    header.innerHTML = '<span class="bde-rail-group-chevron">&#9662;</span><span>' + bucket + '</span>';
    header.addEventListener('click', function () {
      var collapsed = !groupEl.classList.contains('collapsed');
      groupEl.classList.toggle('collapsed', collapsed);
      BDE_RAIL_GROUP_COLLAPSED[bucket] = collapsed;
    });

    var body = document.createElement('div');
    body.className = 'bde-rail-group-body';

    items.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'bde-rail-item' + (s.id === BDE_ACTIVE_SESSION_ID ? ' active' : '');
      var titleEl = document.createElement('div');
      titleEl.className = 'bde-rail-item-title';
      titleEl.textContent = s.title || 'New analysis';
      if (s.id === BDE_EXAMPLE_SESSION_ID) {
        var badge = document.createElement('span');
        badge.className = 'bde-rail-item-badge';
        badge.textContent = 'EXAMPLE';
        titleEl.appendChild(badge);
      }
      var metaEl = document.createElement('div');
      metaEl.className = 'bde-rail-item-meta';
      metaEl.textContent = bdeFormatSessionMeta(s.updatedAt);
      item.appendChild(titleEl);
      item.appendChild(metaEl);
      item.addEventListener('click', function () { bdeSwitchSession(s.id); });
      body.appendChild(item);
    });

    groupEl.appendChild(header);
    groupEl.appendChild(body);
    list.appendChild(groupEl);
  });
}

function bdeCaptureEmptyStateTemplate() {
  var el = document.getElementById('bdeEmptyState');
  if (el) BDE_EMPTY_STATE_HTML = el.outerHTML;
}

function bdeShowEmptyState() {
  var thread = document.getElementById('bdeThread');
  if (thread && BDE_EMPTY_STATE_HTML) thread.innerHTML = BDE_EMPTY_STATE_HTML;
}

function bdeClearThread() {
  var thread = document.getElementById('bdeThread');
  if (thread) thread.innerHTML = '';
}

function bdeLoadSessionIntoThread(id) {
  bdeClearThread();
  return bdeApiGetMessages(id).then(function (messages) {
    if (!messages || messages.length === 0) {
      bdeShowEmptyState();
    } else {
      messages.forEach(function (m, i) {
        if (m.role === 'user') {
          bdeAppendUserMessage(m.content, m.createdAt);
        } else {
          var prev = messages[i - 1];
          var elapsed = (prev && prev.role === 'user')
            ? (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime())
            : null;
          bdeAppendAgentMessage(m.content, m.createdAt, elapsed);
        }
      });
    }
  }).catch(function () {
    bdeShowEmptyState();
  });
}

function bdeSwitchSession(id) {
  if (id === BDE_ACTIVE_SESSION_ID) return;
  BDE_ACTIVE_SESSION_ID = id;
  bdeRenderSessionList(BDE_SESSIONS_CACHE);
  bdeLoadSessionIntoThread(id);
}

function bdeNewAnalysis() {
  bdeApiCreateSession().then(function (s) {
    BDE_SESSIONS_CACHE.unshift(s);
    BDE_ACTIVE_SESSION_ID = s.id;
    bdeRenderSessionList(BDE_SESSIONS_CACHE);
    bdeClearThread();
    bdeShowEmptyState();
  });
}

function bdeRefreshSessionList() {
  bdeApiListSessions().then(function (sessions) {
    BDE_SESSIONS_CACHE = sessions || [];
    bdeRenderSessionList(BDE_SESSIONS_CACHE);
  });
}

// Demo-mode equivalent of the server setting a session's title from its first
// message and bumping it to the top of the list — kept separate from
// bdeRefreshSessionList so demo mode never needs a real fetch.
function bdeTouchDemoSession(id, firstQueryMaybe) {
  var idx = BDE_DEMO_SESSIONS.findIndex(function (s) { return s.id === id; });
  if (idx === -1) return;
  var s = BDE_DEMO_SESSIONS[idx];
  if (!s.title || s.title === 'New analysis') {
    s.title = firstQueryMaybe.length > 60 ? firstQueryMaybe.slice(0, 60) + '…' : firstQueryMaybe;
  }
  s.updatedAt = new Date().toISOString();
  BDE_DEMO_SESSIONS.splice(idx, 1);
  BDE_DEMO_SESSIONS.unshift(s);
  bdeRenderSessionList(BDE_DEMO_SESSIONS);
}

// A permanent, clearly-labeled example conversation — real verified data
// (Vodafone Treasury UK / BMW Group Deposits), not live agent output, so
// there's always a rich reference example to demo without a live call.
var BDE_EXAMPLE_SESSION_ID = 'example-vodafone-bmw';

function bdeExampleMessages() {
  var base = Date.now() - (3 * 24 * 60 + 20) * 60000; // staggered timestamps, ~3 days ago
  var t = function (offsetMin) { return new Date(base + offsetMin * 60000).toISOString(); };

  var capabilityReply = JSON.stringify({
    blocks: [
      { type: 'text', title: 'What I can help you analyze',
        body: "I work from a Barclays Agent KB containing pre-computed deposit summaries for individual corporate customers, plus a shared central bank rate events page covering multiple countries. For any named company I can retrieve its summary page and tell you: latest balance and its range over the observation window (in its own currency), the operational vs surplus split and whether operational share is rising, falling or stable, the latest applied rate and how many rate changes occurred, the rate-change responsiveness (30-day balance move after a rate change vs a baseline 30-day move), and the policy-to-customer lag in days. I can also compare two or more named companies side-by-side. What I can't do: compute new statistics from raw transactions, or draw a daily time-series chart — only a cross-company elasticity comparison." },
      { type: 'suggestions', items: ['Provide more detail for Vodafone Treasury UK', 'Compare Vodafone with BMW on rate sensitivity', 'Show UK central bank rate events'] }
    ],
    data: {}
  });

  var comparisonReply = JSON.stringify({
    blocks: [
      { type: 'text', title: 'Rate sensitivity — Vodafone Treasury UK vs BMW Group Deposits (GBP)',
        body: "Vodafone's GBP account moved 1.73% of its latest balance over 30 days following a rate change, well above its 0.45% baseline drift. BMW's GBP account moved 0.50% following a rate change against a 0.23% baseline — both are responsive, but Vodafone's balance reacts about 3.5x more, proportionally, than BMW's. Policy lag also differs sharply: Vodafone's applied rate typically follows a Bank of England move within 5 days; BMW's follows the nearest Germany/ECB move within 19 days." },
        { type: 'chart', chart: 'elasticityScatter', source: 'summary' },
      { type: 'table', source: 'summary', columns: ['customerName', 'currency', 'response30dPct', 'baseline30dPct', 'policyLagDays'], showRows: 2 },
      { type: 'insight', body: 'Vodafone is the more rate-sensitive of the two GBP accounts — worth prioritising for surplus repricing conversations ahead of BMW\u2019s GBP account.' },
      { type: 'suggestions', items: ['Show BMW\u2019s EUR and USD accounts too', 'Which other GBP accounts are most responsive?', 'Show UK central bank rate events'] }
    ],
    data: {
      summary: [
        { customerName: 'Vodafone Treasury UK', currency: 'GBP', response30dPct: 1.73, baseline30dPct: 0.45, policyLagDays: 5, sourcePage: 'Vodafone_Treasury_UK.md' },
        { customerName: 'BMW Group Deposits', currency: 'GBP', response30dPct: 0.50, baseline30dPct: 0.23, policyLagDays: 19, sourcePage: 'BMW_Group_Deposits.md' }
      ]
    }
  });

  return [
    { role: 'user', content: 'What sort of analysis can you provide?', createdAt: t(0) },
    { role: 'agent', content: capabilityReply, createdAt: t(0.3) },
    { role: 'user', content: 'Provide more detail for Vodafone Treasury UK. What was the before / after rate?', createdAt: t(2) },
    { role: 'agent', content: bdeDemoPayload(), createdAt: t(2.4) },
    { role: 'user', content: 'How does Vodafone compare to BMW\u2019s GBP account on rate sensitivity?', createdAt: t(5) },
    { role: 'agent', content: comparisonReply, createdAt: t(5.3) }
  ];
}

function bdeSeedExampleSession() {
  if (BDE_DEMO_SESSIONS.some(function (s) { return s.id === BDE_EXAMPLE_SESSION_ID; })) return;
  var messages = bdeExampleMessages();
  var last = messages[messages.length - 1];
  BDE_DEMO_SESSIONS.push({
    id: BDE_EXAMPLE_SESSION_ID,
    title: 'Example: Vodafone vs BMW rate sensitivity',
    createdAt: messages[0].createdAt,
    updatedAt: last.createdAt
  });
  BDE_DEMO_MESSAGES[BDE_EXAMPLE_SESSION_ID] = messages;
}

function bdeInitSessions() {
  bdeCaptureEmptyStateTemplate();
  bdeSeedExampleSession(); // always available — it's local-only, never touches the real backend
  return bdeApiListSessions().then(function (sessions) {
    sessions = sessions || [];
    var hasRealSession = sessions.some(function (s) { return s.id !== BDE_EXAMPLE_SESSION_ID; });
    if (!hasRealSession) {
      return bdeApiCreateSession().then(function (s) { return sessions.concat([s]); });
    }
    return sessions;
  }).then(function (sessions) {
    BDE_SESSIONS_CACHE = sessions.slice().sort(function (a, b) { return b.updatedAt.localeCompare(a.updatedAt); });
    // Default view is the most recent real (non-example) session — the
    // example stays reachable in the rail without hijacking the fresh load.
    var defaultSession = BDE_SESSIONS_CACHE.find(function (s) { return s.id !== BDE_EXAMPLE_SESSION_ID; });
    BDE_ACTIVE_SESSION_ID = (defaultSession || BDE_SESSIONS_CACHE[0]).id;
    bdeRenderSessionList(BDE_SESSIONS_CACHE);
    return bdeLoadSessionIntoThread(BDE_ACTIVE_SESSION_ID);
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

document.addEventListener('DOMContentLoaded', function () {
  bdeInitInput();
  bdeInitSessions();
});
