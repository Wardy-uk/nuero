'use strict';
// Life → Ignore on a phone calendar (5 Oct 2026): its events stop reaching
// NEURO at the ingest, and the Outlook account can never be ignored.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-calignore-')), 'scratch.db');

const db = require('../db/database');
const sc = require('./source-classification');
const apple = require('./apple-ingest');

test.before(async () => { await db.init(); });

test('the Outlook account cannot be ignored; a phone calendar can', () => {
  assert.equal(sc.validate({ kind: 'calendar', sourceKey: sc.GRAPH_PRIMARY, tracked: false }).ok, false);
  assert.equal(sc.validate({ kind: 'calendar', sourceKey: 'eventkit-cal:id:OLD', tracked: false }).ok, true);
});

test('a calendar is ignored only when explicitly set so', () => {
  assert.equal(sc.calendarIgnored({ id: 'none', title: 'Nothing' }, { byKey: new Map(), titleCount: new Map() }), false);
  const byKey = new Map([['eventkit-cal:id:OLD', { tracked: false }]]);
  assert.equal(sc.calendarIgnored({ id: 'OLD', title: 'Open Uni' }, { byKey, titleCount: new Map() }), true);
});

test('a push drops events from an ignored calendar and keeps the rest', () => {
  assert.equal(sc.classify({ kind: 'calendar', sourceKey: 'eventkit-cal:id:OLD', tracked: false, label: 'Open Uni' }).ok, true);
  const r = apple.ingestCalendar({
    from: '2026-10-05T00:00:00', to: '2026-10-06T00:00:00',
    calendars: [{ id: 'OLD', title: 'Open Uni' }, { id: 'FAM', title: 'Family' }],
    events: [
      { id: 'e1', title: 'Tutorial', calendar: 'Open Uni', calendarId: 'OLD', start: '2026-10-05T18:00:00', end: '2026-10-05T19:00:00' },
      { id: 'e2', title: 'Swimming', calendar: 'Family', calendarId: 'FAM', start: '2026-10-05T17:00:00', end: '2026-10-05T18:00:00' },
    ],
  });
  assert.equal(r.ok, true);
  const subjects = db.all("SELECT subject FROM calendar_cache WHERE source = 'apple'").map((x) => x.subject);
  assert.deepEqual(subjects, ['Swimming']);
  // Restoring brings it back on the next push.
  sc.classify({ kind: 'calendar', sourceKey: 'eventkit-cal:id:OLD', tracked: null });
  assert.equal(sc.calendarIgnored({ id: 'OLD', title: 'Open Uni' }), false);
});

test('an old-build item with only a title takes the id calendar\'s classification when the name is unique', () => {
  const byKey = new Map([['eventkit-cal:id:FAM', { sourceKey: 'eventkit-cal:id:FAM', label: 'Family', domains: ['family'] }]]);
  const r = sc.resolveFor('calendar', { id: null, title: 'Family' }, { byKey, titleCount: new Map() });
  assert.deepEqual(r.classification.domains, ['family']);
  // Two id calendars with the name: neither is assumed.
  byKey.set('eventkit-cal:id:FAM2', { sourceKey: 'eventkit-cal:id:FAM2', label: 'Family', domains: ['home'] });
  assert.equal(sc.resolveFor('calendar', { id: null, title: 'Family' }, { byKey, titleCount: new Map() }).classification, null);
});

test('a name-only twin of an id calendar is superseded; counts read the world model', () => {
  sc.observeContainers('calendar', [{ id: 'FAM', title: 'Family' }]);
  sc.observeContainers('calendar', [{ id: null, title: 'Family' }, { id: null, title: 'Solo' }]);
  const rows = sc.listContainers();
  const byKey = Object.fromEntries(rows.map((r) => [r.sourceKey, r]));
  assert.equal(byKey['eventkit-cal:id:FAM'].superseded, false);
  assert.equal(byKey['eventkit-cal:title:family'].superseded, true);
  assert.equal(byKey['eventkit-cal:title:solo'].superseded, false);
  db.run(`INSERT INTO wm_meetings (meeting_id, provider, provider_event_id, title, start_local, end_local, is_all_day, status, kind,
            provenance_kind, confidence, observed_at, received_at, evidence_json, fingerprint, updated_at, calendar_key, calendar_name)
          VALUES ('apple:x1','apple','x1','Swim','2099-01-01T17:00','2099-01-01T18:00',0,'scheduled','event','observed',1,'t','t','[]','f','t','eventkit-cal:id:FAM','Family')`);
  const fam = sc.listContainers().find((r) => r.sourceKey === 'eventkit-cal:id:FAM');
  assert.deepEqual(fam.entries, { total: 1, current: 1 });
  const ent = sc.containerEntries('calendar', 'eventkit-cal:id:FAM');
  assert.equal(ent.current[0].title, 'Swim');
});
