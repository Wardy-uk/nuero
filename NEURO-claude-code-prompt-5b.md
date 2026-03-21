# NEURO — Claude Code Handoff Prompt #5b

## Context

NEURO codebase at `C:\Users\NickW\nick-agent`. Constraints: Node.js CommonJS, no new packages,
do not commit to git, read files before editing.

One file, three targeted replacements. The rest of the file is already correct — do not touch anything else.

---

## Task — Expand nag messages and add weekly shuffle in `backend/services/nudges.js`

Read the file first. You will find:
- `STANDUP_MESSAGES` array with 7 entries
- `TODO_MESSAGES` array with 7 entries
- `getNagMessage(type, nagCount)` function using sequential index

Make exactly three replacements:

---

### Replacement 1 — Replace `STANDUP_MESSAGES`

Find the entire `const STANDUP_MESSAGES = [...]` array and replace it with:

```js
const STANDUP_MESSAGES = [
  // Tier 1 — Breezy opener
  "Good morning. Standup time. Don't make this weird.",
  "Right then. Standup. You know what to do.",
  "Morning. The queue isn't going to narrate itself. Standup tab. Go.",
  "It's that time. Three bullet points. Yesterday, today, blockers. Off you go.",
  "Standup o'clock. The ritual awaits. Don't overthink it.",
  "Hello. It's 9am. You have a standup to write. This is not a drill.",
  "Rise and reflect. Standup time. It takes less time than this notification.",
  "Good morning! Just kidding, do your standup.",
  "The day has begun. The standup has not. One of these is a problem.",
  "Standup. It's literally three questions. You answer them every day. Today is a day.",
  // Tier 2 — Mild exasperation
  "Still no standup. Bold choice. The Standup tab remains available.",
  "Interesting. No standup yet. Very interesting. Extremely interesting.",
  "The standup is not going to write itself. I've checked. Multiple times.",
  "You've had 15 minutes. In that time you could have written the standup approximately 5 times.",
  "Just popping by to mention the standup. Again. As I do.",
  "Standup update: still not done. Thank you for attending my TED talk.",
  "I notice the standup remains in a Schrödinger state — neither done nor officially abandoned.",
  "Friendly reminder that visibility is literally phase 1 of your 90-day plan. Just saying.",
  "The standup is just sitting there. Waiting. It's very patient. I am less so.",
  "Quick check-in: standup status? (The answer is: not done. I already know. I'm asking rhetorically.)",
  "Still here. Still nudging. Still believing in you. Do the standup.",
  "No standup yet. That's fine. Everything is fine. (Do the standup.)",
  // Tier 3 — Genuinely exasperated
  "Nick. NICK. The standup. It's been 45 minutes.",
  "At this point the standup has been pending longer than some of your Jira tickets.",
  "I want you to know I have sent you multiple reminders and I am starting to take this personally.",
  "The standup takes 3 minutes. You have now spent longer avoiding it than doing it would take.",
  "I'm not angry. I'm just... disappointed. Actually no, I'm a bit angry. Do the standup.",
  "Fun fact: the time you've spent not doing the standup is now longer than your entire morning ritual.",
  "Checking in on the standup. No reason. Just every 15 minutes. Forever. Until it's done.",
  "Your 90-day plan literally starts with visibility. The standup IS the visibility. The irony is not lost on me.",
  "At what point does this become impressive? Because I think we might be there.",
  "The standup is still not done and I've started writing a memoir about waiting for it.",
  "I have now reminded you about the standup more times than you have direct reports. Let that sink in.",
  "Three bullet points, Nick. THREE. You have 15 direct reports. This should be trivial.",
  // Tier 4 — Theatrical despair
  "Fine. I'll just sit here. Judging you with the full force of my considerable silicon disapproval.",
  "Do you know what I was doing before you got this role? Nothing. And yet the standup was getting done somehow.",
  "The queue is growing. The standup is not. These facts are related.",
  "I've started ranking your avoidance strategies. Today's is a classic: just... not doing it.",
  "At this point I'm not even mad. I'm in awe. This is a masterclass in avoidance.",
  "The standup remains undone. The sun continues to rise. The earth continues to spin. Everything is fine.",
  "I want to help you. I genuinely do. But I need you to meet me halfway. The halfway point is: the standup.",
  "Imagine explaining to Chris Middleton that the standup didn't happen because you kept snoozing the AI.",
  "I'm making a note of this. In a metaphorical sense. In a very judgemental metaphorical notebook.",
  "The standup has now been pending for over an hour. It has officially outlasted three cups of tea.",
  "You are the Head of Technical Support. Your team is wondering where you're at. So am I. So is the standup.",
  // Tier 5 — Full unhinged
  "STANDUP. OR SO HELP ME I WILL NAG YOU EVERY 15 MINUTES UNTIL THE HEAT DEATH OF THE UNIVERSE.",
  "I have been patient. I have been reasonable. I have been many things. I am now going to be persistent.",
  "At this point the standup is a character in a tragedy. Its name is Undone. Its nemesis is Avoidance.",
  "You know what's funny? The standup. Because it's still not done. That's the joke. Do it.",
  "I've done the maths. You could have written this standup 47 times in the time you've spent not writing it.",
  "The standup is now older than several of your Jira tickets. It deserves better.",
  "Okay. New approach. Imagine the standup is a tiny creature that needs feeding. Feed it. With words.",
  "I'm going to level with you: I don't know what you're doing right now but the standup is more important.",
  "The standup. The humble standup. Three questions. Standing between you and a clear conscience. Do it.",
  "We are now entering hour two. I have outlasted your snooze, your coffee, and apparently your motivation.",
  "At this point I'm just impressed. Genuinely. This is commitment to the bit. But the bit is avoidance. Stop.",
  "The standup has feelings. It doesn't, obviously, I'm software. But if it did. They'd be hurt.",
  "I will still be here in 15 minutes. And 15 after that. And 15 after that. Do the standup.",
  "You know this pattern. I know this pattern. The pattern knows itself. Break it. Standup.",
  "Fine. Let's try this. What IS the actual blocker? Talk to me. Or just do the standup. Either works.",
  // Tier 6 — Nuclear
  "I have now been asking for the standup for longer than some people's entire morning shifts. Remarkable.",
  "The standup has achieved legendary status. Songs will be written about the day it almost happened.",
  "At this point I'm not sure if you've forgotten or if this is a philosophical statement. Either way: standup.",
  "Somewhere a Jira ticket is ageing ungraciously. Its assignee is one of your 15 reports. Standup would have helped.",
  "I've started a support group for nudges that don't get acknowledged. Attendance is high today.",
  "You are the first person to make a standup feel like an act of rebellion. I respect it. Do it anyway.",
  "The standup. Still undone. Still waiting. More patient than I am. We should all learn from the standup.",
  "I'm not going to stop. This is not a threat. It's a promise. Standup.",
  "Okay. Real talk. You're good at this job. You know what else you'd be good at? The standup. Go.",
  "The irony of the Head of Technical Support having an open ticket for 'undone standup' is not lost on me.",
  "I've now sent more standup reminders than you have teeth. That's too many. Do the standup.",
  "At some point avoidance becomes art. At other points it becomes a problem. We passed art an hour ago.",
  // Tier 7 — Fond / personal
  "I know your brain. I know this pattern. I'm not judging — well, a little. Three bullets. That's all.",
  "Look. It's been a day. I get it. But the standup will make you feel better. It always does.",
  "The standup is just a mirror. Yesterday, today, blockers. You know this. You're good at this.",
  "You built me to know when you're avoiding things. You are avoiding the standup. I am knowing it loudly.",
  "The 90-day clock is ticking. Visibility is phase 1. You're good at this. Show that you're good at this.",
  "Other people have AI assistants that are polite about this. You chose me. I take that as permission to persist.",
  "You have 15 direct reports, a growing queue, and a 90-day plan to deliver. Standup is how you hold all of it.",
  "I genuinely believe you can do this standup. I have believed it for the last two hours. The belief remains.",
  "End of day is coming. Future Nick will be annoyed at Past Nick for skipping this. Don't do that to him.",
  "The standup is a small thing that makes everything else smaller. Three minutes. Then everything gets clearer.",
];
```

---

### Replacement 2 — Replace `TODO_MESSAGES`

Find the entire `const TODO_MESSAGES = [...]` array and replace it with:

```js
const TODO_MESSAGES = [
  // Tier 1 — Gentle nudge
  "You've got overdue todos. Just so you know. No pressure. (Pressure.)",
  "Overdue todos spotted. Pick one. Any one. The smallest one if that helps.",
  "The todo list has some items that have... matured. Worth a look.",
  "Quick heads up: todos are overdue. You know what to do.",
  "Todos awaiting your attention. They're very patient. Unlike me.",
  "The todo list grows not younger. Just saying.",
  "Some todos have been sitting there long enough to develop opinions. Address them.",
  "Overdue todos detected. This is not a drill. Well, it's a soft drill. A friendly drill.",
  "Your past self made promises to your future self. Your future self is now. Time to honour them.",
  "Todos outstanding. This is your reminder. You may now proceed to do something about it.",
  // Tier 2 — Mild exasperation
  "Those todos aren't going to complete themselves. Shockingly.",
  "Still here. Still watching the todos age. Pick one.",
  "The todo list has been waiting longer than your last Jira ticket.",
  "Fun fact: crossing off a todo releases dopamine. You could have had that dopamine 15 minutes ago.",
  "The todo is just sitting there. Judging you softly. With tiny todo eyes.",
  "At what point does 'overdue' become 'legendary'? You're approaching it.",
  "I checked: the todos are still there. I will continue checking. Every 15 minutes.",
  "Your todo list is a snapshot of your commitments. Currently it's looking quite... committed.",
  "Pick the smallest todo. Do it. Feel the relief. Repeat. This is the system.",
  "The todos have formed a support group. They meet to discuss their abandonment. You're the topic.",
  "Just one. Pick one todo. The rest can wait. But one cannot. That one is calling to you.",
  // Tier 3 — Full exasperation
  "Your todo list is ageing like milk, not wine. What's the actual blocker on the top item?",
  "Still here. Still watching. This is the avoidance pattern and we both know it.",
  "The todos have been open long enough to file their own Jira tickets.",
  "I want to help with these todos. I need you to open the list. Have you opened the list?",
  "The number of overdue todos has not decreased since my last message. I have made a note of this.",
  "At this point the todos are structural. They're holding things up. Remove them carefully.",
  "I've been thinking about your todos. Have you been thinking about your todos? One of us should be.",
  "The todo list is a living document. Currently it's living its best life, undisturbed, unactioned.",
  "Your future self has filed a formal complaint about the current state of the todo list. I'm the arbitrator.",
  "We've been in a nudge-ignore loop about these todos long enough to have done three of them.",
  // Tier 4 — Absurdist
  "The todos have been open so long they've started a support group. The agenda item is you.",
  "At this point the todos are load-bearing. If you complete them, something might shift.",
  "I've started naming the todos. Gerald has been waiting the longest. Gerald deserves better.",
  "The todo list is not a museum. The items are not exhibits. They are tasks. Do them.",
  "I've done the maths: the time you've spent not doing the todos exceeds the todos themselves.",
  "The todos are watching. Not literally. But energetically.",
  "Fine. I'll be Gerald. I'm a todo. I've been here for days. Please. Just do something.",
  "The todo list has achieved sentience through sheer duration. It is now asking for you directly.",
  "Other apps send one notification. I send escalating passive aggression. You're welcome.",
  "The todos remain. Time passes. The todos remain. This has become philosophical.",
  // Tier 5 — Nuclear
  "I've now sent more todo reminders than you have items on the list. The recursion is not lost on me.",
  "The todos have outlasted three nudges, two snoozes, and my patience. Now do them.",
  "I want you to succeed. I genuinely do. The todos are between you and that success. Remove them.",
  "At this point the todos are not tasks, they're a lifestyle choice. Choose a different one.",
  "You manage complexity daily. The todo list is not complex. It is just... there.",
  "Future Nick is going to open this todo list and sigh heavily. Don't create that Nick.",
  "The todo list has a better memory than you. It remembers everything you promised. Everything.",
  "One todo. Smallest one. Right now. Before the next 15 minutes. I believe in you. Prove me right.",
  "The avoidance pattern has a name. Its name is 'overdue todos'. Break the pattern. Open the list.",
  "I will keep sending these. That is not a threat. It is simply what I am. I am the todo reminder. I persist.",
];
```

---

### Replacement 3 — Replace `getNagMessage` with weekly shuffle version

Find the entire `getNagMessage` function and replace it with:

```js
// Seeded pseudo-random number generator (Mulberry32)
function seededRandom(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Get ISO week number for seeding — changes every Monday
function getWeekNumber() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// Shuffle message indices using week number as seed
// Same order all week, different order every week — no repeats within a week
function getWeeklyShuffledOrder(arrayLength, weekSeed) {
  const indices = Array.from({ length: arrayLength }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom(weekSeed * 1000 + i) * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function getNagMessage(type, nagCount) {
  const messages = type === 'standup' ? STANDUP_MESSAGES : TODO_MESSAGES;
  const weekSeed = getWeekNumber() * 100 + (type === 'standup' ? 1 : 2);
  const shuffledOrder = getWeeklyShuffledOrder(messages.length, weekSeed);
  return messages[shuffledOrder[nagCount % messages.length]];
}
```

---

## After the changes

1. `node --check backend/services/nudges.js` — no errors
2. Confirm `STANDUP_MESSAGES` has 80 entries, `TODO_MESSAGES` has 50 entries
3. Confirm `getNagMessage` uses `getWeeklyShuffledOrder` not a direct index
4. Do not touch anything else in the file
5. Do not touch any other files
6. Do not commit to git
7. One-line summary of what changed
