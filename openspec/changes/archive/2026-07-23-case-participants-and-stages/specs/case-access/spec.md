## MODIFIED Requirements

### Requirement: Case Access is an explicit grant scoped to exactly one Case

A Case Access grant SHALL reference one Participant, and through it one Client and one Case within the Case's Organization. A grant SHALL confer access to that Participant's assigned Requirements within that Case alone, and SHALL NOT extend to another Participant of the same Case, nor to sibling Cases of the same Client.

#### Scenario: Grant does not extend to a second case
- **GIVEN** Client C holds an active grant on a Participant of Case 1 and no grant in Case 2 of the same Organization
- **WHEN** C requests Case 2
- **THEN** zero rows are returned

#### Scenario: Grant does not extend to another participant of the same case
- **GIVEN** a Case with Participants A and B, and Client C granted on A
- **WHEN** C requests Requirements assigned to B
- **THEN** zero rows are returned

#### Scenario: Grant is bound to the authenticated identity
- **WHEN** a grant is activated
- **THEN** it stores the verified `auth.users(id)`, and policy evaluation matches on that id rather than on the email address

## ADDED Requirements

### Requirement: Active-grant resolution has a Participant dimension

The system SHALL resolve which Participants a caller holds an active grant on, using the same activity definition as case-level resolution (verified, not revoked, not expired, permission at or above the requested level). Requirement-level access SHALL be decided by Participant, and Case-level visibility SHALL follow from holding an active grant on any Participant of the Case.

#### Scenario: A participant resolver drives requirement access
- **GIVEN** Client C with an active grant on Participant A
- **WHEN** C reads Requirements
- **THEN** exactly the non-deleted Requirements assigned to Participant A are returned

#### Scenario: Expiry and revocation apply per participant
- **GIVEN** Client C granted on Participant A with an expired grant
- **WHEN** C reads Requirements assigned to A
- **THEN** zero rows are returned
