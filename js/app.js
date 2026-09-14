/* global L */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('fr-FR');
  const MOVEMENT_COLOR = { departure: '#0063cb', arrival: '#e1000f' };
  const AIRPORTS = [
    { id: 'CDG', name: 'Paris–Charles-de-Gaulle', lat: 49.010, lon: 2.580, radius: 4.8, anchors: [[49.020, 2.515], [49.001, 2.565], [49.018, 2.625], [49.002, 2.665]] },
    { id: 'POX', name: 'Pontoise–Cormeilles', lat: 49.0966, lon: 2.0408, radius: 5 },
    { id: 'LFPA', name: 'Persan–Beaumont', lat: 49.1658, lon: 2.3117, radius: 5 },
    { id: 'LFFE', name: 'Enghien–Moisselles', lat: 49.0464, lon: 2.3531, radius: 4 },
    { id: 'LFFC', name: 'Chérence', lat: 49.0789, lon: 1.6894, radius: 4 }
  ];
  const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 8, maxZoom: 15 }).setView([49.07, 2.10], 10);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

  const bounds95 = L.latLngBounds([48.86, 1.60], [49.25, 2.60]);
  const canvas = L.canvas({ padding: .5 });
  const territoryLayer = L.geoJSON(null, { style: { color: '#070047', weight: 2.6, fillColor: '#000091', fillOpacity: .045, interactive: false } }).addTo(map);
  map.createPane('pebPane');
  map.getPane('pebPane').style.zIndex = 350;
  map.getPane('pebPane').style.pointerEvents = 'none';
  const pebColors = { A: '#c9191e', B: '#e8590c', C: '#d6a700', D: '#6666c7' };
  const pebLayer = L.geoJSON(null, { pane: 'pebPane', interactive: false, style: f => ({ color: pebColors[f.properties.ZONE], fillColor: pebColors[f.properties.ZONE], weight: 1.8, opacity: .9, fillOpacity: f.properties.ZONE === 'D' ? .10 : .18 }) });
  const airportLayer = L.layerGroup().addTo(map);
  const haloLayer = L.layerGroup().addTo(map);
  const trackLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const densityLayer = L.layerGroup().addTo(map);
  const liveTrailLayer = L.layerGroup();
  const liveMarkerLayer = L.layerGroup();

  let index = null;
  let day = null;
  let mode = 'tracks';
  let playing = false;
  let timer = null;
  let renderTimer = null;
  let viewKind = 'daily';
  let liveTimer = null;
  let movingLive = [];
  const liveHistory = new Map();
  let routeRequest = 0;
  const routeCache = new Map();

  const altitudeText = (ft) => Number.isFinite(ft) ? `${fmt.format(Math.round(ft))} ft · ${fmt.format(Math.round(ft * .3048))} m` : 'Non transmise';
  const timeText = (seconds) => {
    const total = Math.max(0, Math.min(86400, Math.round(seconds)));
    return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`;
  };
  const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const movementText = (m) => m === 'arrival' ? 'Atterrissage' : m === 'departure' ? 'Décollage' : 'Mouvement à confirmer';
  const airportById = (id) => AIRPORTS.find(a => a.id === id);

  function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const p1 = a[0] * rad; const p2 = b[0] * rad;
    const dp = (b[0] - a[0]) * rad; const dl = (b[1] - a[1]) * rad;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }

  function nearestAirport(point) {
    let best = null;
    AIRPORTS.forEach(airport => {
      const anchors = airport.anchors || [[airport.lat, airport.lon]];
      const distance = Math.min(...anchors.map(a => distanceKm([point[1], point[2]], a)));
      if (!best || distance < best.distance) best = { airport, distance };
    });
    return best;
  }

  function classifyTrack(track) {
    if (track.movement && track.airport) return track;
    const points = track.points || [];
    const altitudes = points.map(p => p[3]).filter(Number.isFinite);
    if (points.length < 2 || !altitudes.length) return null;
    const first = nearestAirport(points[0]);
    const last = nearestAirport(points[points.length - 1]);
    const firstAlt = points.slice(0, 4).map(p => p[3]).filter(Number.isFinite);
    const lastAlt = points.slice(-4).map(p => p[3]).filter(Number.isFinite);
    const high = Math.max(...altitudes);
    const departure = firstAlt.length && first.distance <= first.airport.radius && Math.min(...firstAlt) <= 3000 && high - Math.min(...firstAlt) >= 1000;
    const arrival = lastAlt.length && last.distance <= last.airport.radius && Math.min(...lastAlt) <= 3000 && high - Math.min(...lastAlt) >= 1000;
    if (!departure && !arrival) return null;
    const selected = arrival ? last : first;
    return { ...track, movement: arrival ? 'arrival' : 'departure', airport: selected.airport.id };
  }

  function prepareDay(raw) {
    const tracks = raw.tracks.map(classifyTrack).filter(Boolean);
    const hourly = Array(24).fill(0);
    tracks.forEach(t => { hourly[Math.min(23, Math.max(0, Math.floor(t.first / 3600)))] += 1; });
    const peakHour = tracks.length ? hourly.indexOf(Math.max(...hourly)) : 12;
    return { ...raw, tracks, stats: {
      movements: tracks.length,
      departures: tracks.filter(t => t.movement === 'departure').length,
      arrivals: tracks.filter(t => t.movement === 'arrival').length,
      aircraft: new Set(tracks.map(t => t.hex)).size,
      positions: tracks.reduce((n, t) => n + t.points.length, 0),
      peak_hour: peakHour,
      hourly
    } };
  }

  fetch('data/communes95.geojson').then(r => r.json()).then(g => {
    territoryLayer.addData(g);
    map.fitBounds(territoryLayer.getBounds(), { padding: [22, 22] });
  }).catch(() => map.fitBounds(bounds95));

  fetch('data/peb-cdg.geojson').then(r => r.json()).then(g => pebLayer.addData(g)).catch(() => {
    $('pebToggle').disabled = true;
    document.querySelector('.layer-switch small').textContent = 'Couche momentanément indisponible';
  });

  AIRPORTS.forEach(airport => {
    const icon = L.divIcon({ className: '', html: `<div class="airport-marker">${airport.id}</div>`, iconSize: [29, 29], iconAnchor: [15, 15] });
    L.marker([airport.lat, airport.lon], { icon, zIndexOffset: -100 }).bindTooltip(airport.name, { permanent: true, direction: 'right', className: 'airport-name', offset: [12, 0] }).addTo(airportLayer);
  });

  async function readJson(file) {
    const response = await fetch(`${file}?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!file.endsWith('.gz')) return response.json();
    if (!('DecompressionStream' in window)) throw new Error('Décompression gzip non prise en charge');
    return JSON.parse(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text());
  }

  async function loadIndex() {
    try {
      index = await readJson('data/index.json');
      // Older files were built with the former department-crossing rule and
      // undercount arrivals. Keep them hidden rather than publish biased days.
      index.days = (index.days || []).filter(item => Number.isFinite(item.stats?.arrivals) && Number.isFinite(item.stats?.departures));
      const select = $('daySelect'); select.innerHTML = '';
      if (!index.days?.length) {
        select.innerHTML = '<option>Première journée en préparation</option>';
        showEmpty('Première journée en préparation', 'Le traitement automatique récupère les archives ADS-B puis recherche les mouvements des aérodromes du Val-d’Oise.');
        return setState('Préparation en cours', 'Archive quotidienne ADSB.lol', '');
      }
      index.days.forEach(item => {
        const option = document.createElement('option'); option.value = item.date;
        option.textContent = item.label || new Date(`${item.date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        if (item.date === index.latest) option.selected = true;
        select.append(option);
      });
      select.addEventListener('change', () => loadDay(select.value));
      await loadDay(select.value);
    } catch (error) {
      showEmpty('Données momentanément indisponibles', 'Le fichier quotidien n’a pas pu être chargé.');
      setState('Données indisponibles', 'Réessayez dans quelques instants', 'error');
    }
  }

  async function loadDay(date) {
    stop(); setState('Chargement de la journée', date, ''); $('mapStatus').textContent = 'Filtrage des mouvements…';
    try {
      const meta = index.days.find(d => d.date === date);
      day = prepareDay(await readJson(meta.file || `data/days/${date}.json.gz`));
      hideEmpty(); populateAirports();
      $('cumulative').checked = false;
      $('time').value = Math.min(1435, day.stats.peak_hour * 60 + 30);
      syncClock(); updateKpis();
      $('daySummary').textContent = `${fmt.format(day.stats.movements)} décollages et atterrissages identifiés à partir de ${fmt.format(day.stats.positions)} positions ADS-B.`;
      setState('Mouvements filtrés', `Journée du ${new Date(`${day.date}T12:00:00`).toLocaleDateString('fr-FR')}`, 'ready');
      render();
    } catch (error) {
      showEmpty('Journée non chargée', 'Le fichier a peut-être été généré il y a quelques secondes. Rechargez la page pour réessayer.');
      setState('Traitement incomplet', date, 'error');
    }
  }

  function populateAirports() {
    const select = $('airportSelect'); const previous = select.value || 'all';
    select.innerHTML = '<option value="all">Tous les aérodromes</option>';
    AIRPORTS.filter(a => day.tracks.some(t => t.airport === a.id)).forEach(a => {
      const option = document.createElement('option'); option.value = a.id; option.textContent = `${a.id} · ${a.name}`; select.append(option);
    });
    select.value = [...select.options].some(o => o.value === previous) ? previous : 'all';
  }

  function setState(title, subtitle, type) {
    const box = $('dataState'); box.className = `data-state ${type || ''}`;
    box.querySelector('strong').textContent = title; box.querySelector('small').textContent = subtitle;
  }
  function showEmpty(title, text) {
    hideEmpty(); const node = document.createElement('div'); node.className = 'empty-state'; node.id = 'emptyState';
    node.innerHTML = `<b>${esc(title)}</b><p>${esc(text)}</p>`; document.querySelector('.map-shell').append(node);
  }
  function hideEmpty() { $('emptyState')?.remove(); }

  function updateKpis() {
    const s = day.stats;
    $('kpiPassagesLabel').textContent = 'mouvements retenus';
    $('kpiAircraftLabel').textContent = 'décollages observés';
    $('kpiLowLabel').textContent = 'atterrissages observés';
    $('kpiPeakLabel').textContent = 'heure la plus chargée';
    $('kpiPointsLabel').textContent = 'aéronefs distincts';
    $('kpiPassages').textContent = fmt.format(s.movements);
    $('kpiAircraft').textContent = fmt.format(s.departures);
    $('kpiLow').textContent = fmt.format(s.arrivals);
    $('kpiPeak').textContent = `${String(s.peak_hour).padStart(2, '0')}–${String((s.peak_hour + 1) % 24).padStart(2, '0')} h`;
    $('kpiPoints').textContent = fmt.format(s.aircraft);
  }

  function visibleTracks() {
    if (!day) return [];
    const maxSec = Number($('time').value) * 60;
    const cumulative = $('cumulative').checked;
    const movements = new Set([...document.querySelectorAll('.movement-filters input:checked')].map(i => i.value));
    const airport = $('airportSelect').value;
    const windowSec = Number($('windowSelect').value) * 60;
    return day.tracks.filter(t => movements.has(t.movement) && (airport === 'all' || t.airport === airport) && (cumulative ? t.first <= maxSec : (t.first <= maxSec + windowSec && t.last >= maxSec - windowSec)));
  }

  function render() {
    if (!day || viewKind !== 'daily') return;
    haloLayer.clearLayers(); trackLayer.clearLayers(); markerLayer.clearLayers(); densityLayer.clearLayers();
    const tracks = visibleTracks(); const maxSec = Number($('time').value) * 60; const cumulative = $('cumulative').checked;
    if (mode === 'density') renderDensity(tracks, maxSec, cumulative); else renderTracks(tracks, maxSec, cumulative);
    $('mapStatus').textContent = `${fmt.format(tracks.length)} mouvements visibles · ${timeText(maxSec)}${cumulative ? ' · bilan cumulé' : ` · fenêtre ${Number($('windowSelect').value) * 2} min`}`;
    updateLegend();
  }

  function pointHeading(points, index) {
    if (Number.isFinite(points[index][5])) return points[index][5];
    const a = points[Math.max(0, index - 1)]; const b = points[index];
    const y = Math.sin((b[2] - a[2]) * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180);
    const x = Math.cos(a[1] * Math.PI / 180) * Math.sin(b[1] * Math.PI / 180) - Math.sin(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.cos((b[2] - a[2]) * Math.PI / 180);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function planeSvg() {
    return '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M16 1c2 0 3 3 3 6v5l10 6v4l-10-3v7l4 3v2l-7-2-7 2v-2l4-3v-7L3 22v-4l10-6V7c0-3 1-6 3-6Z"/></svg>';
  }

  function renderTracks(tracks, maxSec, cumulative) {
    tracks.forEach(t => {
      const windowSec = Number($('windowSelect').value) * 60;
      let points = cumulative ? t.points.filter(p => p[0] <= maxSec) : t.points.filter(p => Math.abs(p[0] - maxSec) <= windowSec);
      if (points.length < 2) return;
      const latlngs = points.map(p => [p[1], p[2]]); const color = MOVEMENT_COLOR[t.movement];
      L.polyline(latlngs, { renderer: canvas, color: '#fff', weight: 6, opacity: .78, interactive: false }).addTo(haloLayer);
      const line = L.polyline(latlngs, { renderer: canvas, color, weight: 3.1, opacity: .9, className: 'flight-path' }).addTo(trackLayer);
      line.on('click', () => openFlight(t));
      line.bindTooltip(`${movementText(t.movement)} · ${esc(airportById(t.airport)?.name || t.airport)} · ${esc(t.flight || t.reg || t.hex)}`, { sticky: true });
      if (!cumulative) {
        const i = points.length - 1; const p = points[i]; const heading = pointHeading(points, i);
        const icon = L.divIcon({ className: '', html: `<div class="plane-marker ${t.movement}" style="transform:rotate(${heading}deg)">${planeSvg()}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
        L.marker([p[1], p[2]], { icon, zIndexOffset: 500 }).on('click', () => openFlight(t)).addTo(markerLayer);
      }
    });
  }

  function renderDensity(tracks, maxSec, cumulative) {
    const cells = new Map();
    const windowSec = Number($('windowSelect').value) * 60;
    tracks.forEach(t => t.points.forEach(p => {
      if (p[0] > maxSec || (!cumulative && Math.abs(p[0] - maxSec) > windowSec)) return;
      const y = Math.round(p[1] / .018) * .018; const x = Math.round(p[2] / .028) * .028; const key = `${y.toFixed(3)}|${x.toFixed(3)}`;
      const cell = cells.get(key) || { lat: y, lon: x, count: 0 }; cell.count += 1; cells.set(key, cell);
    }));
    const max = Math.max(1, ...[...cells.values()].map(c => c.count));
    cells.forEach(c => {
      const q = c.count / max; const color = q > .66 ? '#e1000f' : q > .33 ? '#e68a2e' : q > .12 ? '#ffd66b' : '#4ba7aa';
      L.circleMarker([c.lat, c.lon], { renderer: canvas, radius: 4 + 13 * Math.sqrt(q), color: '#fff', weight: .7, fillColor: color, fillOpacity: .76 }).bindTooltip(`${fmt.format(c.count)} positions observées`).addTo(densityLayer);
    });
  }

  function renderFlightFacts(facts) {
    $('flightFacts').innerHTML = facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  }

  function airportRouteText(value) {
    if (!value) return 'Non disponible';
    const code = value.iata_code || value.icao_code;
    return [code, value.municipality, value.name].filter(Boolean).join(' · ');
  }

  async function loadFlightRoute(t, facts, requestId) {
    const callsign = String(t.flight || '').trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (callsign.length < 3) {
      $('routeNote').textContent = 'Provenance et destination indisponibles : aucun indicatif de vol exploitable.';
      return;
    }
    $('routeNote').textContent = 'Recherche de la provenance et de la destination…';
    try {
      let route = routeCache.get(callsign);
      if (!route) {
        const response = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        route = (await response.json())?.response?.flightroute;
        if (!route) throw new Error('Route absente');
        routeCache.set(callsign, route);
      }
      if (requestId !== routeRequest) return;
      renderFlightFacts([
        ['Provenance prévue', airportRouteText(route.origin)], ['Destination prévue', airportRouteText(route.destination)],
        ['Compagnie', route.airline?.name || t.operator || 'Non disponible'], ...facts
      ]);
      $('flightSubtitle').textContent = `${movementText(t.movement)} · ${route.airline?.name || airportById(t.airport)?.name || t.airport}`;
      $('routeNote').textContent = 'Itinéraire indicatif associé à l’indicatif de vol · Source ADSBDB.';
    } catch (error) {
      if (requestId === routeRequest) $('routeNote').textContent = 'Provenance et destination non trouvées pour cet indicatif.';
    }
  }

  function openFlight(t) {
    const requestId = ++routeRequest;
    const airport = airportById(t.airport);
    $('flightTitle').textContent = t.flight || t.reg || t.hex.toUpperCase();
    $('flightSubtitle').textContent = `${movementText(t.movement)} · ${airport?.name || t.airport}`;
    const facts = [
      ['Mouvement', movementText(t.movement)], ['Aérodrome', airport?.name || t.airport],
      ['Immatriculation', t.reg || 'Non transmise'], ['Identifiant ICAO', t.hex.toUpperCase()],
      ['Début', timeText(t.first)], ['Fin', timeText(t.last)],
      ['Altitude minimale', altitudeText(t.min_alt)], ['Altitude maximale', altitudeText(t.max_alt)],
      ['Vitesse maximale', Number.isFinite(t.max_speed) ? `${fmt.format(Math.round(t.max_speed))} kt` : 'Non transmise'], ['Positions retenues', fmt.format(t.points.length)]
    ];
    renderFlightFacts(facts);
    $('flightPanel').classList.add('open'); $('flightPanel').setAttribute('aria-hidden', 'false');
    loadFlightRoute(t, facts, requestId);
  }

  function updateLegend() {
    const base = mode === 'density' && viewKind === 'daily'
      ? '<strong>Densité des positions</strong><span><i style="background:#4ba7aa"></i>Faible</span><span><i style="background:#ffd66b"></i>Intermédiaire</span><span><i style="background:#e1000f"></i>Forte</span>'
      : '<strong>Sens du mouvement</strong><span><i style="background:#0063cb;height:4px"></i>Décollage</span><span><i style="background:#e1000f;height:4px"></i>Atterrissage</span><span>Le nez de l’avion indique sa direction</span>';
    const peb = $('pebToggle').checked ? '<strong style="margin-top:10px">PEB Paris-CDG</strong><span><i style="background:#c9191e;height:7px"></i>Zone A · très forte</span><span><i style="background:#e8590c;height:7px"></i>Zone B · forte</span><span><i style="background:#d6a700;height:7px"></i>Zone C · modérée</span><span><i style="background:#6666c7;height:7px"></i>Zone D · faible</span>' : '';
    $('legend').innerHTML = base + peb;
  }

  function syncClock() { $('clock').textContent = timeText(Number($('time').value) * 60); }
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 45); }
  function stop() { playing = false; clearInterval(timer); $('play').textContent = '▶'; }
  function togglePlay() {
    if (playing) return stop();
    if (Number($('time').value) >= 1440) $('time').value = 0;
    $('cumulative').checked = false;
    $('animatedView').classList.add('active'); $('wholeDay').classList.remove('active');
    playing = true; $('play').textContent = '❚❚';
    timer = setInterval(() => {
      const next = Number($('time').value) + 1; if (next > 1440) return stop();
      $('time').value = next; syncClock(); render();
    }, Number($('speedSelect').value));
  }

  function setDailyDisplay(fullDay) {
    stop();
    $('cumulative').checked = fullDay;
    $('animatedView').classList.toggle('active', !fullDay);
    $('wholeDay').classList.toggle('active', fullDay);
    if (fullDay) $('time').value = 1440;
    else if (Number($('time').value) >= 1440) $('time').value = day.stats.peak_hour * 60 + 30;
    syncClock(); render();
  }

  function projectedLive(item, now) {
    const elapsed = Math.min((now - item.seenAt) / 1000, 40);
    const speedKmh = Number(item.data.gs) * 1.852; const heading = Number(item.data.track);
    if (!Number.isFinite(speedKmh) || !Number.isFinite(heading) || speedKmh < 15 || elapsed <= 0) return [item.data.lat, item.data.lon];
    const angular = ((speedKmh * elapsed) / 3600) / 6371.0088; const bearing = heading * Math.PI / 180;
    const lat1 = item.data.lat * Math.PI / 180; const lon1 = item.data.lon * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
    return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
  }

  function animateLive(now) {
    if (viewKind === 'live' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      movingLive.forEach(item => item.marker.setLatLng(projectedLive(item, now)));
    }
    requestAnimationFrame(animateLive);
  }

  function classifyLive(p) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
    if (!(48.65 <= p.lat && p.lat <= 49.45 && 1.25 <= p.lon && p.lon <= 2.80)) return null;
    const alt = p.alt_baro === 'ground' ? 0 : Number(p.alt_baro);
    if (!Number.isFinite(alt) || alt > 18000) return null;
    const nearest = nearestAirport([0, p.lat, p.lon]);
    if (nearest.distance > 35) return null;
    const rate = Number(p.baro_rate ?? p.geom_rate);
    let movement = rate < -180 ? 'arrival' : rate > 180 ? 'departure' : 'unknown';
    if (movement === 'unknown' && alt > 8000) return null;
    return { data: p, movement, airport: nearest.airport, alt, rate };
  }

  function openLiveFlight(item) {
    const p = item.data; const requestId = ++routeRequest;
    $('flightTitle').textContent = (p.flight || p.r || p.hex || 'Aéronef').trim();
    $('flightSubtitle').textContent = `${movementText(item.movement)} · position en direct`;
    const facts = [
      ['Tendance', movementText(item.movement)], ['Aérodrome proche', item.airport.name],
      ['Immatriculation', p.r || 'Non transmise'], ['Type', p.t || 'Non transmis'],
      ['Altitude', altitudeText(item.alt)], ['Vitesse sol', Number.isFinite(Number(p.gs)) ? `${fmt.format(Math.round(Number(p.gs) * 1.852))} km/h` : 'Non transmise'],
      ['Variation verticale', Number.isFinite(item.rate) ? `${item.rate > 0 ? '+' : ''}${fmt.format(Math.round(item.rate))} ft/min` : 'Non transmise'], ['Cap', Number.isFinite(Number(p.track)) ? `${Math.round(Number(p.track))}°` : 'Non transmis']
    ];
    renderFlightFacts(facts); $('flightPanel').classList.add('open'); $('flightPanel').setAttribute('aria-hidden', 'false');
    loadFlightRoute({ flight: p.flight, operator: null, airport: item.airport.id, movement: item.movement }, facts, requestId);
  }

  async function loadLive() {
    if (viewKind !== 'live') return;
    $('mapStatus').textContent = 'Actualisation du trafic en direct…';
    try {
      const response = await fetch('https://api.adsb.lol/v2/lat/49.08/lon/2.10/dist/45');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json(); const now = Date.now();
      if (viewKind !== 'live') return;
      const items = (payload.ac || []).map(classifyLive).filter(Boolean);
      liveTrailLayer.clearLayers(); liveMarkerLayer.clearLayers(); movingLive = [];
      items.forEach(item => {
        const p = item.data; const history = liveHistory.get(p.hex) || [];
        history.push({ time: now, lat: p.lat, lon: p.lon });
        const recent = history.filter(x => now - x.time < 30 * 60 * 1000).slice(-60); liveHistory.set(p.hex, recent);
        const color = MOVEMENT_COLOR[item.movement] || '#5b6474';
        if (recent.length > 1) L.polyline(recent.map(x => [x.lat, x.lon]), { renderer: canvas, color, weight: 2.4, opacity: .68, className: 'live-trail' }).addTo(liveTrailLayer);
        const icon = L.divIcon({ className: '', html: `<div class="plane-marker live-plane live-pulse ${item.movement}" style="transform:rotate(${Number(p.track) || 0}deg)">${planeSvg()}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
        const marker = L.marker([p.lat, p.lon], { icon, zIndexOffset: 600 }).bindTooltip(`${esc((p.flight || p.r || p.hex).trim())} · ${movementText(item.movement)} · ${altitudeText(item.alt)}`).on('click', () => openLiveFlight(item)).addTo(liveMarkerLayer);
        movingLive.push({ data: p, marker, seenAt: performance.now() });
      });
      const arrivals = items.filter(x => x.movement === 'arrival').length; const departures = items.filter(x => x.movement === 'departure').length;
      const stamp = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      $('kpiPassages').textContent = fmt.format(items.length); $('kpiPassagesLabel').textContent = 'mouvements probables en direct';
      $('kpiAircraft').textContent = fmt.format(departures); $('kpiAircraftLabel').textContent = 'appareils en montée';
      $('kpiLow').textContent = fmt.format(arrivals); $('kpiLowLabel').textContent = 'appareils en descente';
      $('kpiPeak').textContent = stamp.slice(0, 5); $('kpiPeakLabel').textContent = 'dernière actualisation';
      $('kpiPoints').textContent = fmt.format(items.filter(x => x.movement === 'unknown').length); $('kpiPointsLabel').textContent = 'mouvements à confirmer';
      $('liveSummary').textContent = `${items.length} appareils à basse ou moyenne altitude près des aérodromes · actualisation toutes les 30 secondes.`;
      $('mapStatus').textContent = `${items.length} mouvements probables · direct ${stamp}`;
      setState('Temps réel actif', `Actualisé à ${stamp}`, 'ready'); updateLegend();
    } catch (error) {
      $('liveSummary').textContent = 'Le flux direct est momentanément indisponible. Le bilan journalier reste accessible.';
      $('mapStatus').textContent = 'Flux direct indisponible'; setState('Temps réel indisponible', 'Nouvel essai automatique', 'error');
    }
  }

  function setViewKind(next) {
    if (next === viewKind) return;
    viewKind = next; document.body.classList.toggle('live-mode', next === 'live');
    $('dailyView').classList.toggle('active', next === 'daily'); $('liveView').classList.toggle('active', next === 'live');
    $('dailyIntro').hidden = next !== 'daily'; $('liveIntro').hidden = next !== 'live';
    const dailyLayers = [haloLayer, trackLayer, markerLayer, densityLayer]; const liveLayers = [liveTrailLayer, liveMarkerLayer];
    if (next === 'live') {
      stop(); dailyLayers.forEach(layer => map.removeLayer(layer)); liveLayers.forEach(layer => layer.addTo(map));
      loadLive(); clearInterval(liveTimer); liveTimer = setInterval(loadLive, 30000);
    } else {
      clearInterval(liveTimer); liveLayers.forEach(layer => map.removeLayer(layer)); dailyLayers.forEach(layer => layer.addTo(map));
      if (day) {
        updateKpis(); setState('Mouvements filtrés', `Journée du ${new Date(`${day.date}T12:00:00`).toLocaleDateString('fr-FR')}`, 'ready'); render();
      }
    }
  }

  document.querySelectorAll('.mode').forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.mode; document.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b === button)); render();
  }));
  document.querySelectorAll('.movement-filters input').forEach(input => input.addEventListener('change', render));
  $('airportSelect').addEventListener('change', render);
  $('time').addEventListener('input', () => { $('animatedView').classList.add('active'); $('wholeDay').classList.remove('active'); syncClock(); scheduleRender(); });
  $('cumulative').addEventListener('change', () => { $('wholeDay').classList.toggle('active', $('cumulative').checked); $('animatedView').classList.toggle('active', !$('cumulative').checked); render(); });
  $('windowSelect').addEventListener('change', render);
  $('speedSelect').addEventListener('change', () => { if (playing) { stop(); togglePlay(); } });
  $('wholeDay').addEventListener('click', () => setDailyDisplay(true));
  $('animatedView').addEventListener('click', () => setDailyDisplay(false));
  document.querySelectorAll('.hour-presets button').forEach(button => button.addEventListener('click', () => { setDailyDisplay(false); $('time').value = button.dataset.minute; syncClock(); render(); }));
  $('dailyView').addEventListener('click', () => setViewKind('daily'));
  $('liveView').addEventListener('click', () => setViewKind('live'));
  $('pebToggle').addEventListener('change', () => {
    if ($('pebToggle').checked) pebLayer.addTo(map); else map.removeLayer(pebLayer);
    $('pebKey').hidden = !$('pebToggle').checked; updateLegend();
  });
  $('play').addEventListener('click', togglePlay);
  $('resetMap').addEventListener('click', () => territoryLayer.getBounds().isValid() ? map.fitBounds(territoryLayer.getBounds(), { padding: [22, 22] }) : map.fitBounds(bounds95));
  $('closeFlight').addEventListener('click', () => { $('flightPanel').classList.remove('open'); $('flightPanel').setAttribute('aria-hidden', 'true'); });
  $('openMethod').addEventListener('click', () => $('methodDialog').showModal());
  $('closeMethod').addEventListener('click', () => $('methodDialog').close());
  $('mobileData').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('sheetHandle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  requestAnimationFrame(animateLive);
  updateLegend(); loadIndex();
})();
