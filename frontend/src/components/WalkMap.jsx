import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

/**
 * The walk on a real map — planned route (dashed), Nick's trail (solid),
 * Ember's (orange), and one dot per tracker's last position.
 *
 * ⚠ A DELIBERATE COPY: the same file lives at vesta/src/components/WalkMap.jsx.
 *   The two apps deploy separately (VESTA builds on Netlify from vesta/), so
 *   they cannot share a module. Change both or neither.
 * ⚠ Leaflet is imported INSIDE the effect, never at module load: it touches
 *   `window` on import, and the render tests bundle this file for Node.
 * ⚠ Tiles are OpenTopoMap (contours and footpaths — this is for hills). Asking
 *   for tiles tells that server which area is being looked at; nothing else
 *   leaves the page. Without tiles the lines still draw.
 */

const TILE_URL = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = 'Map data © OpenStreetMap contributors, SRTM · Style © OpenTopoMap (CC-BY-SA)';

export default function WalkMap({ route = [], trail = [], emberTrail = [], positions = [], height = 320 }) {
  const box = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const fitted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !box.current) return;
      if (!map.current) {
        map.current = L.map(box.current, { zoomControl: true, attributionControl: true });
        L.tileLayer(TILE_URL, { maxZoom: 17, attribution: ATTRIBUTION }).addTo(map.current);
        layer.current = L.layerGroup().addTo(map.current);
        // A map made before its box has its final size draws grey tiles; measure again once laid out.
        setTimeout(() => { if (map.current) map.current.invalidateSize(); }, 250);
      }
      const g = layer.current;
      g.clearLayers();
      const all = [];
      if (route.length > 1) { L.polyline(route, { color: '#555', weight: 3, dashArray: '6 6', opacity: 0.9 }).addTo(g); all.push(...route); }
      if (route.length) L.circleMarker(route[0], { radius: 6, color: '#2e7d32', fillColor: '#4caf50', fillOpacity: 1 }).bindTooltip('Start').addTo(g);
      if (emberTrail.length > 1) { L.polyline(emberTrail, { color: '#e08a3c', weight: 3 }).addTo(g); all.push(...emberTrail); }
      if (trail.length > 1) { L.polyline(trail, { color: '#1565c0', weight: 4 }).addTo(g); all.push(...trail); }
      for (const p of positions) {
        const ll = [p.lat, p.lon];
        all.push(ll);
        L.circleMarker(ll, { radius: p.who === 'ember' ? 6 : 8, color: '#fff', weight: 2, fillColor: p.who === 'ember' ? '#e08a3c' : '#d32f2f', fillOpacity: 1 })
          .bindTooltip(`${p.label} — ${p.ago}`).addTo(g);
        if (p.accuracyM) L.circle(ll, { radius: p.accuracyM, color: p.who === 'ember' ? '#e08a3c' : '#d32f2f', weight: 1, fillOpacity: 0.08 }).addTo(g);
      }
      // Fit once, so a poll every minute does not undo Nick's or Helen's zoom.
      if (all.length && !fitted.current) { map.current.fitBounds(L.latLngBounds(all), { padding: [20, 20], maxZoom: 15 }); fitted.current = true; }
      if (!all.length && !fitted.current) map.current.setView([54.5, -3.0], 6);
    })();
    return () => { cancelled = true; };
  }, [JSON.stringify(route), JSON.stringify(trail), JSON.stringify(emberTrail), JSON.stringify(positions)]);

  useEffect(() => () => { if (map.current) { map.current.remove(); map.current = null; } }, []);

  return <div ref={box} className="walk-map" style={{ height, width: '100%', borderRadius: 12, overflow: 'hidden' }} role="img" aria-label="Map of the planned route and where the trackers have been" />;
}
