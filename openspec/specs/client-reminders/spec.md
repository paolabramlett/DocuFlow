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

A reminder SHALL be delivered to the destination recorded on the Participant's active grant, never to a destination supplied by the caller of the send path. The delivery SHALL be described by a channel and a destination rather than an email-specific field; email SHALL be the only channel in this change, and provider-specific behaviour SHALL live in the delivery adapter, not in selection or queuing.

#### Scenario: Reminder targets the grant address
- **WHEN** a reminder is sent for a Participant
- **THEN** it is delivered over the recorded channel to the recorded destination, which is the grant's invited email

#### Scenario: Selection is unaware of the provider
- **WHEN** reminders are selected and queued
- **THEN** no part of selection or queuing references Resend or any channel provider

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

### Requirement: Reminders are per Participant

A reminder SHALL be evaluated per Participant. A Participant with an active grant and at least one outstanding Requirement assigned to it SHALL be chased on the Organization's cadence; a Participant with no outstanding assigned Requirement SHALL NOT be chased, even if another Participant of the same Case has outstanding work.

#### Scenario: Only participants with outstanding work are chased
- **GIVEN** a Case where Participant A has an outstanding Requirement and Participant B's Requirements are all satisfied
- **WHEN** reminder selection runs
- **THEN** Participant A is selected and Participant B is not

#### Scenario: Each participant follows the cadence independently
- **GIVEN** two Participants of one Case, each with its own active grant and outstanding work
- **WHEN** selection runs at a due time
- **THEN** a reminder is queued for each Participant, keyed independently

### Requirement: The delivery record is channel-agnostic

A `reminder_deliveries` row SHALL record the channel and destination used, not an email-specific field, so a future channel is an added value rather than a schema change. It SHALL still carry no message body, rendered content, or credential.

#### Scenario: The record names channel and destination
- **WHEN** a reminder is queued
- **THEN** the row records channel `email` and the destination address, and no message body

