## ADDED Requirements

### Requirement: A Case has one or more Participants

A Case SHALL have at least one Participant. Each Participant SHALL reference exactly one Organization-owned Client and belong to exactly one Case within the same Organization.

#### Scenario: A case supports multiple participants
- **WHEN** a Case is set up for a transaction with a buyer and a seller
- **THEN** the Case has two Participants, each referencing a distinct Client

#### Scenario: A participant is tenant-consistent with its case
- **WHEN** a Participant is created referencing a Client and a Case from different Organizations
- **THEN** the database rejects the write

### Requirement: A Participant carries an editable role label

Each Participant SHALL carry a free-text role label (for example "buyer", "seller", "notary", "power of attorney"). The label is descriptive only and SHALL NOT drive authorization.

#### Scenario: Role label is editable
- **WHEN** Staff rename a Participant's role
- **THEN** the label updates and no access changes as a result

#### Scenario: Authorization does not depend on the label
- **GIVEN** two Participants with different role labels
- **WHEN** each holds an equivalent active grant
- **THEN** each has the same access to its own assigned Requirements regardless of label

### Requirement: A grant attaches to a Participant

A Case Access grant SHALL reference a Participant. Access derived from the grant SHALL apply to that Participant, not to the whole Case.

#### Scenario: The grant identifies a participant
- **WHEN** an invitation is issued for a party to a Case
- **THEN** the resulting grant references the Participant it was issued for

#### Scenario: Two participants of one case are granted independently
- **GIVEN** a Case with Participants A and B
- **WHEN** A's grant is revoked
- **THEN** B's grant remains active and unaffected

### Requirement: A Client identity sees only its Participant's assigned Requirements

A Client authenticated through an active grant SHALL view and act on only the Requirements assigned to the Participant that grant is for. It SHALL NOT see Requirements assigned to another Participant of the same Case.

#### Scenario: A participant cannot see another participant's requirements
- **GIVEN** a Case where Requirement R1 is assigned to Participant A and R2 to Participant B
- **WHEN** the Client granted on Participant A lists Requirements
- **THEN** R1 is returned and R2 is not

#### Scenario: A participant uploads only to its own requirements
- **WHEN** the Client granted on Participant A attempts to upload to R2 (Participant B's Requirement)
- **THEN** the write is denied by policy

#### Scenario: Case visibility follows from participant access
- **WHEN** a Client holds an active grant on a Participant of a Case
- **THEN** the Case itself is visible to that Client, scoped to its own Requirements

### Requirement: Unassigned Requirements are Case-level and Staff-managed

A Requirement MAY be left unassigned to any Participant. An unassigned Requirement SHALL be visible to and managed by Staff of the owning Organization, and SHALL NOT be visible to any Client in this change.

#### Scenario: Unassigned requirement is staff-only
- **GIVEN** a Requirement with no Participant assignment
- **WHEN** any Client granted on the Case lists Requirements
- **THEN** the unassigned Requirement is not returned

#### Scenario: Staff see and manage unassigned requirements
- **WHEN** a Member of the owning Organization lists a Case's Requirements
- **THEN** both assigned and unassigned Requirements are returned

### Requirement: One Client may be several Participants of the same Case

The same Client MAY appear as more than one Participant of a Case when the roles are genuinely distinct. There SHALL be no unique constraint on `(case_id, client_id)`. Uniqueness is on the Participant identity alone.

#### Scenario: One person holds two roles
- **WHEN** a person is both the buyer and the legal representative of a company in one transaction
- **THEN** two Participants may reference the same Client with different role labels, each with its own grant and assigned Requirements

#### Scenario: Accidental duplicates are not blocked by the database
- **WHEN** a second Participant is created for a Client that already participates
- **THEN** the write succeeds; detecting an accidental duplicate is an application concern, not a database constraint

### Requirement: A draft Case cannot act until it has a Participant with assigned work

A Case MAY exist with no Participants. In that state it SHALL NOT be able to issue invitations, activate follow-up reminders, or advance to a client-facing state, until it has at least one Participant with at least one assigned Requirement. There SHALL be no implicit or default Participant.

#### Scenario: A participant-less case cannot invite
- **GIVEN** a Case with no Participants
- **WHEN** an invitation is attempted
- **THEN** it is refused

#### Scenario: No hidden default participant is created
- **WHEN** a Case is created, with or without a Blueprint
- **THEN** no Participant exists until one is added explicitly

#### Scenario: A case becomes actionable once a participant has assigned work
- **GIVEN** a Case with one Participant and a Requirement assigned to it
- **WHEN** an invitation is issued for that Participant
- **THEN** it succeeds

### Requirement: Participants are tenant-isolated

`case_participants` SHALL be readable only by Members of the owning Organization and by the Client identity granted on that Participant. Cross-organization reads SHALL return nothing.

#### Scenario: Cross-organization participant read returns nothing
- **WHEN** a Member of one Organization reads a Participant of another
- **THEN** zero rows are returned

#### Scenario: A client reads only its own participant
- **GIVEN** a Case with Participants A and B
- **WHEN** the Client granted on A reads participants
- **THEN** only Participant A is returned
