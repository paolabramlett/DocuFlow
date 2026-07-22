## ADDED Requirements

### Requirement: Client records are owned by one Organization and endure across Cases

A Client SHALL be a durable record belonging to exactly one Organization, persisting independently of any Case. Client records SHALL NOT be shared, merged, or synchronized across Organizations.

#### Scenario: Client survives case completion
- **GIVEN** a Client with a completed Case
- **WHEN** the Case is completed and its access expires
- **THEN** the Client record remains and is available for a future Case in the same Organization

#### Scenario: Same person in two organizations has two records
- **GIVEN** the same human is served by Organization A and Organization B
- **WHEN** each Organization creates a Client for that person
- **THEN** two independent Client rows exist, neither referencing the other

### Requirement: Clients link to a persistent passwordless authentication identity

A Client SHALL carry a nullable reference to `auth.users(id)`. On first successful email verification the system SHALL create the auth user if absent, or reuse the existing auth user for that verified email, and bind it to the Client record.

#### Scenario: First verification creates the identity
- **GIVEN** a Client whose email has never been verified on the platform
- **WHEN** the Client completes email verification
- **THEN** an auth user is created for that email and bound to the Client record

#### Scenario: Returning person reuses the identity
- **GIVEN** an auth user already exists for a verified email
- **WHEN** a different Organization verifies a Client with that same email
- **THEN** the existing auth user is reused and bound to the new Client record

#### Scenario: Unverified client has no identity
- **WHEN** a Client is created by Staff but has not yet verified their email
- **THEN** the auth identity reference is null and no access is possible

### Requirement: Authorization never derives from identity or email

Access SHALL be determined solely by an active Case Access grant. Holding an authentication session, matching an email address, or sharing an auth identity SHALL NOT by itself confer access to any Case or Organization data.

#### Scenario: Authenticated user without a grant sees nothing
- **GIVEN** an authenticated user with no Case Access grant
- **WHEN** the user queries cases, requirements, or documents
- **THEN** zero rows are returned

#### Scenario: Matching email does not grant access
- **GIVEN** a Case whose invited Client email equals the authenticated user's email
- **WHEN** no active grant exists for that user and Case
- **THEN** access is denied

### Requirement: One identity may hold access across multiple Organizations without data crossing

A single auth identity MAY hold grants to Cases in multiple Organizations. Each grant SHALL be evaluated independently, and no Organization SHALL observe the identity's relationships elsewhere.

#### Scenario: Grants in two organizations remain independent
- **GIVEN** auth identity U holds an active grant in Organization A and Organization B
- **WHEN** U accesses the Case in Organization A
- **THEN** only that Case is visible, and no Organization B row or reference is returned

#### Scenario: Revocation in one organization does not affect the other
- **WHEN** Organization A revokes U's grant
- **THEN** U's grant in Organization B remains active and unchanged

### Requirement: Cross-organization presence is confidential

No Organization SHALL be able to determine, through query, error message, timing, or uniqueness conflict, that a person is also a Client of another Organization.

#### Scenario: Client email is unique per organization, not globally
- **GIVEN** Organization A already has a Client with email E
- **WHEN** Organization B creates a Client with email E
- **THEN** the write succeeds without conflict or warning

#### Scenario: Auth identity linkage is not readable across tenants
- **WHEN** a Member of Organization A reads a Client row in their own Organization
- **THEN** no field reveals grants, Clients, or Organizations belonging to any other tenant
