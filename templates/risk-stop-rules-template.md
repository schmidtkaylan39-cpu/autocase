# Risk-Stop Rules Template

Pause automation and require human review if any of the following happens:

1. Production data would be deleted or overwritten.
2. An irreversible database or data migration is required.
3. Payment, financial flow, identity, or login access is involved.
4. A new paid external service must be added or cost ceilings would increase.
5. Retries exceed the configured limit and the task still fails.
6. Acceptance criteria conflict with each other and the system cannot resolve the contradiction.
7. Estimated time or spend exceeds the approved project limit.
