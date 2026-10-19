'use strict';
// Parity child preload: freeze the wall clock at FROZEN_AT (ms) for the whole
// process, so both paths judge the identical instant whatever else reads Date.
const T = Number(process.env.FROZEN_AT);
if (!Number.isFinite(T)) throw new Error('FROZEN_AT is required');
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(T); else super(...a); }
  static now() { return T; }
}
FrozenDate.UTC = RealDate.UTC;
FrozenDate.parse = RealDate.parse;
global.Date = FrozenDate;
