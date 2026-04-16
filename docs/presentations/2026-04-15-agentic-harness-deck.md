# Agentic Harness Leadership Deck

Audience: Management and senior leadership
Tone: Strategic update, not overt pitch
Format: 6-slide minimal deck

## Slide 1: Problem Statement

Subtitle: Common Challenges in Agentic Engineering

- Many agentic systems still rely on one long-running agent to interpret, plan, execute, adapt, and verify in the same loop.
- As that loop grows, context becomes harder to manage and important signals are easier to lose.
- Weak task boundaries increase the chance of drift into adjacent work that was not explicitly requested.
- When continuity depends on session history, resuming work becomes inefficient and less reliable.

## Slide 2: Design Principles

Subtitle: What a More Reliable Harness Requires

- Work should be split into bounded roles so each step has a clear purpose and a limited area of responsibility.
- Durable artifacts should hold run memory so the system can restart cleanly without depending on prior session context.
- Each role should run in a fresh session against the current artifact set to reduce context rot.
- Final verification should be independent from execution so the system does not grade its own work.

## Slide 3: Current Application

Subtitle: Applied in the Ralph QA Harness

- This model has been applied in the Ralph QA harness, where repeatability and evidence are especially important.
- A single orchestrator manages the run, selects the next role, and enforces bounded write scope.
- Specialized roles handle clarification, planning, exploration, execution, healing, and verification one step at a time.
- Final outcomes are tied to artifacts and deterministic proof rather than to conversational output alone.

## Slide 4: Operating Flow

Subtitle: How the Harness Works

- Each run starts from a defined request and a durable artifact set that carries scope, progress, prompts, and execution truth.
- The orchestrator selects one next step, invokes one fresh-session role, and routes the result through proof and verification before status is updated.
- The loop is controlled at the run level, not inside an individual role session.
- Each iteration is bounded and repeatable until the run reaches a stop condition.

Diagram guidance:

- Top row: User Request -> Orchestrator -> Select Item -> Fresh-Session Role -> Proof -> Verifier -> Status
- Bottom row: one long band labeled Durable Run Artifacts (PRD / Progress / Prompt / Execution Truth)
- Vertical connectors from Orchestrator, Fresh-Session Role, and Verifier down into the artifact band
- Loop arrow from Status back to Orchestrator labeled Next bounded iteration
- Small note beneath the loop: Stops on no actionable items, verifier fail or blocked, or budget exhausted

## Slide 5: Broader Relevance

Subtitle: Pattern, Not Just Use Case

- The value of the approach is not limited to QA; it is the operating model of orchestration, bounded roles, durable memory, and verification.
- That same pattern is relevant anywhere teams need structured agent workflows, controlled change, and auditable outcomes.
- QA is the first implementation because it provides a concrete environment to validate the model under real constraints.
- As similar needs emerge in other domains, the same harness structure can be adapted without changing the core principles.

## Slide 6: Summary

Subtitle: Current Status

- The target operating model and system boundaries are now clearly defined.
- The first implementation is intentionally scoped to prove the model in a controlled domain before broadening usage.
- The current direction prioritizes repeatability, traceability, and controlled execution over open-ended autonomy.
- The result is a practical harness pattern with a clear first use case and broader applicability over time.

## Speaker Note Cues

- Slide 1: Frame this as a common systems problem, not a QA-specific issue.
- Slide 2: Emphasize that reliability comes from role boundaries, artifact memory, and verification separation.
- Slide 3: Position QA as the first practical implementation, not the only intended use.
- Slide 4: Stress that the loop happens across fresh sessions, which avoids same-session drift.
- Slide 5: Keep broader applicability understated and factual.
- Slide 6: Close on operating model maturity and measured expansion.
