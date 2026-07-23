# audit-trail Specification

## Purpose
TBD - created by archiving change initial-multi-tenant-schema. Update Purpose after archive.
## Requirements
### Requirement: Consequential actions produce an audit event

The system SHALL record an audit event for every consequential action, including Case creation and state change, Requirement add, rename, delete, and reorder, grant issuance, OTP verification success and failure, permission change, revocation, Document upload, Review decision, and Member changes.

#### Scenario: Action produces an event
- **WHEN** any consequential action listed above completes successfully
- **THEN** exactly one audit event is written recording the actor, the action, the target, the Organization, and the time

#### Scenario: Failed authorization is recorded
- **WHEN** an OTP verification attempt fails
- **THEN** an audit event records the attempt without storing the submitted code

### Requirement: Audit events are append-only

Audit events SHALL NOT be updated or deleted by any application role. Immutability SHALL be enforced by database policy, not by convention.

#### Scenario: Update is denied
- **WHEN** any application role attempts to update an audit event
- **THEN** the write is denied by policy

#### Scenario: Delete is denied
- **WHEN** any application role attempts to delete an audit event
- **THEN** the write is denied by policy

#### Scenario: Events outlive their subject
- **GIVEN** a Requirement that has been deleted from a Case
- **WHEN** the Case's audit history is read
- **THEN** the events recording that Requirement's creation and deletion remain readable

### Requirement: Audit events identify the actor including client actors

Each event SHALL record who acted. The actor MAY be a Member, a Client acting through an active grant, or the system for automated actions, and the kind of actor SHALL be distinguishable.

#### Scenario: Client action is attributed
- **WHEN** a Client uploads a Document through an active grant
- **THEN** the audit event attributes the action to that Client and records the grant used

#### Scenario: System action is attributed
- **WHEN** the system downgrades grants on Case completion
- **THEN** the audit event attributes the action to the system rather than to a Member

### Requirement: Audit events are readable only within their Organization

Audit events SHALL be readable by Members of the owning Organization. Clients SHALL NOT read audit events.

#### Scenario: Cross-organization audit read returns nothing
- **WHEN** a Member of Organization A queries audit events belonging to Organization B
- **THEN** zero rows are returned

#### Scenario: Client cannot read audit events
- **WHEN** a Client with an active grant queries audit events
- **THEN** zero rows are returned

### Requirement: Audit events do not store secrets or file contents

Audit events SHALL record identifiers and metadata only. They SHALL NOT store OTP codes, session tokens, signed URLs, or document contents.

#### Scenario: OTP code is never persisted in the trail
- **WHEN** an OTP verification succeeds or fails
- **THEN** the resulting audit event contains no passcode value

#### Scenario: Document event stores a reference only
- **WHEN** a Document upload is audited
- **THEN** the event stores the Document identifier and metadata, not the file contents or a usable signed URL

