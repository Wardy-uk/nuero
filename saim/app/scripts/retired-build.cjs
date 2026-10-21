// SAiM Alt (v1/v2/v3, the manifest preview) and the legacy control desktop are
// RETIRED (21 Oct 2026). There is ONE SAiM: https://sara.nickward.co.uk.
// Their build commands stop here so nobody deploys one as a product again. The
// source is kept for rollback, which is a Netlify deploy RESTORE, not a rebuild
// (saim/retired-alt/README.md). SAIM_BUILD_RETIRED=1 lets a deliberate rebuild through.
const which = process.argv[2] || 'alt';
if (process.env.SAIM_BUILD_RETIRED === '1') {
  console.warn(`[retired] building the RETIRED "${which}" variant because SAIM_BUILD_RETIRED=1 — never deploy it as SAiM.`);
  process.exit(0);
}
console.error([
  `"${which}" is RETIRED (21 Oct 2026). sara.nickward.co.uk is the only SAiM.`,
  'Its old hostnames redirect there (saim/retired-alt/). Rollback = restore a',
  'previous Netlify deploy. To rebuild this variant anyway: SAIM_BUILD_RETIRED=1.',
].join('\n'));
process.exit(1);
