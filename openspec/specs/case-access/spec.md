# case-access Specification

## Purpose
TBD - created by archiving change initial-multi-tenant-schema. Update Purpose after archive.
## Requirements
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

### Requirement: An invitation URL conveys context but never access

The invitation URL SHALL identify the intended Case context only. Possession, forwarding, or interception of the URL SHALL NOT grant any access to Case data.

#### Scenario: Forwarded invitation grants nothing
- **GIVEN** an invitation URL for a Case is forwarded to an unintended recipient
- **WHEN** that recipient opens the URL without completing verification for the invited email
- **THEN** no Case data is returned and no grant becomes active

#### Scenario: Opening the invitation reveals no case content
- **WHEN** an unauthenticated visitor opens a valid invitation URL
- **THEN** the response contains no client names, requirement details, or document data

### Requirement: Access is activated by email OTP verification

A grant SHALL become active only after the invited email address is verified via a one-time passcode delivered to that address. The system SHALL prefer OTP codes over access-granting clickable links.

#### Scenario: Correct OTP activates the grant
- **GIVEN** a pending grant for invited email E
- **WHEN** the visitor submits the valid, unexpired OTP sent to E
- **THEN** the grant becomes active and is bound to the auth identity for E

#### Scenario: Incorrect or expired OTP does not activate
- **WHEN** the submitted OTP is wrong, already used, or past its validity window
- **THEN** the grant remains pending and no access is conferred

#### Scenario: OTP is rate limited
- **WHEN** repeated OTP submissions fail for the same grant beyond the configured threshold
- **THEN** further attempts are refused for a cooldown period and the failures are recorded as audit events

### Requirement: Permission level is held independently of grant state

A grant SHALL carry a permission level of `upload`, `view`, or `none`, stored separately from its lifecycle state. Permission SHALL be evaluated in addition to, not instead of, grant activity.

#### Scenario: View permission blocks upload
- **GIVEN** an active grant with permission `view`
- **WHEN** the Client attempts to upload a document
- **THEN** the write is denied by policy and existing documents remain readable

#### Scenario: None permission blocks all case data
- **GIVEN** an active grant with permission `none`
- **WHEN** the Client requests the Case
- **THEN** zero rows are returned

#### Scenario: Expired grant denies regardless of permission
- **GIVEN** a grant with permission `upload` whose expiry has passed
- **WHEN** the Client attempts any read or write
- **THEN** access is denied

### Requirement: Grants expire on a rolling, renewable TTL

A grant SHALL carry an expiry timestamp defaulting to 90 days from activation. Activity SHALL be able to extend the expiry within policy, and Staff SHALL be able to reissue access after expiry without creating a duplicate Client.

#### Scenario: Default expiry is set on activation
- **WHEN** a grant is activated
- **THEN** its expiry is set to the configured default of 90 days ahead

#### Scenario: Reissue after expiry reuses the client
- **GIVEN** an expired grant for Client C
- **WHEN** Staff reissues access for the same Case
- **THEN** a grant is activated for the existing Client C and no duplicate Client is created

### Requirement: Case completion downgrades access to view for a configurable window

When a Case is completed, its active grants SHALL be downgraded to permission `view` for a configurable retention window. After that window, expiry or retention policy SHALL close access.

#### Scenario: Completion downgrades upload to view
- **GIVEN** an active grant with permission `upload` on an open Case
- **WHEN** the Case is marked complete
- **THEN** the grant permission becomes `view` and uploads are refused while reads still succeed

#### Scenario: Retention window closes access
- **GIVEN** a completed Case whose retention window has elapsed
- **WHEN** the Client requests the Case
- **THEN** access is denied

### Requirement: Staff may revoke a grant at any time with immediate effect

Revocation SHALL take effect on the next request without waiting for expiry, session end, or token refresh.

#### Scenario: Revocation ends access immediately
- **GIVEN** a Client with an active session and an active grant
- **WHEN** Staff revokes the grant
- **THEN** the Client's next request returns zero rows

#### Scenario: Revocation is audited
- **WHEN** a grant is revoked
- **THEN** an audit event records the actor, the grant, the Case, and the time

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

