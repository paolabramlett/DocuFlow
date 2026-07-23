## MODIFIED Requirements

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

## ADDED Requirements

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
