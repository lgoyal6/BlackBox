# Pitch Notes

Not slides - the sentences.

## The opening

> **Fifteen percent. One in seven New York EMS calls turns out to be something other than
> what it was dispatched as.**

Then, immediately: **that number was computed from 5,653,498 incidents, not cited from a
paper.** Four `COUNT` aggregates against the city's live Socrata API, run on the same data
this project runs on. That distinction is the difference between a claim and a result, and
it costs one sentence.

Then the black box line:

> Aviation solved this problem with a black box. EMS never got one. The reasoning behind
> every one of those corrections dies in radio chatter.

## Three sentences that must be said out loud

**"The medic never looks at a screen."**
Earpiece and a phone in a chest pocket; the system calls them, not the reverse. Say it
because it is what makes the product credible to anyone who has actually worked a call, and
because it preempts the "nobody would use this" objection before a judge raises it. The
dashboard on the projector is a window into the black box for the judges' benefit - it is
not the product.

**"The agent never makes a clinical call."**
It only records and recalls. It reads back what the medic said, or quotes a retrieved
NASEMSO passage with attribution. It never proposes a treatment, a dose, or a diagnosis.
Say it because judges get visibly twitchy about AI making clinical decisions, and because
Eva - the prior Best-ElevenLabs winner this is modelled on - won on documentation and
retrieval, not diagnosis.

**"Every number on that dashboard arrived through an Atlas change stream."**
MongoDB is the memory, the state, the context, **and the transport**. No Redis, no broker,
no third-party vector store anywhere in the system. Say it because the MongoDB track
rewards exactly this and because it is literally true - the SSE route is a change stream on
the `events` collection.

## The production path

Cite NEMSIS. Its 2025 Public-Release Research Dataset covers roughly **63 million EMS
activations** from nearly **15,000 agencies** across **54 states and territories**.

Add the detail that it is **event-based rather than patient-based**, so one patient can
appear across multiple records. It is a small thing to say and it signals domain knowledge
no summary would give you.

Then note that NEMSIS requires a request form to the NEMSIS TAC, which is a same-day
non-starter - and that is why the demo runs on the NYC open dataset instead. Naming the
constraint is stronger than hoping nobody asks.

## The winner patterns this is built against

State them plainly so the pitch can be checked against them:

1. **Every top tagline leads with a number.** This one opens with 15.0%.
2. **Memory is named as the hero, not the plumbing.** Say "it remembers what the last crew
   decided," never "it uses vector search over embedded documents."
3. **MongoDB track winners made the database writes visible.** That is the entire reason
   the checkpoint counter exists and why the presenter points at it.
4. **Voice winners use voice as the workflow channel, never as decoration.** The medic's
   hands are never free, which is why voice is the only capture medium that works here
   rather than a feature bolted onto a form.

## Anticipated questions, two sentences each

**Is the dashboard real, or a mockup?**
Every element on it arrives as an event inserted into a MongoDB collection and pushed to
the browser over a change stream. There is a fixture mode for offline rehearsal, and it is
a different URL - we can show you both.

**What happens when the network drops?**
The dashboard never clears its view and reconnects with backoff forever, merging the replay
frame when it comes back. The agent's state lives in Atlas via `MongoDBSaver`, so the call
itself survives a process death - we will demonstrate that on purpose in a moment.

**Could the agent give a wrong dose?**
It cannot propose a dose at all; it can only read back verbatim what the medic said and
wait for confirmation before writing. That readback gate is real EMS practice, and it
doubles as the human-in-the-loop interrupt in the LangGraph graph.

**Where does the rationale come from if the medic never explains themselves?**
Medics narrate constantly on scene - that is the job - and the agent listens for reasoning
rather than only actions. When a decision arrives without a rationale, a database validator
rejects the write, so a rationale-less decision is a bug, not a silent gap.

**How is this different from an ePCR product?**
An ePCR stores what happened; this stores what the crew decided and why, and then retrieves
that reasoning on the next similar call. The report drafting is a by-product of the
recording, not the point of it.

**Why is the second call not just the first one again?**
Different dispatch code, different presenting symptoms, same latent pattern - so retrieval
has to do semantic work rather than match a string. If they were identical it would be a
cache demo, and we would be showing you a lookup table.

## The close

The response-time delta as one number, large, with its derivation named out loud - it comes
from the city's own response-time fields on the ingested incidents, not from our system.

Then the one-line statement of what was built:

> **It records what the crew decided and why, and it hands that to the next crew.**
