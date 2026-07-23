## MODIFIED Requirements

### Requirement: Reminders go to the invited mailbox

A reminder SHALL be delivered to the destination recorded on the Participant's active grant, never to a destination supplied by the caller of the send path. The delivery SHALL be described by a channel and a destination rather than an email-specific field; email SHALL be the only channel in this change, and provider-specific behaviour SHALL live in the delivery adapter, not in selection or queuing.

#### Scenario: Reminder targets the grant address
- **WHEN** a reminder is sent for a Participant
- **THEN** it is delivered over the recorded channel to the recorded destination, which is the grant's invited email

#### Scenario: Selection is unaware of the provider
- **WHEN** reminders are selected and queued
- **THEN** no part of selection or queuing references Resend or any channel provider

## ADDED Requirements

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
