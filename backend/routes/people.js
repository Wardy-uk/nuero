'use strict';

/**
 * Personal relationships & people context (Build 31). Reads are open; every
 * write is Nick's statement about who someone is, written into the People
 * note, and refused to machine clients by the authority matrix.
 *
 * ⚠ Literal paths are registered BEFORE `/:personId`, or Express reads
 * "duplicates" as a person id.
 */

const express = require('express');
const people = require('../services/people');

const router = express.Router();
const send = (res, r) => res.status(r.ok ? 200 : r.status || 400).json(r);

// GET /api/people — Life → People: household, family, friends, work, other, unknown relationship; dates, commitments, sources.
router.get('/', (req, res) => {
  try { res.json(people.read()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/people — Nick creates a People note (name; optional rosterName, relationshipType, sphere, household).
router.post('/', async (req, res) => {
  const { name, rosterName, relationshipType, relationshipDetail, sphere, household } = req.body || {};
  try { send(res, await people.createPerson({ name, rosterName, relationshipType, relationshipDetail, sphere, household })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/people/duplicates/decide — merge, keep separate or unmerge two people records. Body: a, b, decision, keep.
router.post('/duplicates/decide', async (req, res) => {
  const { a, b, decision, keep } = req.body || {};
  try { send(res, await people.decideDuplicate({ a, b, decision, keep })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/people/links/reject — "not this person": refuse a name match (household roster, birthday). Body: subject, personId, restore.
router.post('/links/reject', (req, res) => {
  const { subject, personId, restore } = req.body || {};
  try { send(res, people.rejectLink({ subject, personId, restore: restore === true })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/people/:personId — one person: relationship, sphere, household, dates, commitments, why NEURO knows it, correction history.
router.get('/:personId', (req, res) => {
  try { send(res, people.detail(req.params.personId)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/people/:personId/classify — set a person's relationship, detail, sphere, household or importance (null clears).
router.post('/:personId/classify', async (req, res) => {
  const { relationshipType, relationshipDetail, sphere, household, importance } = req.body || {};
  try { send(res, await people.classify(req.params.personId, { relationshipType, relationshipDetail, sphere, household, importance })); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
