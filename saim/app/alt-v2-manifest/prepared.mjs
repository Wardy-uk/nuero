// Where SAiM's prepared move sits on Alt's SAiM page (20 Oct 2026). PURE.
//
// Alt's page is driven by SAiM's own decision (the lead rule). The prepared
// move comes from the shared PreparedMove component (read, request, confirm,
// receipt — the existing APIs); this decides only its PLACE, never its content:
//
//   - a blind or refused read shows NO move: "can't see your work" must not
//     carry a confident prepared thing beside it;
//   - an ACTIONABLE move with nothing more urgent (the calm rules) LEADS: the
//     lead's state and heading become the move's own headline (from the
//     packet), so it is never drawn under "Nothing needs you" — and the calm
//     hand-off line ("nowhere to go") goes too, because the move IS where to go;
//   - any other lead (a meeting, a risk, a block, an item waiting) stays FIRST,
//     and the move follows it;
//   - a held move never leads — the quiet state stands.

export const CALM_RULES = Object.freeze(['S11 nothing', 'S11c choose']);

/** → { show, leads, vm } — `vm` is the adapter view-model to render (the lead possibly restated). */
export function preparedPlacement(vm, moment) {
  if (!vm || vm.tone === 'blind' || vm.refused || !vm.rule) return { show: false, leads: false, vm };
  if (moment && moment.kind === 'actionable' && moment.headline && CALM_RULES.includes(vm.rule)) {
    return { show: true, leads: true, vm: { ...vm, state: 'Prepared', title: moment.headline, sentence: null, handoffNote: null } };
  }
  return { show: true, leads: false, vm };
}
