# organization-tenancy Specification

## Purpose
TBD - created by archiving change initial-multi-tenant-schema. Update Purpose after archive.
## Requirements
### Requirement: Every business entity belongs to an Organization

Every table holding business data SHALL carry a non-null `organization_id` referencing `organizations(id)`, either directly or through an ancestor that does. No business row may exist without a resolvable owning Organization.

#### Scenario: Insert without organization is rejected
- **WHEN** any insert into a business table omits `organization_id` or supplies null
- **THEN** the database rejects the write with a not-null violation

#### Scenario: Organization reference must resolve
- **WHEN** an insert supplies an `organization_id` that does not exist in `organizations`
- **THEN** the database rejects the write with a foreign key violation

### Requirement: Row Level Security is enabled on every exposed table

Every table reachable through the API SHALL have RLS enabled and at least one policy. Authorization SHALL be enforced by database policy, never by application-side filtering alone.

#### Scenario: No table ships without RLS
- **WHEN** the schema is inspected for tables in the exposed schema
- **THEN** every such table reports `rowsecurity = true` and has one or more policies

#### Scenario: Application queries cannot bypass isolation
- **WHEN** a query omits any organization filter in application code
- **THEN** the database still returns only rows belonging to the caller's Organization

### Requirement: Members belong to exactly one Organization with a role

A Member SHALL link an authenticated user to one Organization with role `owner` or `staff`. The same authenticated user MAY hold Member rows in multiple Organizations; each is independent and confers no access to the others.

#### Scenario: Role is constrained
- **WHEN** a Member is inserted with a role outside `owner` or `staff`
- **THEN** the database rejects the write with a check constraint violation

#### Scenario: Multi-organization membership stays isolated
- **GIVEN** user U is a Member of Organization A and Organization B
- **WHEN** U queries cases while acting in the context of Organization A
- **THEN** only Organization A cases are returned, and no Organization B row is visible

### Requirement: Cross-organization access is denied for reads, writes, and existence

A Member of one Organization SHALL NOT read, modify, or delete rows belonging to another Organization, and SHALL NOT be able to infer that a given row exists. Denials SHALL be indistinguishable from absence.

#### Scenario: Cross-organization read returns nothing
- **GIVEN** Organization A and Organization B each own cases
- **WHEN** a Member of Organization A selects a case belonging to Organization B by its id
- **THEN** zero rows are returned

#### Scenario: Cross-organization write is rejected
- **WHEN** a Member of Organization A attempts to update or delete a row belonging to Organization B
- **THEN** the write affects zero rows and no data changes

#### Scenario: Existence is not disclosed
- **WHEN** a Member of Organization A requests a row belonging to Organization B by a known id
- **THEN** the response is identical to a request for an id that does not exist anywhere

### Requirement: Only Owners manage the Organization and its membership

Members with role `owner` SHALL manage Organization settings, Members, and Blueprints. Members with role `staff` SHALL NOT modify Organization settings or membership.

#### Scenario: Staff cannot add a member
- **WHEN** a Member with role `staff` attempts to insert a Member row
- **THEN** the write is denied by policy

#### Scenario: Owner manages membership
- **WHEN** a Member with role `owner` inserts or removes a Member in their own Organization
- **THEN** the write succeeds and an audit event is recorded

#### Scenario: Owner cannot reach another organization
- **WHEN** a Member with role `owner` in Organization A attempts to add a Member to Organization B
- **THEN** the write is denied by policy

### Requirement: Organization industry selection affects presentation only

An Organization SHALL record an industry selected during onboarding. Industry SHALL determine default terminology, starter Blueprints, contextual help, and examples, and SHALL NOT alter schema, policies, or engine behavior.

#### Scenario: Industry does not branch the engine
- **GIVEN** two Organizations with different industry values
- **WHEN** each performs the same case operation
- **THEN** the resulting rows and enforced policies are structurally identical

### Requirement: Organizations carry reminder cadence configuration

An Organization SHALL carry reminder cadence policy alongside its existing configuration: the delay before the first reminder, the interval between reminders, and the maximum number of reminders. These SHALL be constrained to sane ranges and SHALL default without requiring input during onboarding.

These fields are configuration, not access paths. They SHALL NOT change the tenant isolation model or grant any new read or write reach across Organizations.

#### Scenario: Cadence columns default on creation
- **WHEN** an Organization is created
- **THEN** it carries a default first-delay, interval, and maximum reminder count

#### Scenario: Cadence values are range-constrained
- **WHEN** a cadence value outside its allowed range is written
- **THEN** the database rejects it with a check constraint violation

#### Scenario: Cadence configuration does not widen access
- **GIVEN** two Organizations
- **WHEN** one reads the other's cadence configuration
- **THEN** zero rows are returned, exactly as for any other field

