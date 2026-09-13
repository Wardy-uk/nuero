# SARA as Home Assistant's conversation agent

`custom_components/sara/` makes NEURO's brain the thing that answers when Nick
talks to a voice satellite — so "SARA instead of Alexa" is one agent rather
than a list of memorised phrases.

## Why it is a custom component and not `intent_script`

`intent_script` + `rest_command` is the obvious build and **cannot work** on HA
2026.5.4. A probe intent reported which variables its own speech template could
see:

```
neuro_response=False  action_response=False  _response=False  results=False
```

…while the *same* `rest_command` called as a service returns the answer
perfectly (`service_response.content.message == "Pong."`, status 200). The
bridge was never broken; the response simply cannot reach a speech template.

Consequences, both confirmed live before this was built:

* every "ask SARA …" answered **"Nothing came back from the bridge to NEURO."**
* every voice capture answered **"I cannot say whether that saved"** — even
  when the save had worked, which is provable because the underlying
  `rest_command` creates the task fine.

⚠ The old message **named the wrong cause**, which is why it survived: it sent
you to check a bridge that was healthy.

## What happens to a sentence

1. **Home Assistant answers it.** Lights, heating, sockets, sensors. Local,
   instant, free, works with the internet down.
2. **It is a capture.** Anchored prefixes only — "remember that…", "add a
   todo…". Straight to NEURO's capture routes, and the reply states what NEURO
   actually reported.
3. **Anything else goes to the brain** — `/api/chat/sync`, with tools and RAG.

The rule for step 1 is `ha_answer.py`, and both of its fall-throughs were
**measured on the live house**, not reasoned about in advance:

* *"what is on my calendar today"* → HA matched its own **date** intent and
  answered **"September 13th, 2026"**. Confident, fluent, and about a different
  question. `HassGetCurrentDate`/`HassGetCurrentTime` are therefore denied.
* *"what is the living room temperature"* → `no_valid_targets`, spoken as the
  generic *"Sorry, I couldn't understand that"*, while a living-room climate
  entity exists. The first draft of the rule deliberately kept that error as a
  "precise local fact"; the live wording shows it is not precise at all.

A third fall-through was added the same day, and it is the sharpest:

* *"is anyone else home"* → Home Assistant answered **"No"**, matching exactly
  one entity, `person.nick`, while Helen and Isaac were both in.

⚠⚠ **Home Assistant is authoritative about DEVICES, not about PEOPLE** — and
that is the shape of this house rather than a bug. HA holds ONE `person`
entity; the household truth lives in `binary_sensor.household_others_home`,
built from Life360 (for WHO) and the router's associated-client list (for
WHETHER anyone is indoors), because the phone reports home ~90m out over
Wi-Fi positioning and the GPS geofence is useless at home. So an answer whose
targets are **all** `person.*` or `device_tracker.*` falls through to NEURO,
which reads that sensor. ⚠ **ALL, not ANY**: a question that touched a light
as well as a person is still partly about the house, and HA's answer about
the light beats a guess.

⚠ It is a **deny list, not an allow list**. An allow list of house intents
would need extending every time HA adds a device capability, and forgetting
would silently send working device control to a language model — slow, costly
and broken offline. Forgetting to deny a new trivia intent merely restores
today's behaviour.

## Tests

Pure, and run with plain `python3` — no Home Assistant needed:

```bash
python3 homeassistant/test_capture_match.py
python3 homeassistant/test_ha_answer.py
```

The split is deliberate (`pi-health.assess()`'s): the judgement lives in
`capture_match.py` / `ha_answer.py` and pins without a running house; the HTTP
around it is plumbing.

## Deploying

```bash
tar -czf /tmp/sara-cc.tgz -C homeassistant/custom_components sara
scp /tmp/sara-cc.tgz nickw@100.100.28.58:/tmp/
ssh nickw@100.100.28.58 '
  cd /mnt/data/homeassistant/config/custom_components
  sudo rm -rf sara/__pycache__ && sudo tar -xzf /tmp/sara-cc.tgz && sudo chown -R root:root sara
  docker exec homeassistant python3 -m compileall -q /config/custom_components/sara
'
# then restart Home Assistant
```

Setup is a normal config flow (Settings → Devices & Services → Add → SARA),
asking for the NEURO base URL, an API token and a timeout.

⚠ **The token lives in the config entry, never in this repo** — the repo is
public, which is how the PIN leaked in July.

## Live configuration on the Pi (13 Sep 2026)

* `conversation.sara` entity exists and is the agent for the **SARA watch**
  pipeline (faster-whisper + piper), which is what
  `select.living_room_assistant` is set to.
* The bare **Home Assistant** pipeline is deliberately left on HA's own agent:
  it has no speech-to-text, it is the typed-Assist default, and keeping one
  agent that is definitely Home Assistant's own is the way back.
* `custom_sentences/en/neuro.yaml` and the three `Neuro*` entries in
  `intent_script.yaml` are **retired** (backed up alongside). ⚠ Leaving them
  was not neutral: `"Sara {text}"` is a catch-all matching almost any sentence
  beginning with her name, and HA is asked first — so every one of those would
  still be answered by the path that cannot work.
* `rest_command.yaml` is **kept**: `neuro_watchdog_note` is used by a live
  automation, and those commands work correctly when called as services.

## Timeout

`DEFAULT_TIMEOUT` is 45s. Measured on the live Pi, two consecutive
`/api/chat/sync` calls took **4.3s and 35.0s** — a ten-second ceiling would
fail a normal question about half the time. It is a ceiling, not a target; the
honest thing to do about a slow brain is to say it was slow, which the agent
does, and the latency is logged so it can be measured from real use.

## The gap that was here, and how it closed

This section used to read: *asked "what is the living room temperature",
NEURO replies that it has no access to the smart home* — which was honest and
wrong in spirit, because `ha-rooms.js` had been reading every room for weeks
and only the **chat tools** did not expose it.

`get_home_state` closes it, and the closing took three goes, which is the
part worth keeping:

1. **The tool.** Read-only; the house's only write doors stay in the room,
   where a person accepts an offer.
2. **The prompt rule was not enough.** *"Never state a queue figure, task,
   calendar entry or vault fact from memory"* is an ENUMERATION, and the model
   followed it literally — the house was not in the list. Naming it fixed the
   temperature phrasings and did nothing for *"is anyone else home"*, which
   was answered **"No"** with no tool call at all.
3. **So the house is READ BEFORE THE MODEL.** A deterministic router
   (`looksLikeHouseQuestion`) puts the reading in front of it, removing the
   opportunity to invent rather than asking it not to — `checkSaraGrounding`'s
   lesson, and `event-parser`'s regex-first rule.

And then the fault MOVED: with chat answering correctly, the agent was still
saying "No", because Home Assistant was matching the question first. That is
the people rule above.
