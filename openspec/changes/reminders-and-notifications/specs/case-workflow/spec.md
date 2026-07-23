## ADDED Requirements

### Requirement: Case and requirement state changes emit notification events

A Document upload and the satisfaction of a Case's final outstanding requirement SHALL each emit a Staff notification, without altering the underlying Case or Requirement behaviour. Observing state for notification SHALL NOT change how state itself transitions.

#### Scenario: State transitions are unchanged by observation
- **WHEN** a requirement becomes satisfied
- **THEN** the requirement's own status behaviour is exactly as before, and a notification is emitted as a separate effect

#### Scenario: Notification emission does not block the state change
- **WHEN** a Document is uploaded
- **THEN** the upload succeeds whether or not a notification consumer is present
