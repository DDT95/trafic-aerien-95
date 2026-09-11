/* global L */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('fr-FR');
  const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 8, maxZoom: 15 }).setView([49.07, 2.10], 10);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  const bounds95 = L.latLngBounds([48.86, 1.60], [49.25, 2.60]);
  const canvas = L.canvas({ padding: .5 });
  const territoryLayer = L.geoJSON(null, {
    style: { color: '#070047', weight: 2.2, fillColor: '#000091', fillOpacity: .025, interactive: false }
  }).addTo(map);
  const trackLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const densityLayer = L.layerGroup().addTo(map);

  let index = null;
  let day = null;
  let mode = 'tracks';
  let playing = false;
  let timer = null;
  let renderTimer = null;

  const band = (alt) => {
    if (!Number.isFinite(alt) || alt < 3000) return 'lt3000';
    if (alt < 10000) return '3000-10000';
    if (alt < 20000) return '10000-20000';
    return 'gte20000';
  };
  const colors = { lt3000: '#d64b57', '3000-10000': '#e68a2e', '10000-20000': '#188ca3', gte20000: '#7656a8' };
  const altitudeText = (ft) => Number.isFinite(ft) ? `${fmt.format(Math.round(ft))} ft · ${fmt.format(Math.round(ft * .3048))} m` : 'Non transmise';
  const timeText = (seconds) => {
    const total = Math.max(0, Math.min(86400, Math.round(seconds)));
    return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`;
  };
  const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

  fetch('data/communes95.geojson').then(r => r.json()).then(g => {
    territoryLayer.addData(g);
    map.fitBounds(territoryLayer.getBounds(), { padding: [22, 22] });
  }).catch(() => map.fitBounds(bounds95));

  async function readJson(file) {
    const response = await fetch(`${file}?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!file.endsWith('.gz')) return response.json();
    if (!('DecompressionStream' in window)) throw new Error('Décompression gzip non prise en charge');
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  async function loadIndex() {
    try {
      index = await readJson('data/index.json');
      const select = $('daySelect');
      select.innerHTML = '';
      if (!index.days?.length) {
        select.innerHTML = '<option>Première journée en préparation</option>';
        showEmpty('Première journée en préparation', 'Le traitement automatique récupère les archives ADS-B mondiales, puis ne conserve que les trajectoires qui traversent le Val-d’Oise. Rechargez la page un peu plus tard.');
        setState('Préparation en cours', 'Archive quotidienne ADSB.lol', '');
        return;
      }
      index.days.forEach(item => {
        const option = document.createElement('option');
        option.value = item.date;
        option.textContent = item.label || new Date(`${item.date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        if (item.date === index.latest) option.selected = true;
        select.append(option);
      });
      select.addEventListener('change', () => loadDay(select.value));
      await loadDay(select.value);
    } catch (error) {
      showEmpty('Données momentanément indisponibles', 'La structure de la carte est prête, mais le fichier quotidien n’a pas pu être chargé.');
      setState('Données indisponibles', 'Réessayez dans quelques instants', 'error');
    }
  }

  async function loadDay(date) {
    stop();
    setState('Chargement de la journée', date, '');
    $('mapStatus').textContent = 'Chargement des trajectoires…';
    try {
      const meta = index.days.find(d => d.date === date);
      day = await readJson(meta.file || `data/days/${date}.json.gz`);
      hideEmpty();
      $('time').value = 1440;
      syncClock();
      updateKpis();
      $('daySummary').textContent = `${fmt.format(day.stats.passages)} passages reconstitués à partir de ${fmt.format(day.stats.positions)} positions ADS-B retenues.`;
      setState('Journée complète', `Mise à jour ${new Date(day.generated_at).toLocaleDateString('fr-FR')}`, 'ready');
      render();
    } catch (error) {
      showEmpty('Journée non chargée', 'Le fichier a peut-être été généré il y a quelques secondes. Rechargez la page pour réessayer.');
      setState('Traitement incomplet', date, 'error');
    }
  }

  function setState(title, subtitle, type) {
    const box = $('dataState');
    box.className = `data-state ${type || ''}`;
    box.querySelector('strong').textContent = title;
    box.querySelector('small').textContent = subtitle;
  }

  function showEmpty(title, text) {
    hideEmpty();
    const node = document.createElement('div');
    node.className = 'empty-state'; node.id = 'emptyState';
    node.innerHTML = `<b>${esc(title)}</b><p>${esc(text)}</p>`;
    document.querySelector('.map-shell').append(node);
  }
  function hideEmpty() { $('emptyState')?.remove(); }

  function updateKpis() {
    const s = day.stats;
    $('kpiPassages').textContent = fmt.format(s.passages);
    $('kpiAircraft').textContent = fmt.format(s.aircraft);
    $('kpiLow').textContent = fmt.format(s.low);
    $('kpiPeak').textContent = `${String(s.peak_hour).padStart(2, '0')}–${String((s.peak_hour + 1) % 24).padStart(2, '0')} h`;
    $('kpiPoints').textContent = fmt.format(s.positions);
  }

  function selectedBands() {
    return new Set([...document.querySelectorAll('.altitudes input:checked')].map(i => i.value));
  }

  function visibleTracks() {
    if (!day) return [];
    const maxSec = Number($('time').value) * 60;
    const cumulative = $('cumulative').checked;
    const bands = selectedBands();
    return day.tracks.filter(t => {
      if (!bands.has(band(t.min_alt))) return false;
      if (mode === 'low' && !(t.min_alt < 5000)) return false;
      return cumulative ? t.first <= maxSec : (t.first <= maxSec + 900 && t.last >= maxSec - 900);
    });
  }

  function render() {
    if (!day) return;
    trackLayer.clearLayers(); markerLayer.clearLayers(); densityLayer.clearLayers();
    const tracks = visibleTracks();
    const maxSec = Number($('time').value) * 60;
    const cumulative = $('cumulative').checked;
    if (mode === 'density') renderDensity(tracks, maxSec, cumulative);
    else renderTracks(tracks, maxSec, cumulative);
    const label = mode === 'density' ? 'mailles visibles' : 'passages visibles';
    $('mapStatus').textContent = `${fmt.format(tracks.length)} ${label} · ${timeText(maxSec)}`;
    updateLegend();
  }

  function renderTracks(tracks, maxSec, cumulative) {
    const endOfDay = maxSec >= 86400;
    tracks.forEach(t => {
      let points = t.points;
      if (!endOfDay) points = cumulative ? points.filter(p => p[0] <= maxSec) : points.filter(p => Math.abs(p[0] - maxSec) <= 900);
      if (points.length < 2) return;
      const color = colors[band(t.min_alt)];
      const line = L.polyline(points.map(p => [p[1], p[2]]), {
        renderer: canvas, color, weight: mode === 'low' ? 3 : 1.8, opacity: mode === 'low' ? .82 : .54, className: 'flight-path'
      }).addTo(trackLayer);
      line.on('click', () => openFlight(t));
      line.bindTooltip(`${esc(t.flight || t.reg || t.hex)} · min. ${altitudeText(t.min_alt)}`, { sticky: true });
      if (!endOfDay && points.length) {
        const p = points[points.length - 1];
        const marker = L.marker([p[1], p[2]], { icon: L.divIcon({ className: '', html: `<div class="plane-marker" style="transform:rotate(${Number(p[5]) || 0}deg)">✈</div>`, iconSize: [22,22], iconAnchor:[11,11] }) }).addTo(markerLayer);
        marker.on('click', () => openFlight(t));
      }
    });
  }

  function renderDensity(tracks, maxSec, cumulative) {
    const cells = new Map();
    tracks.forEach(t => t.points.forEach(p => {
      if (p[0] > maxSec || (!cumulative && Math.abs(p[0] - maxSec) > 900)) return;
      const y = Math.round(p[1] / .018) * .018;
      const x = Math.round(p[2] / .028) * .028;
      const key = `${y.toFixed(3)}|${x.toFixed(3)}`;
      const cell = cells.get(key) || { lat: y, lon: x, count: 0 };
      cell.count += 1; cells.set(key, cell);
    }));
    const max = Math.max(1, ...[...cells.values()].map(c => c.count));
    cells.forEach(c => {
      const q = c.count / max;
      const color = q > .66 ? '#d64b57' : q > .33 ? '#e68a2e' : q > .12 ? '#ffd66b' : '#4ba7aa';
      L.circleMarker([c.lat, c.lon], { renderer: canvas, radius: 4 + 13 * Math.sqrt(q), color: '#fff', weight: .5, fillColor: color, fillOpacity: .68, className: 'density-cell' })
        .bindTooltip(`${fmt.format(c.count)} positions observées dans cette maille`).addTo(densityLayer);
    });
  }

  function openFlight(t) {
    $('flightTitle').textContent = t.flight || t.reg || t.hex.toUpperCase();
    $('flightSubtitle').textContent = [t.desc, t.operator].filter(Boolean).join(' · ') || 'Informations aéronef non transmises';
    const facts = [
      ['Immatriculation', t.reg || 'Non transmise'], ['Identifiant ICAO', t.hex.toUpperCase()],
      ['Début du passage', timeText(t.first)], ['Fin du passage', timeText(t.last)],
      ['Altitude minimale', altitudeText(t.min_alt)], ['Altitude maximale', altitudeText(t.max_alt)],
      ['Vitesse maximale', Number.isFinite(t.max_speed) ? `${fmt.format(Math.round(t.max_speed))} kt` : 'Non transmise'],
      ['Positions retenues', fmt.format(t.points.length)]
    ];
    $('flightFacts').innerHTML = facts.map(([k,v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    $('flightPanel').classList.add('open'); $('flightPanel').setAttribute('aria-hidden', 'false');
  }

  function updateLegend() {
    $('legend').innerHTML = mode === 'density'
      ? '<strong>Densité des positions</strong><span><i style="background:#4ba7aa"></i>Faible</span><span><i style="background:#ffd66b"></i>Intermédiaire</span><span><i style="background:#d64b57"></i>Forte</span>'
      : '<strong>Altitude minimale du passage</strong><span><i style="background:#d64b57"></i>&lt; 3 000 ft</span><span><i style="background:#e68a2e"></i>3 000–10 000 ft</span><span><i style="background:#188ca3"></i>10 000–20 000 ft</span><span><i style="background:#7656a8"></i>≥ 20 000 ft</span>';
  }

  function syncClock() { $('clock').textContent = timeText(Number($('time').value) * 60); }
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 45); }
  function stop() { playing = false; clearInterval(timer); $('play').textContent = '▶'; }
  function togglePlay() {
    if (playing) return stop();
    if (Number($('time').value) >= 1440) $('time').value = 0;
    playing = true; $('play').textContent = '❚❚';
    timer = setInterval(() => {
      const next = Number($('time').value) + 10;
      if (next > 1440) return stop();
      $('time').value = next; syncClock(); render();
    }, 220);
  }

  document.querySelectorAll('.mode').forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.mode;
    document.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b === button));
    render();
  }));
  document.querySelectorAll('.altitudes input').forEach(input => input.addEventListener('change', render));
  $('allAlt').addEventListener('click', () => { document.querySelectorAll('.altitudes input').forEach(i => { i.checked = true; }); render(); });
  $('time').addEventListener('input', () => { syncClock(); scheduleRender(); });
  $('cumulative').addEventListener('change', render);
  $('play').addEventListener('click', togglePlay);
  $('resetMap').addEventListener('click', () => territoryLayer.getBounds().isValid() ? map.fitBounds(territoryLayer.getBounds(), { padding: [22,22] }) : map.fitBounds(bounds95));
  $('closeFlight').addEventListener('click', () => { $('flightPanel').classList.remove('open'); $('flightPanel').setAttribute('aria-hidden', 'true'); });
  $('openMethod').addEventListener('click', () => $('methodDialog').showModal());
  $('closeMethod').addEventListener('click', () => $('methodDialog').close());
  $('mobileData').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('sheetHandle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  updateLegend(); loadIndex();
})();
