## MODIFIED Requirements

### Requirement: Clients may upload only to their granted Case with upload permission

A Document upload SHALL be accepted only when the caller holds an active grant, with permission `upload`, on the Participant to which the target Requirement is assigned, or is a Member of the owning Organization. A Client SHALL NOT upload to a Requirement assigned to another Participant, nor to an unassigned Case-level Requirement.

#### Scenario: Client uploads to a granted requirement
- **GIVEN** a Client with an active `upload` grant on Participant A, and Requirement R1 assigned to A
- **WHEN** the Client uploads a file to R1
- **THEN** the Document row is created and linked to R1

#### Scenario: Client cannot upload to another case
- **WHEN** a Client attempts to upload to a Requirement of a Case whose Participants they hold no grant on
- **THEN** the write is denied by policy

#### Scenario: Client cannot upload to another participant's requirement
- **GIVEN** a Client granted on Participant A, and Requirement R2 assigned to Participant B
- **WHEN** the Client attempts to upload to R2
- **THEN** the write is denied by policy

#### Scenario: Client cannot upload to an unassigned requirement
- **GIVEN** a Client granted on Participant A, and Requirement R3 assigned to no Participant
- **WHEN** the Client attempts to upload to R3
- **THEN** the write is denied by policy

#### Scenario: View-only client cannot upload
- **GIVEN** an active grant with permission `view`
- **WHEN** the Client attempts an upload
- **THEN** the write is denied by policy
