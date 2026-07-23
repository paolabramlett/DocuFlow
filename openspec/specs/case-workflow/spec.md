# case-workflow Specification

## Purpose
TBD - created by archiving change initial-multi-tenant-schema. Update Purpose after archive.
## Requirements
### Requirement: A Blueprint is a starting point owned by an Organization

A Blueprint SHALL belong to one Organization and SHALL define an ordered set of requirement definitions. A Blueprint SHALL NOT be a live template that governs Cases derived from it.

#### Scenario: Blueprint is organization scoped
- **WHEN** a Member of Organization A lists Blueprints
- **THEN** only Organization A Blueprints are returned

#### Scenario: Only Owners manage Blueprints
- **WHEN** a Member with role `staff` attempts to create or modify a Blueprint
- **THEN** the write is denied by policy

### Requirement: Cloning a Blueprint produces a fully independent Case

Creating a Case from a Blueprint SHALL copy the Blueprint's requirement definitions into new Requirement rows owned by the Case. The Case SHALL hold no live reference that allows later Blueprint changes to reach it.

#### Scenario: Clone copies requirements
- **GIVEN** a Blueprint with four requirement definitions
- **WHEN** a Case is created from it
- **THEN** the Case has four Requirement rows whose content matches the Blueprint at clone time

#### Scenario: Editing the blueprint does not alter existing cases
- **GIVEN** a Case cloned from Blueprint B
- **WHEN** B is edited, reordered, or has requirements added or deleted
- **THEN** the existing Case is byte-for-byte unchanged

#### Scenario: Deleting the blueprint does not affect existing cases
- **WHEN** Blueprint B is deleted
- **THEN** Cases previously cloned from B remain fully intact and operable

### Requirement: A Case may be created without a Blueprint

Case creation SHALL NOT require a Blueprint. An empty Case SHALL support the same requirement operations as a cloned one.

#### Scenario: Blank case is valid
- **WHEN** Staff creates a Case with no Blueprint selected
- **THEN** the Case is created with zero Requirements and accepts requirement additions

### Requirement: Requirements are mutable per Case

Each Case SHALL support adding, renaming, deleting, and reordering its own Requirements, without affecting any Blueprint or any other Case. A Requirement that has already been satisfied SHALL NOT be destructively re-edited: when a change would materially alter what the Requirement asks for, the satisfied Requirement SHALL be archived or cancelled and a new Requirement created in its place, so that the Document and Review history of the original remains intact and unambiguous.

#### Scenario: Requirement added to one case only
- **GIVEN** two Cases cloned from the same Blueprint
- **WHEN** a Requirement is added to the first Case
- **THEN** the second Case is unchanged and the Blueprint is unchanged

#### Scenario: Reordering persists
- **WHEN** Staff reorders the Requirements of a Case
- **THEN** the new order is persisted and returned on subsequent reads

#### Scenario: Deleting a requirement preserves the audit trail
- **WHEN** a Requirement holding an uploaded Document is deleted
- **THEN** the Requirement is no longer active on the Case and the audit events recording its history remain readable

#### Scenario: A satisfied requirement is superseded, not mutated
- **GIVEN** a satisfied Requirement asking for "national ID"
- **WHEN** Staff change what is asked to "passport"
- **THEN** the original Requirement is archived with its Document and Review history intact, and a new outstanding Requirement is created for "passport"

#### Scenario: A non-material edit to a satisfied requirement is still allowed
- **WHEN** Staff correct a typo in a satisfied Requirement's label without changing what is asked
- **THEN** the change is applied in place and no supersession occurs

### Requirement: Requirements carry a type discriminator

Every Requirement SHALL carry a `type` value constrained to a known set. Only `document` SHALL be implemented in this change; `text`, `date`, `confirmation`, `payment`, `signature`, and `form` SHALL be reachable additively without altering the Case or Requirement structure.

#### Scenario: Unknown type is rejected
- **WHEN** a Requirement is inserted with a type outside the constrained set
- **THEN** the database rejects the write with a check constraint violation

#### Scenario: Non-document types are not yet accepted
- **WHEN** a Requirement is inserted with a type that is defined but not implemented in this change
- **THEN** the write is refused with an explicit unsupported-type error rather than partial behavior

#### Scenario: Adding a future type requires no structural change
- **WHEN** a later change enables an additional requirement type
- **THEN** it is enabled by extending the constraint and adding type-specific handling, with no modification to Case or Requirement columns

### Requirement: Case state governs client interaction

A Case SHALL carry a lifecycle state. Completing a Case SHALL stop new client uploads while preserving all collected data.

#### Scenario: Completion stops uploads
- **GIVEN** a Case in progress with an active upload grant
- **WHEN** the Case is marked complete
- **THEN** subsequent client upload attempts are refused and existing Documents remain readable

#### Scenario: State transitions are audited
- **WHEN** a Case changes state
- **THEN** an audit event records the actor, the prior state, the new state, and the time

### Requirement: Case and requirement state changes emit notification events

A Document upload and the satisfaction of a Case's final outstanding requirement SHALL each emit a Staff notification, without altering the underlying Case or Requirement behaviour. Observing state for notification SHALL NOT change how state itself transitions.

#### Scenario: State transitions are unchanged by observation
- **WHEN** a requirement becomes satisfied
- **THEN** the requirement's own status behaviour is exactly as before, and a notification is emitted as a separate effect

#### Scenario: Notification emission does not block the state change
- **WHEN** a Document is uploaded
- **THEN** the upload succeeds whether or not a notification consumer is present

### Requirement: Requirements carry participant and stage assignment

A Requirement MAY be assigned to one Participant of its Case, or left unassigned (Case-level). A Requirement MAY belong to one Stage of its Case, or none. Both assignments SHALL be independent of the Requirement's type and position.

#### Scenario: Assigning a requirement to a participant scopes client access
- **WHEN** a Requirement is assigned to Participant A
- **THEN** only a Client granted on Participant A, and Staff, may see it

#### Scenario: Assignment respects the tenant boundary
- **WHEN** a Requirement is assigned to a Participant or Stage of another Case or Organization
- **THEN** the write is rejected

### Requirement: Cloning assigns cloned requirements to cloned stages

When a Case is created from a Blueprint, each cloned Requirement SHALL be placed in the Case Stage corresponding to its Blueprint Stage, and cloned Requirements SHALL start unassigned to any Participant unless the creation flow assigns them.

#### Scenario: Clone preserves stage placement
- **GIVEN** a Blueprint whose Requirements are spread across three Stages
- **WHEN** a Case is cloned from it
- **THEN** each cloned Requirement sits in the Case Stage matching its Blueprint Stage

