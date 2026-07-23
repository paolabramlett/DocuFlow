# client-reminders Specification

## Purpose
TBD - created by archiving change reminders-and-notifications. Update Purpose after archive.
## Requirements
### Requirement: Reminder cadence is an Organization policy

An Organization SHALL carry a reminder cadence: days before the first reminder, days between subsequent reminders, and a maximum reminder count. These SHALL default to sensible values and SHALL NOT be surfaced in the MVP UI, matching the treatment of the retention window.

#### Scenario: Defaults apply without configuration
- **WHEN** an Organization is created without specifying cadence
- **THEN** it carries the default first-delay, interval, and maximum count

#### Scenario: A different cadence needs no code change
- **GIVEN** two Organizations with different cadence values
- **WHEN** reminders are selected for each
- **THEN** each follows its own cadence, and the selection logic is identical

### Requirement: A reminder is sent only while there is something to do

A Client reminder SHALL be sent for a Case only when the Case is open, the Client's grant is active, and at least one requirement is outstanding. A completed, cancelled, revoked, or fully-satisfied Case SHALL NOT generate a reminder.

#### Scenario: Outstanding requirements on an open case are reminded
- **GIVEN** an open Case with an active grant and an outstanding requirement, past its cadence due time
- **WHEN** the reminder selection runs
- **THEN** the Case is selected for a reminder

#### Scenario: A fully-satisfied case is not chased
- **GIVEN** a Case whose every requirement is satisfied
- **WHEN** the reminder selection runs
- **THEN** the Case is not selected

#### Scenario: A revoked grant stops reminders
- **GIVEN** a Case whose grant has been revoked
- **WHEN** the reminder selection runs
- **THEN** the Case is not selected

#### Scenario: A completed case is not chased
- **GIVEN** a Case in the completed state
- **WHEN** the reminder selection runs
- **THEN** the Case is not selected

### Requirement: Cadence is derived from delivery history

The due time for the next reminder SHALL be computed from the last recorded delivery for the Case, not from wall-clock assumptions. A Case with no prior delivery SHALL become due at its first-delay after the grant became active.

#### Scenario: First reminder waits the first-delay
- **GIVEN** an active grant with no prior reminder, activated less than the first-delay ago
- **WHEN** the selection runs
- **THEN** the Case is not yet due

#### Scenario: Subsequent reminders wait the interval
- **GIVEN** a Case whose last reminder was sent less than the interval ago
- **WHEN** the selection runs
- **THEN** the Case is not yet due

### Requirement: The maximum reminder count is honoured

Once the number of reminders sent for a Case reaches the Organization's maximum, no further reminder SHALL be sent for that Case.

#### Scenario: Reminders stop at the cap
- **GIVEN** a Case that has already received the maximum number of reminders
- **WHEN** the selection runs
- **THEN** the Case is not selected

### Requirement: Delivery is idempotent

Selecting and sending reminders SHALL NOT double-send. A run that overlaps or retries a previous run SHALL send at most one reminder per due Case per cadence window.

#### Scenario: A second run in the same window sends nothing
- **GIVEN** a due Case that was just reminded by a completed run
- **WHEN** the selection runs again immediately
- **THEN** no additional reminder is sent

#### Scenario: A recorded delivery attempt is not repeated
- **GIVEN** a reminder whose delivery has been recorded
- **WHEN** the selection runs
- **THEN** that same delivery is not created a second time

### Requirement: Reminders go to the invited mailbox

A reminder SHALL be sent to the address on the Client's active grant, never to an address supplied by the caller of the send path.

#### Scenario: Reminder targets the grant address
- **WHEN** a reminder is sent for a Case
- **THEN** it is delivered to the grant's invited email

### Requirement: Every send and suppression is recorded

Each reminder delivery SHALL create a `reminder_deliveries` row and an audit event. The recorded row SHALL contain no message body, signed URL, or credential.

#### Scenario: A send is recorded
- **WHEN** a reminder is sent
- **THEN** a delivery row and an audit event both exist for it

#### Scenario: The delivery record carries no secrets
- **WHEN** a reminder delivery is recorded
- **THEN** the row contains identifiers and status only, not the email body or any URL

### Requirement: Reminder data is tenant-isolated

`reminder_deliveries` SHALL be readable only by Members of the owning Organization, and never by a Client. Cross-organization reads SHALL return nothing.

#### Scenario: A member reads only their organization's deliveries
- **WHEN** a Member of one Organization reads reminder deliveries
- **THEN** only their Organization's rows are returned

#### Scenario: A client cannot read reminder deliveries
- **WHEN** a Client with an active grant reads reminder deliveries
- **THEN** zero rows are returned

