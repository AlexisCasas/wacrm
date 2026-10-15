# Connected flows: user guide

Connected flows let one flow **run another flow and come back**, **wait for hours or days**, and **branch on whether the customer wrote**.
They are available to every company. Nothing changes in your existing flows until you build and activate a new one.

## Build a flow that runs another flow
1. Create the flow you want to reuse (flow **B**) and **activate it first**. A flow can only call flows that are active and belong to your company.
2. In the calling flow (flow **A**), add the node **Run another flow**, pick flow B in the searchable list, and choose the node where A continues afterwards.
3. Save and activate A. Activation is refused, with a message that says why, if the target is missing or inactive, if flows would call each other in a circle, or if the chain is deeper than **3 levels** (a single run can make at most **8** calls).
4. Drafts are never activated for you. Editing a flow that is being called after you activated A makes A stop safely the next time it reaches the call, so re-check A after changing B.

## End node: two different behaviours
| Option on the **End** node | What happens |
|---|---|
| **End the whole execution** (default) | The run finishes completely, even if it is inside a called flow. Use it when the conversation is over. |
| **Return to the calling flow** | Only the called flow finishes; the caller continues at the node you chose. Use it at the end of reusable flows. |

If a flow that was meant to return uses the default End, the caller never continues. This is the most common mistake.

## Durable waits
A **Delay** with an amount and a unit (seconds, minutes, hours or days, up to 30 days) is stored with the run. It survives restarts and deployments and is resumed by a scheduler that checks **every minute**, so a wait ends up to about a minute after the time you set. When many waits fall due at the same moment the scheduler resumes about **25 per minute**, oldest first, so the rest follow in the next minutes. A short delay in seconds (1-30) still works as before.

## When the customer replies
- During a durable wait a reply is **not** treated as an answer to anything: the flow does not re-ask and does not hand off.
- The reply is recorded. Use the **Customer activity** condition after the wait to branch on it ("did the customer write since that message?"), pointing at the message you want to compare with (or at the one the calling flow inherited).
- On **Run another flow** you choose whether a reply while the called flow runs should **stop** the run or let it **continue**.

## Limits you should know about
- **No exactly-once guarantee.** If the server crashes in the instant a message is being sent, the engine cannot know whether it left. It then **does not resend**: the run ends as "outcome unknown" and shows up in the operations alerts for a person to check. Rare, but real: do not rely on a flow for something that must be sent exactly once.
- A run belongs to one contact; a contact has one active run at a time.
- Deactivating a flow does not stop runs already inside it; they finish or are closed by the timeout.
