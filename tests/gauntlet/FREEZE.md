# Gauntlet freeze (V1 release gate)

The Gauntlet is **frozen as a permanent CI / release gate**.

Stop adding Gauntlet scenarios as the primary development activity.

From here:

- Every future bug becomes a **regression scenario**.
- Every future semantic capability gets its own normal + boundary +
  adversarial + composition tests at the time it is implemented.
- Development focus moves to real-world adoption.

CI fails the build unless:

1. Behavioural correctness is 100%.
2. Answerable capability is 100% for the supported V1 surface.
3. Safety, policy, and clarification accuracy are 100%.
4. Unsupported capability count is 0.
5. Standard / critical / security-critical failures are 0.
6. Every listed kernel-guarantee mutation is detected.

Do not delete, weaken, or rewrite scenarios to restore a green build.
Do not turn executable work into refusals to raise a score.
Do not generate meaningless combinations to inflate the scenario count.

Known V1 limitations: [`V1_LIMITATIONS.md`](./V1_LIMITATIONS.md).
