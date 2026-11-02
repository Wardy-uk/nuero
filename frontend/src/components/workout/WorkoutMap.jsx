import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

/**
 * A finished workout on a real map (2 Nov 2026): the watch's track (solid), the
 * route plan it was linked to (dashed), start / finish / highest point, a pin
 * per photo, and a moving dot that follows a hover on the charts.
 *
 * ⚠ Leaflet is imported INSIDE the effect (it touches `window` on import, and
 *   render tests bundle this file for Node) — WalkMap's rule.
 * ⚠ Tiles are OpenTopoMap: asking for tiles tells that server which area is
 *   being looked at. Nothing else leaves the page.
 */

const TILE_URL = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = 'Map data © OpenStreetMap contributors, SRTM · Style © OpenTopoMap (CC-BY-SA)';

export default function WorkoutMap({ line = [], plan = [], start = null, end = null, highest = null, photos = [], cursor = null, onPhoto = null, height = 460, interactive = true }) {
  const box = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const dot = useRef(null);
  const Lref = useRef(null);
  const onPhotoRef = useRef(onPhoto);
  onPhotoRef.current = onPhoto;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      Lref.current = L;
      if (cancelled || !box.current) return;
      if (!map.current) {
        map.current = L.map(box.current, {
          zoomControl: interactive, attributionControl: true, scrollWheelZoom: interactive, dragging: interactive,
          doubleClickZoom: interactive, boxZoom: interactive, keyboard: interactive, touchZoom: interactive,
        });
        L.tileLayer(TILE_URL, { maxZoom: 17, attribution: ATTRIBUTION }).addTo(map.current);
        layer.current = L.layerGroup().addTo(map.current);
        setTimeout(() => { if (map.current) map.current.invalidateSize(); }, 250);
      }
      const g = layer.current;
      g.clearLayers();
      if (plan.length > 1) L.polyline(plan, { color: '#8a8f9c', weight: 3, dashArray: '6 6', opacity: 0.9 }).bindTooltip('Your route plan').addTo(g);
      if (line.length > 1) L.polyline(line, { color: '#1565c0', weight: 4, opacity: 0.95 }).addTo(g);
      const pin = (p, fill, label) => p && L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: fill, fillOpacity: 1 }).bindTooltip(label).addTo(g);
      pin(start, '#2e7d32', 'Start');
      if (end && start && (Math.abs(end.lat - start.lat) > 2e-4 || Math.abs(end.lon - start.lon) > 2e-4)) pin(end, '#c62828', 'Finish');
      if (highest) pin(highest, '#6a1b9a', `Highest point · ${Math.round(highest.eleM)} m`);
      for (const p of photos) {
        const icon = L.divIcon({ className: 'wk-photo-pin', html: '📷', iconSize: [22, 22], iconAnchor: [11, 11] });
        L.marker([p.lat, p.lon], { icon, keyboard: false })
          .bindTooltip(`Photo${p.takenLocal ? ` · ${String(p.takenLocal).slice(11, 16)}` : ''}${p.placedBy === 'time' ? ' (placed by time)' : ''}`)
          .on('click', () => onPhotoRef.current && onPhotoRef.current(p.id))
          .addTo(g);
      }
      const all = [...line, ...plan];
      if (all.length) map.current.fitBounds(L.latLngBounds(all), { padding: [24, 24], maxZoom: 16 });
      else map.current.setView([54.5, -3.0], 6);
    })();
    return () => { cancelled = true; };
  }, [JSON.stringify(line), JSON.stringify(plan), JSON.stringify(photos), start && start.lat, highest && highest.lat]);

  // The hover dot moves without redrawing the track.
  useEffect(() => {
    const L = Lref.current;
    if (!L || !map.current) return;
    if (!cursor) { if (dot.current) { dot.current.remove(); dot.current = null; } return; }
    if (!dot.current) dot.current = L.circleMarker([cursor.lat, cursor.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#f0a040', fillOpacity: 1 }).addTo(map.current);
    else dot.current.setLatLng([cursor.lat, cursor.lon]);
  }, [cursor && cursor.lat, cursor && cursor.lon]);

  useEffect(() => () => { if (map.current) { map.current.remove(); map.current = null; } }, []);

  return <div ref={box} className="wk-map" style={{ height, width: '100%' }} role="img" aria-label="Map of the route walked" />;
}
