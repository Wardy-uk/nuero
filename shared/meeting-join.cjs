'use strict';

/**
 * A meeting's join link, from the calendar's STRUCTURED fields only (16 Oct 2026). PURE.
 *
 * Graph says an event is an online meeting (`isOnlineMeeting`), gives its join URL
 * (`onlineMeeting.joinUrl`) and names the provider (`onlineMeetingProvider`:
 * teamsForBusiness / skypeForBusiness / skypeForConsumer / unknown). That is the only
 * source. Nothing is read from the subject, body or location, and a provider is never
 * guessed: Graph's own enum names it, else the join URL's HOST is matched EXACTLY
 * against the services' own meeting hosts, else it is null and the link is offered as
 * plain "Join the meeting". A join URL that is not https is not a link.
 *
 * Returns `{ url, provider }` or null.
 */

const GRAPH_PROVIDER = Object.freeze({ teamsForBusiness: 'teams', skypeForBusiness: 'skype', skypeForConsumer: 'skype' });
/** Exact meeting hosts (or a subdomain of them) → provider. A host not listed is no provider. */
const HOSTS = Object.freeze([
  ['teams.microsoft.com', 'teams'], ['teams.live.com', 'teams'],
  ['zoom.us', 'zoom'], ['zoomgov.com', 'zoom'],
  ['meet.google.com', 'meet'],
  ['webex.com', 'webex'],
]);
const PROVIDER_LABEL = Object.freeze({ teams: 'Teams', zoom: 'Zoom', meet: 'Google Meet', webex: 'Webex', skype: 'Skype' });

function hostProvider(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const hit = HOSTS.find(([h]) => host === h || host.endsWith(`.${h}`));
  return hit ? hit[1] : null;
}

/** From a Graph event (or the cached row's two columns). */
function joinFrom({ isOnlineMeeting = null, joinUrl = null, onlineMeetingProvider = null } = {}) {
  if (isOnlineMeeting === false) return null;
  const url = typeof joinUrl === 'string' ? joinUrl.trim() : '';
  if (!/^https:\/\/\S+$/.test(url)) return null;
  const provider = GRAPH_PROVIDER[onlineMeetingProvider] || hostProvider(url);
  return { url, provider: provider || null };
}

module.exports = { joinFrom, hostProvider, PROVIDER_LABEL };
